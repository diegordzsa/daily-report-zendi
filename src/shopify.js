import { SHOPIFY_STORE_DOMAIN, SHOPIFY_API_VERSION, SHOPIFY_ANALYTICS_API_VERSION } from './config.js';

export function getYesterday() {
  if (process.env.REPORT_DATE) return process.env.REPORT_DATE;
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return d.toISOString().slice(0, 10);
}

export async function fetchShopifyOrders(accessToken) {

  const yesterday = getYesterday();

  const dayBefore = new Date(yesterday + 'T12:00:00');
  dayBefore.setDate(dayBefore.getDate() - 1);
  const dayAfter = new Date(yesterday + 'T12:00:00');
  dayAfter.setDate(dayAfter.getDate() + 1);

  const params = new URLSearchParams({
    status: 'any',
    created_at_min: `${dayBefore.toISOString().slice(0, 10)}T00:00:00`,
    created_at_max: `${dayAfter.toISOString().slice(0, 10)}T23:59:59`,
    limit: '250',
    fields: 'id,created_at,total_price,subtotal_price,total_discounts,total_tax,tags,line_items',
  });

  const allOrders = [];
  let url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders.json?${params}`;

  while (url) {
    console.log(`[Shopify] Fetching orders...`);
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': accessToken },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Shopify API error: ${res.status} ${res.statusText} — ${body.substring(0, 200)}`);
    }

    const json = await res.json();
    allOrders.push(...(json.orders || []));

    const link = res.headers.get('link');
    const next = link?.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }

  console.log(`[Shopify] Got ${allOrders.length} total orders (3-day window)`);

  const yesterdayOrders = allOrders.filter(o => o.created_at?.slice(0, 10) === yesterday);
  console.log(`[Shopify] ${yesterdayOrders.length} orders for ${yesterday}`);

  return yesterdayOrders.map(order => {
    const subtotal = parseFloat(order.subtotal_price) || 0;
    const tax = parseFloat(order.total_tax) || 0;
    return {
      date: yesterday,
      order_count: 1,
      order_net_sales: subtotal + tax,
      order_tags: order.tags || '',
    };
  });
}

// Embudo de la tienda tal como lo muestra Shopify Analytics (Sesiones →
// carrito → checkout → compra). Las tasas son sobre sesiones, igual que en el
// admin, y el dia se corta en la timezone de la tienda. Requiere el scope
// read_reports y una version de API con shopifyqlQuery (2025-10+).
// Devuelve null si falla: el embudo es informativo y no debe tumbar el reporte.
export async function fetchShopifyFunnel(accessToken, date) {
  const query = `FROM sessions SHOW sessions, sessions_with_cart_additions, ` +
    `sessions_that_reached_checkout, sessions_that_completed_checkout, ` +
    `added_to_cart_rate, reached_checkout_rate, conversion_rate ` +
    `SINCE ${date} UNTIL ${date}`;
  const gql = `query($q: String!) { shopifyqlQuery(query: $q) { tableData { rows } parseErrors } }`;

  try {
    const res = await fetch(
      `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_ANALYTICS_API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: gql, variables: { q: query } }),
      }
    );
    const json = await res.json().catch(() => ({}));
    const result = json.data?.shopifyqlQuery;
    if (!res.ok || json.errors || !result) {
      const detail = json.errors ? JSON.stringify(json.errors).substring(0, 200) : `${res.status} ${res.statusText}`;
      throw new Error(detail);
    }
    if (result.parseErrors?.length) throw new Error(`ShopifyQL: ${result.parseErrors.join('; ')}`);

    const row = result.tableData?.rows?.[0] || {};
    const n = (k) => Number(row[k]) || 0;
    const funnel = {
      sessions: n('sessions'),
      cartSessions: n('sessions_with_cart_additions'),
      checkoutSessions: n('sessions_that_reached_checkout'),
      convertedSessions: n('sessions_that_completed_checkout'),
      addToCartRate: n('added_to_cart_rate') * 100,
      reachedCheckoutRate: n('reached_checkout_rate') * 100,
      conversionRate: n('conversion_rate') * 100,
    };
    console.log(`[Shopify] Funnel ${date}: ${funnel.sessions} sesiones, ` +
      `ATC ${funnel.addToCartRate.toFixed(2)}%, checkout ${funnel.reachedCheckoutRate.toFixed(2)}%, ` +
      `CVR ${funnel.conversionRate.toFixed(2)}%`);
    return funnel;
  } catch (err) {
    console.warn(`[Shopify] No se pudo leer el embudo de sesiones (¿falta scope read_reports?): ${err.message}`);
    return null;
  }
}
