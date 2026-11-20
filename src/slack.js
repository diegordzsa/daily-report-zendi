import { STORE_NAME, STORE_LOCALE, REPORT_TIME_LABEL, SUBSCRIPTION_TAGS } from './config.js';

export async function sendToSlack(webhookUrl, reportText) {
  // Modo ensayo: el reporte se imprime en el log y no se manda al canal, para
  // probar cambios sin publicar un reporte duplicado.
  if (process.env.DRY_RUN === 'true') {
    console.log('\n===== DRY RUN — mensaje que se enviaria a Slack =====\n');
    console.log(reportText);
    console.log('\n===== FIN DRY RUN =====\n');
    return;
  }
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: reportText },
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Slack webhook error: ${res.status} ${res.statusText}`);
  }
}

function buildSubscriptionLine(metrics) {
  if (SUBSCRIPTION_TAGS.length === 0 || !metrics.subscriptionCounts) return null;
  const parts = metrics.subscriptionCounts.map(s => `${s.label}: ${s.count}`);
  return `  ${parts.join(' | ')}`;
}

// Seccion propia por cuenta de Meta, para que el gasto y ROAS de cada una se
// lean de un vistazo. Con una sola cuenta repetiria el total y se omite.
function buildAccountSection(metrics, eur) {
  if (!metrics.byAccount || metrics.byAccount.length < 2) return [];
  const lines = [``, `:dart: *GASTO Y ROAS POR CUENTA*`];
  for (const a of metrics.byAccount) {
    lines.push(
      `  *${a.label}*`,
      `    Gasto: *${eur(a.spend)}* | ROAS: *${a.metaROAS.toFixed(2)}x*`,
      `    Compras: ${a.metaOrders} | CPO: ${eur(a.cpo)}`,
    );
  }
  return lines;
}

// Embudo de la tienda (todas las sesiones, no solo trafico de Meta), con las
// mismas tasas que Shopify Analytics. Si no se pudo leer se avisa en vez de
// omitirlo, para que no parezca que desaparecio sin razon.
function buildStoreFunnelSection(funnel) {
  const lines = [``, `:shopping_trolley: *CONVERSION TIENDA (Shopify)*`];
  if (!funnel) {
    lines.push(`  _No disponible — revisar scope read_reports del token de Shopify_`);
    return lines;
  }
  lines.push(
    `  Sesiones: ${fmtInt(funnel.sessions)}`,
    `  Añadido al carrito: *${funnel.addToCartRate.toFixed(2)}%* (${fmtInt(funnel.cartSessions)})`,
    `  Llegaron al checkout: *${funnel.reachedCheckoutRate.toFixed(2)}%* (${fmtInt(funnel.checkoutSessions)})`,
    `  Conversion: *${funnel.conversionRate.toFixed(2)}%* (${fmtInt(funnel.convertedSessions)})`,
  );
  return lines;
}

// Primera compra: lo que el gasto del dia realmente trajo, sin las renovaciones
// de suscripcion (que llegan solas) y medido con Shopify, no con la atribucion
// de Meta (que con varias cuentas y view-through cuenta de mas).
function buildFirstPurchaseSection(metrics, eur, fromMxn) {
  const { firstPurchase, newCustomers, cac } = metrics;
  if (!firstPurchase && newCustomers === undefined) return [];
  const lines = [``, `:sparkles: *PRIMERA COMPRA (Shopify, sin recurrentes)*`];
  if (firstPurchase) {
    lines.push(
      `  Ventas: ${fromMxn(firstPurchase.revenue)} ($${fmt(firstPurchase.revenue)} MXN) | Ordenes: ${firstPurchase.orders}`,
      `  MER primera compra: *${firstPurchase.mer.toFixed(2)}x*`,
    );
  }
  if (newCustomers === null) {
    lines.push(`  Clientes nuevos: _no disponible — revisar scope read_reports_`);
  } else {
    lines.push(`  Clientes nuevos: ${newCustomers} | CAC: *${cac === null ? '—' : eur(cac)}*`);
  }
  return lines;
}

export function formatReport({ date, metrics, diagnosis, eurToMxn, adSpendUSD, hoursSettled }) {
  const d = new Date(date);
  const dateStr = d.toLocaleDateString(STORE_LOCALE, {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  const eur = (n) => `€${fmt(n)}`;
  const fromMxn = (n) => `€${fmt(n / eurToMxn)}`;

  const subscriptionLine = buildSubscriptionLine(metrics);

  const lines = [
    `:bar_chart: *${STORE_NAME} — Reporte Diario*`,
    dateStr,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `:moneybag: *REVENUE (Shopify)*`,
    `  Net Sales: ${fromMxn(metrics.shopifyRevenue)} ($${fmt(metrics.shopifyRevenue)} MXN)`,
    `  Ordenes: ${metrics.shopifyOrders} | AOV: ${fromMxn(metrics.shopifyAOV)} ($${fmt(metrics.shopifyAOV)} MXN)`,
  ];

  if (subscriptionLine) {
    lines.push(subscriptionLine);
  }

  lines.push(
    ``,
    `:loudspeaker: *PAID ADS (Meta)${metrics.byAccount?.length > 1 ? ' — Total cuentas' : ''}*`,
    `  Gasto: ${eur(metrics.adSpend)}${adSpendUSD ? ` ($${fmt(adSpendUSD)} USD)` : ''}`,
    `  ROAS: ${metrics.metaROAS.toFixed(2)}x | MER-ROAS: ${metrics.merROAS.toFixed(2)}x | CPO: ${eur(metrics.cpo)}`,
    `  Revenue atribuido: ${eur(metrics.metaAttributedRevenue)}`,
    ...buildFirstPurchaseSection(metrics, eur, fromMxn),
    ...buildAccountSection(metrics, eur),
    ...buildStoreFunnelSection(metrics.shopifyFunnel),
    ``,
    `:mag: *FUNNEL (Meta)*`,
    `  Impresiones: ${fmtInt(metrics.impressions)}`,
    `  Link Clicks: ${fmtInt(metrics.linkClicks)} (CTR: ${metrics.ctr.toFixed(1)}%)`,
    `  Add to Cart: ${metrics.addToCarts} (${metrics.addToCartRate.toFixed(1)}%)`,
    `  Checkout: ${metrics.checkoutsInitiated} (${metrics.checkoutRate.toFixed(1)}%)`,
    `  Compras: ${metrics.metaOrders} (${metrics.purchaseRate.toFixed(1)}%)`,
    ``,
    `:robot_face: *DIAGNOSTICO (Claude)*`,
    ...diagnosis.split('\n').map(line => `  ${line}`),
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `_Generado automaticamente a las ${REPORT_TIME_LABEL}` +
      `${Number.isFinite(hoursSettled) ? ` · Meta: ${hoursSettled.toFixed(1)} h desde el cierre del dia` : ''}_`,
  );

  // Mensaje de prueba: se publica en el canal real pero marcado, para que nadie
  // lo tome por el reporte oficial del dia.
  if (process.env.REPORT_IS_TEST === 'true') {
    lines.unshift(
      `:test_tube: *MENSAJE DE PRUEBA — nuevo formato pendiente de aprobacion. No es el reporte oficial.*`,
      ``,
    );
  }

  return lines.join('\n');
}

function fmt(n) {
  return n.toLocaleString(STORE_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtInt(n) {
  return n.toLocaleString(STORE_LOCALE);
}
