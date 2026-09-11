/**
 * Base-URL sanity checks for connector create/update.
 *
 * `baseUrl` used to be validated as `@IsString()` and nothing more, so the API
 * happily stored things that could never work. A fortnight of production rows:
 * an API key the user pasted into the URL field and the UI prefixed with
 * `https://` (`https://pk_56532023_AZFKELRKU7FWLDAE9W9X0I9M8KYVIC64`), a bare
 * `https://Ahmad1`, a `javascript:` payload, and DATABASE connectors reading
 * `test`, `adada` and `cx`. Each one produced a connector with zero usable
 * tools and no explanation — and of the people who got that far in the last two
 * weeks, most never came back.
 *
 * The checks are deliberately shallow. They reject what cannot possibly be
 * right, and say what to do instead; they do not try to prove the host exists.
 */

/** Schemes a DATABASE connector's connection string may use. */
const DATABASE_SCHEMES = [
  'postgres',
  'postgresql',
  'mysql',
  'mariadb',
  'mssql',
  'sqlserver',
];

/**
 * Hosts that are legitimately single-label. Anything else without a dot is
 * either an internal Docker/Kubernetes service name — fine when self-hosting,
 * impossible from the cloud — or, far more often, a pasted secret.
 */
const SINGLE_LABEL_ALLOWED = ['localhost'];

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Connectors may carry `{{ENV_VAR}}` placeholders resolved per call (Amazon
 * SP-API, Magento, Substack and Bitrix24 all ship this way), so a templated URL
 * is not a literal one and cannot be parsed here.
 */
function isTemplated(baseUrl: string): boolean {
  // Two indexOf scans rather than /\{\{[^}]+\}\}/. The regex backtracks
  // quadratically on an input of many '{' — CodeQL js/polynomial-redos — and
  // this value comes straight from a request body. Same question either way:
  // is there an opening '{{' with a non-empty run before a closing '}}'.
  const open = baseUrl.indexOf('{{');
  if (open === -1) return false;
  return baseUrl.indexOf('}}', open + 2) > open + 2;
}

/**
 * Returns a human-readable problem, or null when the URL is plausible.
 *
 * @param requirePublicHost Reject single-label hostnames. True on cloud, where
 * every connector necessarily calls a public API; false when self-hosted, where
 * `http://weclapp:8080` is a perfectly good address on the Docker network.
 */
export function validateBaseUrl(
  baseUrl: string,
  opts: { type: string; requirePublicHost: boolean },
): string | null {
  const raw = (baseUrl ?? '').trim();

  if (!raw) return 'A base URL is required.';
  if (isTemplated(raw)) return null;

  if (opts.type === 'DATABASE') {
    const scheme = raw.split('://')[0]?.toLowerCase();
    if (!raw.includes('://') || !DATABASE_SCHEMES.includes(scheme)) {
      return `"${truncate(raw)}" is not a database connection string. Use one of ${DATABASE_SCHEMES.join(
        ', ',
      )}, for example postgresql://user:password@host:5432/database.`;
    }
    return null;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `"${truncate(
      raw,
    )}" is not a valid URL. It should look like https://api.example.com/v1.${credentialHint(
      raw,
    )}`;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `"${url.protocol}" is not a supported scheme — the base URL must start with https:// (or http:// for a local service).`;
  }

  if (opts.requirePublicHost && !looksLikeAHost(url.hostname)) {
    return `"${truncate(
      url.hostname,
    )}" is not a server address. The base URL is where your API lives, e.g. https://api.example.com/v1 — if this is an API key or token, put it under Authentication instead.`;
  }

  return null;
}

/**
 * The single most common way this field goes wrong is a pasted credential —
 * a ClickUp `pk_…`, a Stripe-style `sk_…`. Say so when the value looks like
 * one, because "that is not a URL" does not tell someone where it belongs.
 */
function credentialHint(raw: string): string {
  const looksLikeSecret =
    !raw.includes('.') && !raw.includes('/') && raw.length >= 16;
  return looksLikeSecret
    ? ' If this is an API key or token, put it under Authentication instead.'
    : '';
}

function looksLikeAHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (SINGLE_LABEL_ALLOWED.includes(host)) return true;
  // Bracketed IPv6 arrives from URL.hostname without the brackets but with colons.
  if (host.includes(':')) return true;
  if (IPV4.test(host)) return true;
  return host.includes('.');
}

function truncate(value: string, max = 48): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
