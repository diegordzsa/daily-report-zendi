import Anthropic from '@anthropic-ai/sdk';
import { STORE_NAME, STORE_INDUSTRY, ROAS_BENCHMARK, CLAUDE_MODEL, SUBSCRIPTION_TAGS } from './config.js';

function buildSubscriptionLines(metrics) {
  if (SUBSCRIPTION_TAGS.length === 0 || !metrics.subscriptionCounts) return '';
  return metrics.subscriptionCounts
    .map(s => `- ${s.label}: ${s.count}`)
    .join('\n');
}

function buildRoasInstruction() {
  if (STORE_INDUSTRY && ROAS_BENCHMARK) {
    return `2. Compara el ROAS Meta vs MER-ROAS — si hay discrepancia grande, que significa. Evalua si el MER-ROAS es bueno para un DTC de ${STORE_INDUSTRY} (benchmark: ${ROAS_BENCHMARK})`;
  }
  return '2. Compara el ROAS Meta vs MER-ROAS — si hay discrepancia grande, que significa. Evalua si el MER-ROAS es bueno para ecommerce DTC';
}

function buildAccountLines(metrics) {
  if (!metrics.byAccount || metrics.byAccount.length < 2) return '';
  const lines = metrics.byAccount
    .map(a => `- ${a.label}: gasto €${a.spend.toFixed(2)}, ROAS ${a.metaROAS.toFixed(2)}x, ${a.metaOrders} compras`)
    .join('\n');
  return `\n\nDESGLOSE POR CUENTA DE META (las cifras de arriba son la suma):\n${lines}`;
}

function buildStoreFunnelLines(metrics) {
  const f = metrics.shopifyFunnel;
  if (!f) return '';
  return `

EMBUDO DE LA TIENDA (Shopify Analytics, todas las sesiones):
- Sesiones: ${f.sessions}
- Tasa de añadido al carrito: ${f.addToCartRate.toFixed(2)}%
- Tasa de llegada al checkout: ${f.reachedCheckoutRate.toFixed(2)}%
- Tasa de conversion: ${f.conversionRate.toFixed(2)}%`;
}

function buildFirstPurchaseLines(metrics, eurToMxn) {
  const lines = [];
  if (metrics.firstPurchase) {
    lines.push(
      `- Revenue sin renovaciones de suscripcion: €${(metrics.firstPurchase.revenue / eurToMxn).toFixed(2)} (${metrics.firstPurchase.orders} ordenes)`,
      `- MER primera compra: ${metrics.firstPurchase.mer.toFixed(2)}x`,
    );
  }
  if (metrics.newCustomers !== null && metrics.newCustomers !== undefined) {
    lines.push(`- Clientes nuevos: ${metrics.newCustomers}${metrics.cac !== null ? ` (CAC €${metrics.cac.toFixed(2)})` : ''}`);
  }
  if (!lines.length) return '';
  // Sin esta aclaracion el modelo mezclaba ordenes totales (con renovaciones)
  // con sesiones de la tienda y sacaba tasas de conversion sin sentido.
  return `\n\nPRIMERA COMPRA (Shopify, sin recurrentes):\n${lines.join('\n')}
NOTA: las ordenes recurrentes son renovaciones automaticas de suscripcion: no
pasan por la tienda ni las genera el gasto del dia. No las compares con sesiones
ni con el embudo. Para evaluar la adquisicion pagada usa el MER primera compra y
el CAC; el MER-ROAS total incluye renovaciones y se ve mejor de lo que es.`;
}

// Slack usa *negrita* (un asterisco); el **doble** de markdown sale literal.
// Se convierte por si el modelo lo usa igual, y se quitan los # de titulos.
function toSlackMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/^#{1,6}\s+/gm, '');
}

export async function generateDiagnosis(metrics, eurToMxn) {
  const client = new Anthropic();

  const subscriptionBlock = buildSubscriptionLines(metrics);
  const subscriptionSection = subscriptionBlock
    ? `\n${subscriptionBlock}`
    : '';

  const prompt = `Eres un analista de ecommerce DTC. Tienes los siguientes datos de ayer para ${STORE_NAME}:

METRICAS PAID (Meta Ads):
- Gasto: €${metrics.adSpend.toFixed(2)}
- Impresiones: ${metrics.impressions}
- Link Clicks: ${metrics.linkClicks}
- Add to Carts: ${metrics.addToCarts}
- Checkouts Iniciados: ${metrics.checkoutsInitiated}
- Compras (atribuidas Meta): ${metrics.metaOrders}
- ROAS Meta: ${metrics.metaROAS.toFixed(2)}x
- MER-ROAS (Shopify revenue / ad spend): ${metrics.merROAS.toFixed(2)}x
- CTR: ${metrics.ctr.toFixed(2)}%
- Add to Cart Rate: ${metrics.addToCartRate.toFixed(2)}%
- Checkout Rate: ${metrics.checkoutRate.toFixed(2)}%
- Purchase Rate: ${metrics.purchaseRate.toFixed(2)}%${buildAccountLines(metrics)}

METRICAS SHOPIFY (fuente de verdad):
- Revenue neto: €${(metrics.shopifyRevenue / eurToMxn).toFixed(2)}
- Ordenes reales: ${metrics.shopifyOrders}
- AOV: €${(metrics.shopifyAOV / eurToMxn).toFixed(2)}${subscriptionSection}${buildStoreFunnelLines(metrics)}${buildFirstPurchaseLines(metrics, eurToMxn)}

Identifica en 3-4 lineas:
1. Cual es el punto mas debil del funnel hoy y por que
${buildRoasInstruction()}
3. Una accion concreta que se deberia tomar hoy

Responde en espanol, directo, sin introducciones, en maximo 120 palabras.
Formato Slack: para negrita usa *un asterisco* (nunca **), sin titulos con #.`;

  const message = await client.messages.create({
    model: CLAUDE_MODEL,
    // Holgado a proposito: con 300 el texto se cortaba a media frase.
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  if (message.stop_reason === 'max_tokens') {
    console.warn('[Claude] El diagnostico llego al limite de tokens y puede estar cortado');
  }
  return toSlackMarkdown(message.content[0].text);
}
