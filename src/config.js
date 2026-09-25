function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function optional(name, defaultValue = '') {
  return process.env[name] || defaultValue;
}

function optionalNumber(name, defaultValue) {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.error(`${name} no es un numero valido ("${raw}") — usando ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

function parseSubscriptionTags(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(t => t.tag && t.label);
  } catch {
    console.error('SUBSCRIPTION_TAGS is not valid JSON — ignoring');
    return [];
  }
}

// Lista de cuentas de Meta a sumar en el reporte. Sin META_AD_ACCOUNTS se usa
// solo META_AD_ACCOUNT_ID, asi las tiendas de una sola cuenta no cambian nada.
// Un JSON invalido aborta: ignorarlo reportaria solo una parte del gasto.
function parseAdAccounts(raw, fallbackId) {
  if (!raw) return [{ id: fallbackId, label: 'Meta' }];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('META_AD_ACCOUNTS no es JSON valido');
    process.exit(1);
  }
  const accounts = Array.isArray(parsed)
    ? parsed.filter(a => a && a.id && a.label).map(a => ({ id: String(a.id), label: a.label }))
    : [];
  if (accounts.length === 0 || accounts.length !== parsed.length) {
    console.error('META_AD_ACCOUNTS debe ser una lista de {"id","label"} sin entradas vacias');
    process.exit(1);
  }
  // El desglose agrupa filas por label; dos iguales mezclarian sus cifras.
  if (new Set(accounts.map(a => a.label)).size !== accounts.length) {
    console.error('META_AD_ACCOUNTS tiene labels repetidos');
    process.exit(1);
  }
  return accounts;
}

export const STORE_NAME = required('STORE_NAME');
export const META_ACCESS_TOKEN = required('META_ACCESS_TOKEN');
export const META_AD_ACCOUNT_ID = required('META_AD_ACCOUNT_ID');
export const META_AD_ACCOUNTS = parseAdAccounts(optional('META_AD_ACCOUNTS'), META_AD_ACCOUNT_ID);
export const SHOPIFY_STORE_DOMAIN = required('SHOPIFY_STORE_DOMAIN');
export const SHOPIFY_ACCESS_TOKEN = required('SHOPIFY_ACCESS_TOKEN');
export const ANTHROPIC_API_KEY = required('ANTHROPIC_API_KEY');
export const SLACK_WEBHOOK_URL = required('SLACK_WEBHOOK_URL');

export const STORE_CURRENCY = optional('STORE_CURRENCY', '€');
export const STORE_LOCALE = optional('STORE_LOCALE', 'es-ES');
export const STORE_INDUSTRY = optional('STORE_INDUSTRY');
export const ROAS_BENCHMARK = optional('ROAS_BENCHMARK');
export const STORE_TIMEZONE = optional('STORE_TIMEZONE', 'America/Mexico_City');

// Fallback si la API de Meta no devuelve la timezone de la cuenta.
export const META_ACCOUNT_TIMEZONE = optional('META_ACCOUNT_TIMEZONE', 'America/Mexico_City');
// Horas minimas desde el cierre del dia (en hora de la cuenta) para publicar.
// Por debajo de este umbral Meta aun agrega gasto y el reporte lo subestimaria.
export const MIN_HOURS_AFTER_CLOSE = optionalNumber('MIN_HOURS_AFTER_CLOSE', 3);
export const REPORT_TIME_LABEL = optional('REPORT_TIME_LABEL', '9:00 AM');
export const META_API_VERSION = optional('META_API_VERSION', 'v21.0');
export const SHOPIFY_API_VERSION = optional('SHOPIFY_API_VERSION', '2024-10');
export const CLAUDE_MODEL = optional('CLAUDE_MODEL', 'claude-sonnet-4-6');
export const SUBSCRIPTION_TAGS = parseSubscriptionTags(optional('SUBSCRIPTION_TAGS'));
