/**
 * URLs as they may appear in a log line.
 *
 * The connector engines used to log the request URL as sent. Some APIs take
 * the credential in the URL itself (Telegram's `/bot<TOKEN>/getUpdates`, an
 * MCP server's `?api_key=`), so a warning about a flaky upstream wrote a
 * customer's bot token to the backend log. A log line needs the host, the
 * path and the names of the query parameters to be useful, never their
 * values, so this keeps exactly that:
 *
 * - origin and path; no userinfo, no fragment;
 * - query parameters (in the URL and those sent beside it, axios `params`)
 *   by name only: `?chat_id=***&api_key=***`;
 * - every given secret (the connector's credentials as substituted into the
 *   URL) replaced by `***` wherever it appears, as typed and percent-encoded;
 * - anything of a known secret shape left in the path (a Telegram bot token,
 *   a vendor-prefixed key, a JWT, a long random segment) replaced too, for
 *   the connectors that typed their key into the URL instead of a variable.
 */
import { redactSecretLiterals } from './secret-literals.util';

export const LOG_MASK = '***';

/** A logged URL is cut here; nothing useful is this long. */
const MAX_LOG_URL_LENGTH = 1024;
/** Shorter values are not masked: they would match inside ordinary words and ids. */
const MIN_SECRET_LENGTH = 6;

export interface UrlForLogOptions {
  /** Values that must never appear in the line (a connector's credentials). */
  secrets?: Iterable<unknown>;
  /** Query parameters sent beside the URL (axios `params`): only their names are kept. */
  params?: unknown;
}

function usableSecrets(secrets: Iterable<unknown> | undefined): string[] {
  if (!secrets) return [];
  const out = new Set<string>();
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < MIN_SECRET_LENGTH) continue;
    out.add(s);
    // The same value as it can stand in a URL once encoded.
    for (const encode of [encodeURIComponent, encodeURI]) {
      try {
        const encoded = encode(s);
        if (encoded !== s) out.add(encoded);
      } catch {
        /* a lone surrogate: nothing to encode */
      }
    }
  }
  // Longest first, so a value that contains another is masked whole.
  return [...out].sort((a, b) => b.length - a.length);
}

function maskValues(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join(LOG_MASK);
  }
  return out;
}

function queryKeys(query: string): string[] {
  const keys: string[] = [];
  for (const pair of query.split(/[&;]/)) {
    if (!pair) continue;
    const name = pair.split('=')[0];
    try {
      keys.push(decodeURIComponent(name.replace(/\+/g, ' ')));
    } catch {
      keys.push(name);
    }
  }
  return keys;
}

function paramKeys(params: unknown): string[] {
  if (!params || typeof params !== 'object') return [];
  if (params instanceof URLSearchParams) return [...params.keys()];
  return Object.entries(params as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k]) => k);
}

/**
 * `url` reduced to what a log line may carry: see the file comment. Never
 * throws; a value that is not a string comes back as `(no URL)`.
 */
export function urlForLog(url: unknown, opts: UrlForLogOptions = {}): string {
  if (typeof url !== 'string' || !url) return '(no URL)';
  const secrets = usableSecrets(opts.secrets);
  // Exact values first, before parsing re-encodes anything.
  const text = maskValues(url, secrets);

  let base: string;
  let keys: string[] = [];
  try {
    const u = new URL(text);
    const origin = u.origin !== 'null' ? u.origin : `${u.protocol}//${u.host}`;
    // A path template's `{param}` comes back percent-encoded; restore it so
    // the line reads like the tool's mapping.
    base = `${origin}${u.pathname.replace(/%7B/gi, '{').replace(/%7D/gi, '}')}`;
    keys = [...u.searchParams.keys()];
  } catch {
    const cut = text.search(/[?#]/);
    base = cut === -1 ? text : text.slice(0, cut);
    if (cut !== -1 && text[cut] === '?') keys = queryKeys(text.slice(cut + 1).split('#')[0]);
  }
  // A secret that only matches once decoded (the URL parser normalises
  // some escapes), then the generic secret shapes.
  base = redactSecretLiterals(maskValues(base, secrets), [], { marker: LOG_MASK });

  const names = [...new Set([...keys, ...paramKeys(opts.params)])].map(
    (k) => `${maskValues(k, secrets).slice(0, 64)}=${LOG_MASK}`,
  );
  const line = names.length ? `${base}?${names.join('&')}` : base;
  return line.length > MAX_LOG_URL_LENGTH ? `${line.slice(0, MAX_LOG_URL_LENGTH)}…` : line;
}

/** authConfig fields that hold a credential, whatever the auth type. */
const AUTH_SECRET_FIELDS = [
  'apiKey',
  'token',
  'accessToken',
  'refreshToken',
  'clientSecret',
  'password',
  'secret',
  'privateKey',
  'consumerSecret',
  'tokenSecret',
];

/**
 * The credentials in a connector's (resolved) authConfig, for masking in log
 * lines: the known secret fields, extra auth headers and, for QUERY_AUTH,
 * every value (they all go into the query string).
 */
export function authConfigSecrets(authType: unknown, authConfig: unknown): string[] {
  if (!authConfig || typeof authConfig !== 'object') return [];
  const cfg = authConfig as Record<string, unknown>;
  const values: unknown[] =
    authType === 'QUERY_AUTH'
      ? Object.values(cfg)
      : AUTH_SECRET_FIELDS.map((field) => cfg[field]);
  const extra = cfg.extraHeaders;
  if (extra && typeof extra === 'object') values.push(...Object.values(extra));
  return values.filter((v): v is string => typeof v === 'string' && v.length >= MIN_SECRET_LENGTH);
}

/**
 * Everything an engine should mask in its log lines: the connector's secret
 * variables the caller handed over (`logSecrets`) plus the credentials in its
 * authConfig.
 */
export function engineLogSecrets(config: {
  authType?: unknown;
  authConfig?: unknown;
  logSecrets?: readonly string[];
}): string[] {
  return [...(config.logSecrets ?? []), ...authConfigSecrets(config.authType, config.authConfig)];
}
