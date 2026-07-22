import { fetchShopifyOrders, getYesterday } from './shopify.js';
import { fetchMetaAds } from './meta.js';
import { generateDiagnosis } from './claude.js';
import { sendToSlack, formatReport } from './slack.js';
import {
  STORE_NAME, META_ACCESS_TOKEN, SHOPIFY_ACCESS_TOKEN,
  SLACK_WEBHOOK_URL, SUBSCRIPTION_TAGS,
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

async function run() {
  const yesterday = getYesterday();
  let metaData, shopifyData;

  try {
    [metaData, shopifyData] = await Promise.all([
      fetchMetaAds(META_ACCESS_TOKEN, yesterday),
      fetchShopifyOrders(SHOPIFY_ACCESS_TOKEN),
    ]);
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

  const metrics = calculateMetrics(metaData, shopifyData);
  const { mxn: eurToMxn, usd: eurToUsd } = await fetchExchangeRates();
  console.log(`[FX] EUR→MXN rate: ${eurToMxn}, EUR→USD rate: ${eurToUsd}`);
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

function calculateMetrics(metaRows, shopifyRows) {
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
  const merROAS = adSpend > 0 ? shopifyRevenue / adSpend : 0;

  const orderRows = shopifyRows.filter(r => Number(r.order_count) > 0);
  const subscriptionCounts = SUBSCRIPTION_TAGS.map(({ tag, label }) => ({
    label,
    count: orderRows.filter(r => hasTag(r, tag)).length,
  }));

  return {
    adSpend, impressions, clicks, linkClicks, addToCarts,
    checkoutsInitiated, metaOrders, metaAttributedRevenue,
    metaROAS, cpo, ctr, addToCartRate, checkoutRate, purchaseRate,
    shopifyRevenue, shopifyOrders, shopifyAOV, merROAS,
    subscriptionCounts,
  };
}

run();
