import { fetchShopifyOrders, getYesterday } from './shopify.js';
import { fetchMetaAds, fetchAdAccountInfo } from './meta.js';
import { hoursSinceDayClose } from './freshness.js';
import { generateDiagnosis } from './claude.js';
import { sendToSlack, formatReport } from './slack.js';
import {
  STORE_NAME, META_ACCESS_TOKEN, SHOPIFY_ACCESS_TOKEN,
  SLACK_WEBHOOK_URL, SUBSCRIPTION_TAGS,
  META_ACCOUNT_TIMEZONE, MIN_HOURS_AFTER_CLOSE, META_AD_ACCOUNTS,
} from './config.js';

async function fetchExchangeRates() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/EUR');
    const json = await res.json();
    return {
      mxn: json.rates?.MXN || 19.97,
      usd: json.rates?.USD || 1.08,
    };
  } catch {
    console.warn('[FX] Could not fetch live exchange rates, using fallback');
    return { mxn: 19.97, usd: 1.08 };
  }
}

// Meta sigue agregando gasto durante horas despues de que cierra el dia en la
// timezone de la cuenta. Publicar antes de tiempo subestima el spend, lo que
// infla ROAS y MER. Preferimos no publicar a publicar cifras incorrectas.
// Con varias cuentas manda la que cerro mas tarde: el total solo esta
// consolidado cuando lo esta la cuenta mas lenta.
async function assertMetaDataIsSettled(reportDate, accountInfos) {
  const checks = META_AD_ACCOUNTS.map((account, i) => {
    const timeZone = accountInfos[i]?.timeZone || META_ACCOUNT_TIMEZONE;
    const hours = hoursSinceDayClose(reportDate, timeZone);
    console.log(
      `[Freshness] ${account.label}: ${reportDate} cerro hace ${hours.toFixed(2)} h en ${timeZone}`
    );
    return { account, timeZone, hours };
  });

  const slowest = checks.reduce((a, b) => (b.hours < a.hours ? b : a));
  const { timeZone, hours } = slowest;
  console.log(
    `[Freshness] Minimo: ${hours.toFixed(2)} h (${slowest.account.label}) — ` +
    `requerido: ${MIN_HOURS_AFTER_CLOSE} h`
  );

  if (hours >= MIN_HOURS_AFTER_CLOSE) return { timeZone, hours };

  const who = checks.length > 1 ? ` (cuenta ${slowest.account.label})` : '';
  const reason = hours < 0
    ? `el dia todavia no termina en ${timeZone}${who} (faltan ${(-hours).toFixed(1)} h)`
    : `solo han pasado ${hours.toFixed(1)} h desde el cierre${who}, el minimo es ${MIN_HOURS_AFTER_CLOSE} h`;

  console.error(`Datos de Meta sin consolidar: ${reason}`);
  await sendToSlack(SLACK_WEBHOOK_URL,
    `:hourglass_flowing_sand: *${STORE_NAME} — Reporte Diario NO publicado*\n${reportDate}\n\n` +
    `Meta aun no consolida el gasto: ${reason}.\n` +
    `No se publica el reporte para no dar cifras incorrectas ` +
    `(un gasto subestimado infla ROAS y MER).`
  );
  process.exit(1);
}

// Sumar gasto de cuentas en monedas distintas da un total inventado. Si una
// cuenta no se pudo leer solo avisamos: la moneda de una cuenta de Meta no se
// puede cambiar, asi que una vez verificada no hay riesgo real.
async function assertSameCurrency(reportDate, accountInfos) {
  if (META_AD_ACCOUNTS.length < 2) return;

  const known = META_AD_ACCOUNTS
    .map((account, i) => ({ account, currency: accountInfos[i]?.currency }))
    .filter(a => a.currency);
  if (known.length < META_AD_ACCOUNTS.length) {
    console.warn('[Currency] No se pudo leer la moneda de todas las cuentas — se asume la misma');
  }

  const currencies = new Set(known.map(a => a.currency));
  console.log(`[Currency] ${known.map(a => `${a.account.label}: ${a.currency}`).join(', ')}`);
  if (currencies.size <= 1) return;

  const detail = known.map(a => `${a.account.label} = ${a.currency}`).join(', ');
  console.error(`Cuentas de Meta en monedas distintas: ${detail}`);
  await sendToSlack(SLACK_WEBHOOK_URL,
    `:warning: *${STORE_NAME} — Reporte Diario NO publicado*\n${reportDate}\n\n` +
    `Las cuentas de Meta estan en monedas distintas (${detail}).\n` +
    `No se publica el reporte porque sumar el gasto daria un total incorrecto.`
  );
  process.exit(1);
}

async function run() {
  const yesterday = getYesterday();
  const accountInfos = await Promise.all(
    META_AD_ACCOUNTS.map(a => fetchAdAccountInfo(META_ACCESS_TOKEN, a.id))
  );
  await assertSameCurrency(yesterday, accountInfos);
  const { hours: hoursSettled } = await assertMetaDataIsSettled(yesterday, accountInfos);
  let metaData, shopifyData;

  // Si falla una sola cuenta falla todo: un total parcial publicado como si
  // fuera completo es peor que no publicar.
  try {
    let metaByAccount;
    [metaByAccount, shopifyData] = await Promise.all([
      Promise.all(META_AD_ACCOUNTS.map(a => fetchMetaAds(META_ACCESS_TOKEN, yesterday, a))),
      fetchShopifyOrders(SHOPIFY_ACCESS_TOKEN),
    ]);
    metaData = metaByAccount.flat();
  } catch (err) {
    console.error('API fetch failed:', err.message);
    await sendToSlack(SLACK_WEBHOOK_URL,
      `:warning: *${STORE_NAME} — Reporte Diario FALLIDO*\nNo se pudieron obtener datos.\nError: ${err.message}`
    );
    process.exit(1);
  }

  console.log(`[Debug] Yesterday: ${yesterday}`);
  console.log(`[Debug] Meta rows: ${metaData.length}, Shopify rows: ${shopifyData.length}`);

  if (metaData.length === 0 && shopifyData.length === 0) {
    console.warn('Both APIs returned 0 rows — sending warning to Slack');
    await sendToSlack(SLACK_WEBHOOK_URL,
      `:warning: *${STORE_NAME} — Reporte Diario*\n${yesterday}\n\nNo se obtuvieron datos de Meta ni de Shopify. Verifica que los tokens de acceso siguen activos.`
    );
    process.exit(1);
  }

  const { mxn: eurToMxn, usd: eurToUsd } = await fetchExchangeRates();
  console.log(`[FX] EUR→MXN rate: ${eurToMxn}, EUR→USD rate: ${eurToUsd}`);
  const metrics = calculateMetrics(metaData, shopifyData, eurToMxn);
  const adSpendUSD = metrics.adSpend * eurToUsd;

  const subDebug = metrics.subscriptionCounts.map(s => `${s.label}: ${s.count}`).join(', ');
  console.log(`[Debug] Orders: ${metrics.shopifyOrders}, Net Sales: ${metrics.shopifyRevenue.toFixed(2)}${subDebug ? `, ${subDebug}` : ''}`);

  let diagnosis;
  try {
    diagnosis = await generateDiagnosis(metrics, eurToMxn);
  } catch (err) {
    console.error('Claude diagnosis failed:', err.message, err.status ?? '', err.error ?? '');
    diagnosis = 'Diagnostico no disponible — error al generar analisis.';
  }

  const reportText = formatReport({
    date: yesterday,
    metrics,
    diagnosis,
    eurToMxn,
    adSpendUSD,
    hoursSettled,
  });

  try {
    await sendToSlack(SLACK_WEBHOOK_URL, reportText);
    console.log('Report sent to Slack successfully.');
  } catch (err) {
    console.error('Failed to send to Slack:', err.message);
    process.exit(1);
  }
}

function sum(rows, field) {
  return rows.reduce((acc, row) => acc + (Number(row[field]) || 0), 0);
}

function hasTag(row, tag) {
  const tags = row.order_tags || '';
  return tags.includes(tag);
}

// Shopify liquida en MXN y las cuentas de Meta gastan en EUR: el revenue se
// pasa a EUR antes de dividir, o el MER sale inflado por el tipo de cambio.
function calculateMetrics(metaRows, shopifyRows, eurToMxn) {
  const adSpend = sum(metaRows, 'spend');
  const impressions = sum(metaRows, 'impressions');
  const clicks = sum(metaRows, 'clicks');
  const linkClicks = sum(metaRows, 'actions_link_click');
  const addToCarts = sum(metaRows, 'actions_offsite_conversion_fb_pixel_add_to_cart');
  const checkoutsInitiated = sum(metaRows, 'actions_offsite_conversion_fb_pixel_initiate_checkout');
  const metaOrders = sum(metaRows, 'actions_offsite_conversion_fb_pixel_purchase');
  const metaAttributedRevenue = sum(metaRows, 'action_values_offsite_conversion_fb_pixel_purchase');

  const metaROAS = adSpend > 0 ? metaAttributedRevenue / adSpend : 0;
  const cpo = metaOrders > 0 ? adSpend / metaOrders : 0;
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
  const addToCartRate = linkClicks > 0 ? (addToCarts / linkClicks) * 100 : 0;
  const checkoutRate = addToCarts > 0 ? (checkoutsInitiated / addToCarts) * 100 : 0;
  const purchaseRate = checkoutsInitiated > 0 ? (metaOrders / checkoutsInitiated) * 100 : 0;

  const shopifyRevenue = sum(shopifyRows, 'order_net_sales');
  const shopifyOrders = sum(shopifyRows, 'order_count');
  const shopifyAOV = shopifyOrders > 0 ? shopifyRevenue / shopifyOrders : 0;
  const merROAS = adSpend > 0 ? (shopifyRevenue / eurToMxn) / adSpend : 0;

  const orderRows = shopifyRows.filter(r => Number(r.order_count) > 0);
  const subscriptionCounts = SUBSCRIPTION_TAGS.map(({ tag, label }) => ({
    label,
    count: orderRows.filter(r => hasTag(r, tag)).length,
  }));

  // Desglose por cuenta, en el orden de META_AD_ACCOUNTS. Una cuenta sin gasto
  // ese dia no devuelve filas y sale en cero.
  const byAccount = META_AD_ACCOUNTS.map(({ label }) => {
    const rows = metaRows.filter(r => r.account === label);
    const spend = sum(rows, 'spend');
    const attributed = sum(rows, 'action_values_offsite_conversion_fb_pixel_purchase');
    return {
      label,
      spend,
      metaOrders: sum(rows, 'actions_offsite_conversion_fb_pixel_purchase'),
      metaROAS: spend > 0 ? attributed / spend : 0,
    };
  });

  return {
    adSpend, impressions, clicks, linkClicks, addToCarts,
    checkoutsInitiated, metaOrders, metaAttributedRevenue,
    metaROAS, cpo, ctr, addToCartRate, checkoutRate, purchaseRate,
    shopifyRevenue, shopifyOrders, shopifyAOV, merROAS,
    subscriptionCounts, byAccount,
  };
}

run();
