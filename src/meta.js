import { META_API_VERSION } from './config.js';

const ACTION_MAP = {
  'link_click': 'actions_link_click',
  'offsite_conversion.fb_pixel_add_to_cart': 'actions_offsite_conversion_fb_pixel_add_to_cart',
  'offsite_conversion.fb_pixel_initiate_checkout': 'actions_offsite_conversion_fb_pixel_initiate_checkout',
  'offsite_conversion.fb_pixel_purchase': 'actions_offsite_conversion_fb_pixel_purchase',
};

const ACTION_VALUE_MAP = {
  'offsite_conversion.fb_pixel_purchase': 'action_values_offsite_conversion_fb_pixel_purchase',
};

function extractActions(actionsArray, map) {
  const result = {};
  for (const key of Object.values(map)) {
    result[key] = 0;
  }
  if (!Array.isArray(actionsArray)) return result;

  for (const entry of actionsArray) {
    const mapped = map[entry.action_type];
    if (mapped) {
      result[mapped] = parseFloat(entry.value) || 0;
    }
  }
  return result;
}

// Timezone y moneda de una cuenta publicitaria. La timezone define cuando cierra
// el dia para Meta (y por tanto cuando el gasto esta consolidado); la moneda
// dice si el gasto de varias cuentas se puede sumar tal cual.
// Devuelve null si no se pudo leer, para que el llamador use su fallback.
export async function fetchAdAccountInfo(accessToken, accountId) {
  const params = new URLSearchParams({
    access_token: accessToken,
    fields: 'timezone_name,currency',
  });
  const url = `https://graph.facebook.com/${META_API_VERSION}/act_${accountId}?${params}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[Meta] No se pudo leer la cuenta act_${accountId}: ${res.status}`);
      return null;
    }
    const json = await res.json();
    return {
      timeZone: json.timezone_name || null,
      currency: json.currency || null,
    };
  } catch (err) {
    console.warn(`[Meta] No se pudo leer la cuenta act_${accountId}: ${err.message}`);
    return null;
  }
}

export async function fetchMetaAds(accessToken, date, account) {
  const fields = 'spend,impressions,clicks,actions,action_values,cpc,cpm,ctr,frequency';
  const params = new URLSearchParams({
    access_token: accessToken,
    time_range: JSON.stringify({ since: date, until: date }),
    level: 'account',
    fields,
  });

  const url = `https://graph.facebook.com/${META_API_VERSION}/act_${account.id}/insights?${params}`;

  console.log(`[Meta] Fetching ad insights for ${account.label} (act_${account.id})...`);
  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Meta API error (${account.label}): ${res.status} ${res.statusText} — ${body.substring(0, 200)}`);
  }

  const json = await res.json();

  if (json.error) {
    throw new Error(`Meta API error (${account.label}): ${json.error.message}`);
  }

  const data = json.data || [];
  console.log(`[Meta] ${account.label}: ${data.length} rows`);

  if (data.length > 0) {
    const rawSpend = data.reduce((s, r) => s + (parseFloat(r.spend) || 0), 0);
    console.log(`[Meta] ${account.label} raw spend for ${date}: ${rawSpend.toFixed(2)}`);
  }

  if (data.length === 0) return [];

  return data.map(row => ({
    account: account.label,
    date: row.date_start,
    spend: parseFloat(row.spend) || 0,
    impressions: parseInt(row.impressions) || 0,
    clicks: parseInt(row.clicks) || 0,
    cpc: parseFloat(row.cpc) || 0,
    cpm: parseFloat(row.cpm) || 0,
    ctr: parseFloat(row.ctr) || 0,
    frequency: parseFloat(row.frequency) || 0,
    ...extractActions(row.actions, ACTION_MAP),
    ...extractActions(row.action_values, ACTION_VALUE_MAP),
  }));
}
