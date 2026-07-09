import { SHOPIFY_STORE_DOMAIN, SHOPIFY_API_VERSION, STORE_TIMEZONE } from './config.js';

export function getYesterday() {
  const now = new Date();
  const todayLocal = now.toLocaleDateString('en-CA', { timeZone: STORE_TIMEZONE });
  const d = new Date(todayLocal + 'T12:00:00');
  d.setDate(d.getDate() - 1);
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
