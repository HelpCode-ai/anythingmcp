/**
 * The apps /welcome offers first: the ones workspaces connect and get working.
 *
 * Ranked from this deployment's own data: how many workspaces installed the
 * adapter in the last WINDOW_DAYS and had at least one successful call on it.
 * Installs alone would rank the wrong things: in the first days of October
 * 2026 the keyless starter pack was installed by 78 workspaces (Hacker News)
 * and used by 2, while Telegram was set up by 149 and worked for 133.
 *
 * Only aggregate counts are read, and an adapter needs MIN_WORKSPACES
 * successful workspaces before it can be ranked, so one tenant's usage never
 * shows through. Keyless adapters are left out: they have their own section.
 * A deployment with little traffic (a fresh self-host) fills the list from
 * FALLBACK, which is what the cloud ranked when this was written.
 */
export const POPULAR_WINDOW_DAYS = 30;
export const POPULAR_MIN_WORKSPACES = 3;
export const POPULAR_MAX = 8;
export const POPULAR_CACHE_MS = 60 * 60 * 1000;

export const POPULAR_FALLBACK: readonly string[] = [
  'telegram-bot',
  'etsy',
  'odoo',
  'woocommerce',
  'weclapp',
  'lexware-office',
  'getmyinvoices',
  'google-search-console',
];
