import { createHmac, randomBytes } from 'crypto';

/**
 * OAuth 1.0a request signer (HMAC-SHA1).
 *
 * Some APIs (e.g. ImmobilienScout24) never moved to OAuth 2.0 — they require
 * every request to be signed per the OAuth 1.0a protocol (RFC 5849) with an
 * `Authorization: OAuth ...` header. This is incompatible with our OAUTH2
 * engine (token exchange + Bearer), so OAUTH1 is its own auth type.
 *
 * Supports both:
 * - **two-legged** (app-only): consumer key + secret, no token. The signing key
 *   is `consumerSecret&` (empty token secret).
 * - **three-legged** (user context): additionally pass token + tokenSecret.
 *
 * The signature MUST cover the oauth_* params plus the request's query params
 * and any `application/x-www-form-urlencoded` body params — so the signer takes
 * the final query/body params, not just the auth config.
 */

export interface OAuth1SignParams {
  method: string;
  /** Full request URL. Any query string here is ignored — pass query in `queryParams`. */
  url: string;
  consumerKey: string;
  consumerSecret: string;
  /** Three-legged only. Omit for two-legged. */
  token?: string;
  tokenSecret?: string;
  /** Request query params (will be folded into the signature base string). */
  queryParams?: Record<string, unknown>;
  /** form-urlencoded body params only (NOT json bodies). */
  bodyParams?: Record<string, unknown>;
  /** Optional realm for the Authorization header (not part of the signature). */
  realm?: string;
  /** Injectable for deterministic tests. */
  nonce?: string;
  timestamp?: string;
}

/** RFC 3986 percent-encoding — stricter than encodeURIComponent. */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Strip the query string and default ports from a URL to form the signature base URL. */
function baseStringUri(url: string): string {
  const u = new URL(url);
  const scheme = u.protocol.toLowerCase();
  const host = u.hostname.toLowerCase();
  const isDefaultPort =
    !u.port ||
    (scheme === 'https:' && u.port === '443') ||
    (scheme === 'http:' && u.port === '80');
  const port = isDefaultPort ? '' : `:${u.port}`;
  return `${scheme}//${host}${port}${u.pathname}`;
}

/**
 * Build the `Authorization: OAuth ...` header value for a signed request.
 * Returns just the header value (caller sets the `Authorization` header).
 */
export function buildOAuth1Header(p: OAuth1SignParams): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: p.consumerKey,
    oauth_nonce: p.nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:
      p.timestamp ?? Math.floor(Date.now() / 1000).toString(),
    oauth_version: '1.0',
  };
  if (p.token) oauthParams.oauth_token = p.token;

  // All params that participate in the signature base string: oauth_* + query + body.
  const allParams: Array<[string, string]> = [];
  const collect = (obj?: Record<string, unknown>) => {
    if (!obj) return;
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      allParams.push([k, String(v)]);
    }
  };
  collect(oauthParams);
  collect(p.queryParams);
  collect(p.bodyParams);

  // Percent-encode, then sort by encoded key, then by encoded value.
  const normalized = allParams
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const baseString = [
    p.method.toUpperCase(),
    rfc3986(baseStringUri(p.url)),
    rfc3986(normalized),
  ].join('&');

  const signingKey = `${rfc3986(p.consumerSecret)}&${rfc3986(p.tokenSecret ?? '')}`;
  const signature = createHmac('sha1', signingKey)
    .update(baseString)
    .digest('base64');

  // Header contains ONLY the oauth_* params (plus the computed signature),
  // each value percent-encoded. Query/body params are NOT in the header.
  const headerParams: Record<string, string> = {
    ...oauthParams,
    oauth_signature: signature,
  };
  const parts = Object.keys(headerParams)
    .sort()
    .map((k) => `${rfc3986(k)}="${rfc3986(headerParams[k])}"`);
  if (p.realm) parts.unshift(`realm="${rfc3986(p.realm)}"`);

  return `OAuth ${parts.join(', ')}`;
}
