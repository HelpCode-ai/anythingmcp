import { outboundRequest } from '../common/outbound-http';
import { SsrfBlockedError } from '../common/ssrf.util';
import { listIps } from '../connectors/egress';

/**
 * The WooCommerce setup, made to find out what is wrong instead of leaving it
 * to the user.
 *
 * WHY. Of 15 failed WooCommerce checks on Cloud in Oct-Nov 2026, 6 were a
 * wrong address or Plain permalinks, 3 a Cloudflare challenge and 5 a refused
 * key; every one got the same "No WooCommerce REST API at this address". And
 * people paste what the browser shows: `/wp-admin/…`, `/wp-json/wc/v3`, a
 * product page. WordPress describes itself without any key at `/wp-json/`:
 * its own address (`home`), and whether WooCommerce's REST API (`wc/v3`) is
 * there. So the address is cleaned silently, then asked, once, before the
 * key is tried:
 *  - `home` differs from what was typed (`www`, a page after the site):
 *    `home` is used, and the page saves it (`corrected`);
 *  - no `wc/v3`: WooCommerce is not active, or older than 3.5;
 *  - `/wp-json/` missing but `?rest_route=/` answers: permalinks are Plain,
 *    which WooCommerce's REST API does not support;
 *  - a challenge or block page: a firewall, named, with what to allow;
 *  - no DNS name, an invalid certificate, http only: said in those words.
 *
 * Every request is one unauthenticated GET through outboundRequest (the SSRF
 * policy, redirects re-checked), with an 8 s deadline. No key is ever sent
 * here. Behaviour is the same on Cloud and self-hosted; only the address a
 * firewall must allow is worded differently.
 */

export const WOOCOMMERCE_SLUG = 'woocommerce';
export const WOOCOMMERCE_URL_VAR = 'WOOCOMMERCE_URL';

const PROBE_TIMEOUT_MS = 8000;
/** The index is asked for two fields only; a site that ignores `_fields` sends every route (MBs). */
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
/** How much of a block page is looked at. */
const PAGE_SCAN_CHARS = 20_000;

// ── Address ─────────────────────────────────────────────────────────────

/** WordPress's own paths: what follows the site's address, never part of it. */
const WP_PATH_SEGMENTS = ['wp-json', 'wp-admin', 'wp-login.php', 'wp-content', 'wp-includes', 'xmlrpc.php'];

/**
 * The shop's address as the adapter wants it: `https://`, the host and the
 * folder WordPress lives in, nothing else. What the browser shows is cut
 * back to that: `/wp-admin/...`, `/wp-json/wc/v3`, `/wp-login.php`, a query,
 * a fragment, `index.php`, trailing slashes. `http://` becomes `https://`
 * (keys only travel over https; a site without it is told so by the check).
 * A subfolder (`https://example.com/shop`) stays: only the site itself can
 * say whether it is WordPress's folder or a page, and the check asks it.
 * Values that are not an address (a `{{VAR}}`, free text) come back trimmed.
 */
export function normalizeWooCommerceUrl(value: string): string {
  const text = value.trim();
  if (!text || text.includes('{{') || /\s/.test(text)) return text;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  if (hasScheme && !/^https?:\/\//i.test(text)) return text;
  let url: URL;
  try {
    url = new URL(hasScheme ? text : `https://${text}`);
  } catch {
    return text;
  }
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') return text;
  const kept: string[] = [];
  for (const segment of url.pathname.split('/')) {
    if (!segment) continue;
    if (WP_PATH_SEGMENTS.includes(segment.toLowerCase())) break;
    kept.push(segment);
  }
  if (kept.length && kept[kept.length - 1].toLowerCase() === 'index.php') kept.pop();
  const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : '';
  return `https://${auth}${url.host}${kept.length ? `/${kept.join('/')}` : ''}`;
}

/** `page` is `site` or a page under it (`https://x.com/shop/cart` under `https://www.x.com`). */
function isUnder(page: string, site: string): boolean {
  const key = (u: string) => normalizeWooCommerceUrl(u).replace(/^https:\/\/(?:www\.)?/i, '').toLowerCase();
  const p = key(page);
  const s = key(site);
  return p === s || p.startsWith(`${s}/`);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ── Discovery ───────────────────────────────────────────────────────────

export type WooCommerceProblem =
  | 'dns'
  | 'tls'
  | 'http_only'
  | 'refused'
  | 'timeout'
  | 'blocked'
  | 'rest_restricted'
  | 'plain_permalinks'
  | 'no_woocommerce'
  | 'woocommerce_too_old'
  | 'not_wordpress';

/** What the site said about itself. */
export interface WooCommerceDiscovery {
  /** The address the check went to (normalised). */
  url: string;
  /** WordPress's own address (`home`), when the index named it. */
  home?: string;
  /** The address to use instead of the one entered: `home`, when it differs. */
  corrected?: string;
  /** Found WooCommerce's REST API v3. */
  woocommerce?: boolean;
  problem?: WooCommerceProblem;
  /** What to tell the user about `problem` (or about the correction), in one paragraph. */
  message?: string;
  /**
   * The call with the key cannot work either (no such host, an invalid
   * certificate, http only, Plain permalinks): the check stops here instead
   * of sending the key.
   */
  final?: boolean;
  /** A page in the shop's admin that fixes `problem` (Settings → Permalinks). */
  fixUrl?: string;
}

/** Who the firewall must let through, in the user's words. */
export interface EgressContext {
  cloud: boolean;
  /** EGRESS_IPS. */
  egressIps: string[];
}

type Answer =
  | { ok: true; status: number; body: string; contentType: string }
  | { ok: false; code: string; message: string; ssrf: boolean };

async function get(url: string): Promise<Answer> {
  try {
    const response = await outboundRequest<string>({
      method: 'GET',
      url,
      timeout: PROBE_TIMEOUT_MS,
      headers: { Accept: 'application/json' },
      responseType: 'text',
      // The raw text: a block page must stay readable, and JSON is parsed below.
      transformResponse: [(data: unknown) => data],
      maxContentLength: MAX_INDEX_BYTES,
      // A 404 or a 403 page is the answer looked for, not a failure.
      validateStatus: () => true,
    });
    const contentType = String(response.headers?.['content-type'] ?? '');
    const body = typeof response.data === 'string' ? response.data : String(response.data ?? '');
    return { ok: true, status: response.status, body, contentType };
  } catch (err: any) {
    return {
      ok: false,
      code: String(err?.code ?? err?.cause?.code ?? ''),
      message: String(err?.message ?? err ?? ''),
      ssrf: err instanceof SsrfBlockedError || err?.name === 'SsrfBlockedError',
    };
  }
}

interface WpIndex {
  home?: string;
  namespaces: string[];
}

function parseIndex(answer: Answer): WpIndex | undefined {
  if (!answer.ok || answer.status >= 400) return undefined;
  const text = answer.body.trimStart();
  if (!text.startsWith('{')) return undefined;
  try {
    const json = JSON.parse(text) as { home?: unknown; namespaces?: unknown };
    if (!Array.isArray(json.namespaces)) return undefined;
    return {
      ...(typeof json.home === 'string' && json.home ? { home: json.home } : {}),
      namespaces: json.namespaces.filter((n): n is string => typeof n === 'string'),
    };
  } catch {
    return undefined;
  }
}

/** A REST error of WordPress itself (`{"code":"rest_…","message":…}`). */
function restErrorCode(answer: Answer): string | undefined {
  if (!answer.ok || !answer.body.trimStart().startsWith('{')) return undefined;
  try {
    const code = (JSON.parse(answer.body) as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

/** The product behind a block or challenge page, '' for an unnamed firewall, undefined when it is not one. */
function blockedBy(answer: Answer): string | undefined {
  if (!answer.ok) return undefined;
  const page = answer.body.slice(0, PAGE_SCAN_CHARS).toLowerCase();
  const challenge =
    page.includes('cf-chl') ||
    page.includes('challenge-platform') ||
    page.includes('just a moment...') ||
    page.includes('attention required! | cloudflare');
  if (challenge || (answer.status === 403 && page.includes('cloudflare'))) return 'Cloudflare';
  if (page.includes('wordfence')) return 'Wordfence';
  if (page.includes('sucuri')) return 'Sucuri';
  if (page.includes('ithemes security') || page.includes('solid security')) return 'Solid Security (iThemes)';
  if (page.includes('imunify360')) return 'Imunify360';
  if (page.includes('mod_security') || page.includes('modsecurity')) return 'ModSecurity';
  if ([403, 406, 429, 503].includes(answer.status) && !restErrorCode(answer)) return '';
  return undefined;
}

const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL|EPROTO|SSL routines|certificate/i;

/** The address the firewall must let through, worded for this deployment. */
export function egressWording(ctx: EgressContext): string {
  if (ctx.egressIps.length) {
    return `${ctx.cloud ? "AnythingMCP Cloud's" : "this AnythingMCP server's"} ${
      ctx.egressIps.length === 1 ? 'address' : 'addresses'
    } ${listIps(ctx.egressIps)}`;
  }
  return ctx.cloud ? 'AnythingMCP Cloud' : 'the address of your AnythingMCP server';
}

function blockedMessage(product: string, host: string, ctx: EgressContext): string {
  const who = egressWording(ctx);
  if (product === 'Cloudflare') {
    return (
      `Cloudflare in front of ${host} answers with a browser challenge ("Just a moment…"), which an API ` +
      'call cannot pass. In Cloudflare, under Security → WAF, add a custom rule that skips the challenge ' +
      `for the path /wp-json/wc/ (or for ${who}), or lower the Bot Fight Mode for it.`
    );
  }
  const name = product ? `${product} on ${host}` : `A firewall or security plugin on ${host}`;
  return (
    `${name} refused the request before WordPress saw it. Allow requests to /wp-json/wc/ from ${who} in ` +
    `${product ? `${product}'s settings` : 'its settings (or ask the host)'}.`
  );
}

function wooFound(index: WpIndex, url: string): WooCommerceDiscovery {
  const home = index.home ? normalizeWooCommerceUrl(index.home) : undefined;
  const corrected = home && home !== url ? home : undefined;
  const site = home ?? url;
  if (index.namespaces.includes('wc/v3')) {
    return {
      url,
      ...(home ? { home } : {}),
      ...(corrected ? { corrected } : {}),
      woocommerce: true,
      ...(corrected ? { message: `WooCommerce answers at ${corrected}: that address is used.` } : {}),
    };
  }
  const old = index.namespaces.some((n) => n === 'wc/v2' || n === 'wc/v1');
  return {
    url,
    ...(home ? { home } : {}),
    ...(corrected ? { corrected } : {}),
    woocommerce: false,
    problem: old ? 'woocommerce_too_old' : 'no_woocommerce',
    message: old
      ? `WooCommerce on ${site} is too old: it has no REST API v3, which came with WooCommerce 3.5. ` +
        'Update WooCommerce in WordPress under Dashboard → Updates, then check again.'
      : `WordPress answers at ${site}, but WooCommerce is not active there (its REST API, wc/v3, is missing). ` +
        'Check that this is the address of the shop, and that the WooCommerce plugin is activated under Plugins.',
  };
}

/**
 * Asks the site, without a key, what it is. Undefined when there is nothing
 * to say: not an address, refused by the SSRF policy, or an answer this does
 * not recognise (the check then goes ahead as before).
 */
export async function discoverWooCommerce(
  typedUrl: string,
  ctx: EgressContext,
): Promise<WooCommerceDiscovery | undefined> {
  const url = normalizeWooCommerceUrl(typedUrl ?? '');
  if (!/^https:\/\/[^/{}\s]+/i.test(url)) return undefined;
  const host = hostOf(url);

  const first = await get(`${url}/wp-json/?_fields=home,namespaces`);
  if (!first.ok) return networkProblem(first, url, host);

  const index = parseIndex(first);
  if (index) return wooFound(index, url);

  const restCode = restErrorCode(first);
  if (restCode && (first.status === 401 || first.status === 403)) {
    return {
      url,
      problem: 'rest_restricted',
      message:
        `A plugin on ${host} limits the WordPress REST API to signed-in users (${restCode}). WooCommerce keys ` +
        'usually still get through; if the check fails, allow /wp-json/wc/ in that plugin\'s settings ' +
        '(for example "Disable REST API").',
    };
  }

  const product = blockedBy(first);
  if (product !== undefined) {
    return { url, problem: 'blocked', message: blockedMessage(product, host, ctx) };
  }

  // A page of the site, or a folder that is not WordPress's: ask the host's
  // root first (WordPress also answers ?rest_route= on any of its pages).
  const origin = new URL(url).origin;
  if (origin !== url) {
    const rootIndex = parseIndex(await get(`${origin}/wp-json/?_fields=home,namespaces`));
    if (rootIndex?.home && isUnder(url, rootIndex.home)) return wooFound(rootIndex, url);
  }

  // No index at /wp-json/: with Plain permalinks WordPress answers at ?rest_route=/ only.
  const plainIndex = parseIndex(await get(`${url}/?rest_route=/&_fields=home,namespaces`));
  if (plainIndex) {
    const found = wooFound(plainIndex, url);
    const site = found.home ?? url;
    const fixUrl = `${site}/wp-admin/options-permalink.php`;
    return {
      ...found,
      problem: 'plain_permalinks',
      final: true,
      fixUrl,
      message:
        `WordPress at ${site} answers only at ?rest_route=, which means its permalinks are set to Plain, and ` +
        "WooCommerce's REST API needs them on. In WordPress open Settings → Permalinks, choose \"Post name\" " +
        `and click Save Changes; nothing else on the site changes. Direct link: ${fixUrl}`,
    };
  }

  return {
    url,
    problem: 'not_wordpress',
    message:
      `No WordPress REST API answered at ${url}/wp-json/. Enter the address of the WordPress site WooCommerce ` +
      'runs on, as it opens in the browser, without a page after it. If that is the address, a security plugin ' +
      'or the host has turned the REST API off: allow /wp-json/wc/ there.',
  };
}

async function networkProblem(
  failure: Extract<Answer, { ok: false }>,
  url: string,
  host: string,
): Promise<WooCommerceDiscovery | undefined> {
  if (failure.ssrf) {
    // "Host not found" is a missing DNS name; anything else is the policy's call, told by the check itself.
    if (/Host not found|ENOTFOUND|could not be resolved/i.test(failure.message) && !/EAI_AGAIN/.test(failure.message)) {
      return {
        url,
        problem: 'dns',
        final: true,
        message: `No site answers at ${host}: that name does not exist. Check the spelling of the shop's address.`,
      };
    }
    return undefined;
  }
  if (failure.code === 'ENOTFOUND') {
    return {
      url,
      problem: 'dns',
      final: true,
      message: `No site answers at ${host}: that name does not exist. Check the spelling of the shop's address.`,
    };
  }
  const tls = TLS_CODES.test(failure.code) || TLS_CODES.test(failure.message);
  if (tls || failure.code === 'ECONNREFUSED') {
    // Over plain http the site may answer: then it has no working https at all.
    const plain = await get(`${url.replace(/^https:/i, 'http:')}/wp-json/?_fields=home`);
    if (parseIndex(plain) || (plain.ok && plain.status < 400)) {
      return {
        url,
        problem: 'http_only',
        final: true,
        message:
          `${host} answers only over http://, without a working https. WooCommerce accepts API keys only over ` +
          'https (over http they would travel readable), so AnythingMCP needs the shop on https://. Most hosts ' +
          'turn on a free certificate (Let\'s Encrypt) in their control panel; then check again.',
      };
    }
    if (tls) {
      return {
        url,
        problem: 'tls',
        final: true,
        message:
          `The certificate of ${host} is not valid${failure.code ? ` (${failure.code})` : ''}. WooCommerce keys only ` +
          'travel over https with a valid certificate; most hosts issue a free one (Let\'s Encrypt) in their ' +
          'control panel.',
      };
    }
    return {
      url,
      problem: 'refused',
      final: true,
      message: `${host} refuses connections on https. Check the address, and that the shop opens with https:// in a browser.`,
    };
  }
  if (failure.code === 'ECONNABORTED' || failure.code === 'ETIMEDOUT' || /timeout/i.test(failure.message)) {
    // Slow is not broken: the call with the key has a longer deadline.
    return {
      url,
      problem: 'timeout',
      message: `${host} did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds. Check that the shop opens in a browser; a very slow site makes every call slow.`,
    };
  }
  return undefined;
}

// ── A refused key, told apart ───────────────────────────────────────────

/**
 * `woocommerce_rest_cannot_view` on a call with a key: WooCommerce did not
 * see the key's user (WordPress answers the same to a call with no key at
 * all), or that user may not read orders. 377 of 384 refused WooCommerce
 * calls in Oct-Nov 2026 were this one.
 */
export const WOOCOMMERCE_CANNOT_VIEW_HINT =
  'WooCommerce treated the call as coming from a user who may not see this data ' +
  '(woocommerce_rest_cannot_view). Either the key\'s user is not an administrator or shop manager (or was ' +
  'removed or demoted since), or WordPress does not know it runs on https (a proxy or CDN in front of it ends ' +
  'https without telling WordPress), in which case WooCommerce ignores the key. Create the key for an ' +
  'administrator; if that does not help, ask the host to pass the https status on to WordPress.';

/** `woocommerce_rest_authentication_error`: the key itself is unknown. */
export const WOOCOMMERCE_UNKNOWN_KEY_HINT =
  'WooCommerce does not know this key: the consumer key and secret come from different keys, the key was ' +
  'revoked, or it was created on another site (a staging copy). Create a new key under WooCommerce → ' +
  'Settings → Advanced → REST API and enter both values.';

/** The hint for a 401 body of WooCommerce, or undefined for any other answer. */
export function wooCommerceAuthHint(status: number | undefined, text: string): string | undefined {
  if (status !== 401) return undefined;
  if (/woocommerce_rest_cannot_view|cannot list resources|cannot view this resource/i.test(text)) {
    return WOOCOMMERCE_CANNOT_VIEW_HINT;
  }
  if (/woocommerce_rest_authentication_error|Consumer (?:key|secret) is invalid|Invalid signature/i.test(text)) {
    return WOOCOMMERCE_UNKNOWN_KEY_HINT;
  }
  return undefined;
}

/**
 * What a failed WooCommerce check (setup form or install probe) should say
 * in place of the generic hint, or undefined to keep it. `text` is the
 * failure with the provider's answer. A refused key is told apart by
 * WooCommerce's own code; an address problem comes from the discovery, run
 * here unless the caller already has it. The caller appends the provider's
 * words, as for any hint.
 */
export async function wooCommerceCheckAdvice(input: {
  adapterSlug: string;
  status?: number;
  text: string;
  siteUrl: string | undefined;
  ctx: EgressContext;
  discovery?: WooCommerceDiscovery;
}): Promise<string | undefined> {
  if (input.adapterSlug !== WOOCOMMERCE_SLUG) return undefined;
  const auth = wooCommerceAuthHint(input.status, input.text);
  if (auth) return auth;
  if (input.status === 401) return undefined;
  const discovery =
    input.discovery ?? (input.siteUrl ? await discoverWooCommerce(input.siteUrl, input.ctx).catch(() => undefined) : undefined);
  // A site that answered with WooCommerce present says nothing about this failure.
  if (!discovery?.problem || !discovery.message) return undefined;
  return discovery.message;
}

/** The site address of a stored WooCommerce base URL (`…/wp-json/wc/v3`). */
export function wooCommerceSiteOf(envVars: Record<string, unknown>, baseUrl: string | undefined): string | undefined {
  const fromVar = envVars[WOOCOMMERCE_URL_VAR];
  if (typeof fromVar === 'string' && fromVar && !fromVar.includes('{{')) return fromVar;
  if (!baseUrl || baseUrl.includes('{{')) return undefined;
  return normalizeWooCommerceUrl(baseUrl);
}
