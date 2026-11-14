import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../../common/prisma.service';
import { decrypt, encrypt } from '../../common/crypto/encryption.util';
import { getRequiredSecret } from '../../common/secrets.util';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';
import { interpolateDeep, interpolateString } from '../../common/env-interpolation.util';
import { outboundAxiosOptions } from '../../common/outbound-http';
import { connectorPageUrl } from '../../common/url.util';
import { ConnectorAuthStatusService, credentialRef } from './connector-auth-status.service';

/**
 * TikTok Shop (Open API, version 202309 and later) shop tokens.
 *
 * WHY. TikTok Shop signs every call with the app secret (HMAC-SHA256 over the
 * path, the sorted query and the body, wrapped in the secret) and sends the
 * seller's access token in its own `x-tts-access-token` header, not as an
 * OAuth bearer. The seller authorizes the app through TikTok Shop's
 * authorization link (`service_id`), TikTok sends the browser to the app's
 * fixed Redirect URL with `code` and `state`, and the code is exchanged with
 * a GET on `auth.tiktok-shops.com/api/v2/token/get` (app key and secret in
 * the query) for an access token (7 days by default) and a refresh token
 * (lasting as long as the seller's authorization). Expiry fields are Unix
 * timestamps, not durations. Shop calls also need the shop's `shop_cipher`,
 * read from Get Authorized Shops after the exchange.
 *
 * A connector opts in with `authType: "HMAC"` and `authConfig.tokenProvider:
 * "tiktok-shop"`. Nothing else uses this service.
 *
 * The app: the seller's own (App key, App secret and Service ID in the
 * connector's variables), or, when the connector's App key is empty, the
 * server's public app from TIKTOK_SHOP_PLATFORM_APP_KEY / _APP_SECRET /
 * _SERVICE_ID (resolveTikTokShopAuthConfig). The server's secret is filled in
 * memory only, for the call, the authorization or the renewal at hand.
 *
 * What it keeps, in the connector's encrypted authConfig (the same field
 * names as OAuth2 tokens where they mean the same, so the credential status
 * and the setup check read it the same way): accessToken, refreshToken,
 * expiresAt (ms epoch), expiresIn (s), refreshTokenExpiresAt (ms epoch),
 * shopCipher, shopId, shopName, shopRegion, shopCode, shops (every authorized
 * shop), sellerName, sellerBaseRegion, grantedScopes, authorizedAt,
 * lastRefreshedAt.
 *
 * Like ShopeeTokenService: renewed before it expires, one renewal at a time
 * per connector (in this process, and across processes under a Postgres
 * advisory lock, re-reading the stored refresh token inside it), and a
 * refresh token TikTok refuses marks the connector needs_reauth, with one
 * email to the owner, until the shop is authorized again.
 *
 * Never logs a token, the app secret or a signed URL.
 */

export const TIKTOK_SHOP_TOKEN_PROVIDER = 'tiktok-shop';

export const TIKTOK_SHOP_AUTH_HOST = 'https://auth.tiktok-shops.com';
export const TIKTOK_SHOP_TOKEN_GET_PATH = '/api/v2/token/get';
export const TIKTOK_SHOP_REFRESH_PATH = '/api/v2/token/refresh';
export const TIKTOK_SHOP_AUTHORIZED_SHOPS_PATH = '/authorization/202309/shops';
/** Seller authorization entry points (Authorization overview, "Authorization domains by market"). */
export const TIKTOK_SHOP_AUTHORIZE_URL_ROW = 'https://services.tiktokshop.com/open/authorize';
export const TIKTOK_SHOP_AUTHORIZE_URL_US = 'https://services.us.tiktokshop.com/open/authorize';

/** Renew when less than this remains (or half the lifetime, if shorter). Tokens last 7 days. */
const REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ACCESS_LIFETIME_S = 7 * 24 * 60 * 60;
const HTTP_TIMEOUT_MS = 10_000;
const LOCK_NAMESPACE = 'amcp:tiktok-shop-refresh:';
const LOCK_MAX_WAIT_MS = 3_000;
const LOCK_TIMEOUT_MS = 30_000;
/** After a refusal, calls fail at once for this long before the database is read again. */
const REFUSED_RECHECK_MS = 10 * 60 * 1000;

/**
 * Response codes that say "try again later", never "authorize again":
 * rate limit, internal error, timeout.
 */
const TRANSIENT_CODES = new Set([36009002, 36009003, 36009007]);

/** Whether a connector's auth is a TikTok Shop authorization. */
export function isTikTokShopAuth(authType: string | undefined, authConfig: unknown): boolean {
  return (
    authType === 'HMAC' &&
    !!authConfig &&
    typeof authConfig === 'object' &&
    (authConfig as { tokenProvider?: unknown }).tokenProvider === TIKTOK_SHOP_TOKEN_PROVIDER
  );
}

/** Whether a TikTok Shop connector still needs its shop authorized (no usable token). */
export function tiktokShopNeedsAuthorization(authType: string | undefined, authConfig: unknown): boolean {
  if (!isTikTokShopAuth(authType, authConfig)) return false;
  const ac = authConfig as Record<string, unknown>;
  const usable = (v: unknown) => typeof v === 'string' && v.trim() !== '' && !/\{\{/.test(v);
  return !usable(ac.refreshToken) && !usable(ac.accessToken);
}

/**
 * Whether a call to this path carries `shop_cipher`. TikTok refuses it
 * ("shop_cipher ... not required") on the authorization and seller APIs, on
 * file and image uploads, global products, compliance, and when creating a
 * custom brand.
 */
export function shopCipherApplies(pathname: string, method = 'GET'): boolean {
  if (/^\/(authorization|seller)\/\d{6}\//.test(pathname)) return false;
  if (/^\/product\/\d{6}\/(compliance|global_products|files\/upload|images\/upload)(\/|$)/.test(pathname)) {
    return false;
  }
  if (method.toUpperCase() === 'POST' && /^\/product\/\d{6}\/brands\/?$/.test(pathname)) return false;
  return true;
}

/**
 * The signature TikTok Shop expects (developer guide "Sign your API
 * request"): every query parameter except `sign` and `access_token`, sorted
 * by key and concatenated as key + value, after the path; then the body
 * (unless the request is multipart); the whole wrapped in the app secret on
 * both sides and hashed with HMAC-SHA256 keyed with the secret, hex.
 *
 * Used for the service's own calls (Get Authorized Shops) and by the specs
 * as the independent reference for the engine's template.
 */
export function tiktokShopSign(input: {
  secret: string;
  path: string;
  query: Record<string, string | number | undefined>;
  body?: string;
}): string {
  const keys = Object.keys(input.query)
    .filter((k) => k !== 'sign' && k !== 'access_token' && input.query[k] !== undefined)
    .sort();
  const params = keys.map((k) => `${k}${input.query[k]}`).join('');
  const base = `${input.secret}${input.path}${params}${input.body ?? ''}${input.secret}`;
  return createHmac('sha256', input.secret).update(base, 'utf8').digest('hex');
}

/** What the service needs to talk to TikTok Shop for one connector. */
export interface TikTokShopApp {
  appKey: string;
  appSecret: string;
  /** The app's Service ID, for the authorization link. May be missing on a call path. */
  serviceId?: string;
  /** API host, e.g. https://open-api.tiktokglobalshop.com (no path). */
  apiHost: string;
}

/**
 * The app settings of a TikTok Shop connector from its resolved authConfig
 * and base URL: the app key (authConfig.appKey, else the signed app_key
 * query parameter), the app secret (the signature secret), the service id
 * and the API host (the base URL's origin). Undefined when the key, secret
 * or host is missing.
 */
export function tiktokShopAppFrom(
  authConfig: Record<string, unknown> | undefined,
  baseUrl: string | undefined,
): TikTokShopApp | undefined {
  if (!authConfig) return undefined;
  const sig = (authConfig.signature ?? {}) as Record<string, unknown>;
  const query = (sig.queryParams ?? {}) as Record<string, unknown>;
  const appKey = String(authConfig.appKey ?? query.app_key ?? '').trim();
  const appSecret = String(sig.secret ?? '').trim();
  const serviceId = String(authConfig.serviceId ?? '').trim();
  let apiHost = '';
  try {
    apiHost = new URL(String(baseUrl ?? '')).origin;
  } catch {
    apiHost = '';
  }
  const unresolved = (v: string) => !v || /\{\{/.test(v);
  if (unresolved(appKey) || unresolved(appSecret) || !apiHost || apiHost === 'null') return undefined;
  return { appKey, appSecret, apiHost, ...(unresolved(serviceId) ? {} : { serviceId }) };
}

/**
 * The server's own TikTok Shop app (a public App Store app), from the server
 * variables. Optional; available only when all three are set.
 */
export const TIKTOK_SHOP_PLATFORM_VARS = {
  appKey: 'TIKTOK_SHOP_PLATFORM_APP_KEY',
  appSecret: 'TIKTOK_SHOP_PLATFORM_APP_SECRET',
  serviceId: 'TIKTOK_SHOP_PLATFORM_SERVICE_ID',
} as const;

/** The connector variables of the seller's own app, as the catalog adapter names them. */
export const TIKTOK_SHOP_OWN_APP_VARS = {
  appKey: 'TIKTOK_SHOP_APP_KEY',
  appSecret: 'TIKTOK_SHOP_APP_SECRET',
  serviceId: 'TIKTOK_SHOP_SERVICE_ID',
} as const;

export interface TikTokShopPlatformApp {
  appKey: string;
  appSecret: string;
  serviceId: string;
}

/**
 * The server's TikTok Shop app, or undefined when any of its three variables
 * is unset. Read from the process environment, where the config module also
 * loads the .env file; the same on Cloud and self-hosted.
 */
export function tiktokShopPlatformApp(
  env: Record<string, string | undefined> = process.env,
): TikTokShopPlatformApp | undefined {
  const read = (name: string) => String(env[name] ?? '').trim();
  const appKey = read(TIKTOK_SHOP_PLATFORM_VARS.appKey);
  const appSecret = read(TIKTOK_SHOP_PLATFORM_VARS.appSecret);
  const serviceId = read(TIKTOK_SHOP_PLATFORM_VARS.serviceId);
  if (!appKey || !appSecret || !serviceId) return undefined;
  return { appKey, appSecret, serviceId };
}

/** Empty, or a `{{VARIABLE}}` nobody filled in. */
function isBlank(value: unknown): boolean {
  const text = typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim();
  return !text || /\{\{/.test(text);
}

/** The connector's own app key: authConfig.appKey, else the signed app_key parameter. */
function ownAppKey(authConfig: Record<string, unknown>): unknown {
  const sig = (authConfig.signature ?? {}) as Record<string, unknown>;
  const query = (sig.queryParams ?? {}) as Record<string, unknown>;
  return isBlank(authConfig.appKey) ? query.app_key : authConfig.appKey;
}

/**
 * Whether a TikTok Shop connector works with the server's app: its own App
 * key is empty (or an unfilled variable) and the server has an app. A
 * connector with an App key of its own always uses that app.
 */
export function tiktokShopUsesPlatformApp(
  authType: string | undefined,
  authConfig: unknown,
  platformApp: TikTokShopPlatformApp | undefined = tiktokShopPlatformApp(),
): boolean {
  if (!platformApp || !isTikTokShopAuth(authType, authConfig)) return false;
  return isBlank(ownAppKey(authConfig as Record<string, unknown>));
}

/**
 * The connector's resolved authConfig with the server's app filled in, when
 * the connector uses it (see tiktokShopUsesPlatformApp); otherwise the same
 * object, unchanged. Fills the app key, the Service ID, the signing secret,
 * the signed app_key parameter and TikTok's signing template.
 *
 * The result lives in memory for one call or one authorization. It is never
 * written back: the token service stores only the token fields it patches,
 * and the connector row keeps its empty app variables.
 */
export function resolveTikTokShopAuthConfig<T extends Record<string, unknown> | undefined>(
  authType: string | undefined,
  authConfig: T,
  platformApp: TikTokShopPlatformApp | undefined = tiktokShopPlatformApp(),
): T {
  if (!authConfig || !platformApp || !tiktokShopUsesPlatformApp(authType, authConfig, platformApp)) return authConfig;
  const sig = (authConfig.signature ?? {}) as Record<string, unknown>;
  const query = (sig.queryParams ?? {}) as Record<string, unknown>;
  const secret = platformApp.appSecret;
  return {
    ...authConfig,
    appKey: platformApp.appKey,
    serviceId: platformApp.serviceId,
    signature: {
      ...sig,
      secret,
      queryParams: { ...query, app_key: platformApp.appKey },
      template: `${secret}\${pathname}\${sortedParams}\${body}${secret}`,
    },
  } as T;
}

/**
 * The TikTok Shop app variables a connector still needs before it can be
 * authorized, for the setup check: none when it uses the server's app;
 * otherwise App key, App secret and Service ID, each when it is empty. The
 * variables are optional in the catalog (an empty value is how a connector
 * asks for the server's app), so without this a server with no app of its
 * own would call a connector with nothing in them ready to authorize.
 */
export function tiktokShopMissingAppVars(
  authType: string | undefined,
  authConfig: unknown,
  platformApp: TikTokShopPlatformApp | undefined = tiktokShopPlatformApp(),
): string[] {
  if (!isTikTokShopAuth(authType, authConfig)) return [];
  if (tiktokShopUsesPlatformApp(authType, authConfig, platformApp)) return [];
  const ac = authConfig as Record<string, unknown>;
  const sig = (ac.signature ?? {}) as Record<string, unknown>;
  const missing: string[] = [];
  if (isBlank(ownAppKey(ac))) missing.push(TIKTOK_SHOP_OWN_APP_VARS.appKey);
  if (isBlank(sig.secret)) missing.push(TIKTOK_SHOP_OWN_APP_VARS.appSecret);
  if (isBlank(ac.serviceId)) missing.push(TIKTOK_SHOP_OWN_APP_VARS.serviceId);
  return missing;
}

/**
 * The app a stored TikTok Shop connector authorizes and signs with: its own,
 * or the server's when its App key is empty. `isTikTokShop` is false for any
 * other connector; `app` is undefined when the app is incomplete.
 */
export function tiktokShopAppOfConnector(
  connector: { authType: string; authConfig: string | null; baseUrl: string; envVars?: unknown },
  encryptionKey: string,
  platformApp: TikTokShopPlatformApp | undefined = tiktokShopPlatformApp(),
): { app?: TikTokShopApp; isTikTokShop: boolean; usesPlatformApp: boolean; envVars: Record<string, string> } {
  let authConfig: Record<string, unknown> = {};
  try {
    authConfig = connector.authConfig ? JSON.parse(decrypt(connector.authConfig, encryptionKey)) : {};
  } catch {
    authConfig = {};
  }
  const envVars = (connector.envVars as Record<string, string> | null) ?? {};
  if (!isTikTokShopAuth(connector.authType, authConfig)) {
    return { isTikTokShop: false, usesPlatformApp: false, envVars };
  }
  const resolved = interpolateDeep(authConfig, envVars);
  const usesPlatformApp = tiktokShopUsesPlatformApp(connector.authType, resolved, platformApp);
  return {
    isTikTokShop: true,
    usesPlatformApp,
    envVars,
    app: tiktokShopAppFrom(
      resolveTikTokShopAuthConfig(connector.authType, resolved, platformApp),
      interpolateString(connector.baseUrl, envVars),
    ),
  };
}

/**
 * The link a seller opens to authorize the app. TikTok sends the browser to
 * the Redirect URL set on the app in Partner Center, with `code` and this
 * `state`. US shops authorize on the US domain, every other market on the
 * global one.
 */
export function buildTikTokShopAuthorizationUrl(serviceId: string, state: string, market?: string): string {
  const base = String(market ?? '').trim().toUpperCase() === 'US' ? TIKTOK_SHOP_AUTHORIZE_URL_US : TIKTOK_SHOP_AUTHORIZE_URL_ROW;
  return `${base}?${new URLSearchParams({ service_id: serviceId, state }).toString()}`;
}

/**
 * A TikTok Shop answer that is an error: an HTTP error, or any answer whose
 * `code` is not 0. Reads axios errors, the engine's ResponseBodyError
 * (`responseBody`) and plain answers alike.
 */
export function tiktokShopError(err: unknown): { status?: number; code?: number; message?: string } | undefined {
  const res = (err as { response?: { status?: unknown; data?: unknown } })?.response;
  const data = (res?.data ?? (err as { responseBody?: unknown })?.responseBody) as
    | { code?: unknown; message?: unknown }
    | undefined;
  const status = typeof res?.status === 'number' ? res.status : (err as { status?: unknown })?.status;
  if (!data || typeof data !== 'object') {
    return typeof status === 'number' ? { status } : undefined;
  }
  const code = Number(data.code);
  return {
    status: typeof status === 'number' ? status : undefined,
    code: Number.isFinite(code) ? code : undefined,
    message: typeof data.message === 'string' && data.message ? data.message.slice(0, 200) : undefined,
  };
}

/**
 * TikTok refused the access token of a shop call, so a fresh one may fix
 * it: `105002` (expired), or `36009004` naming the access token header.
 */
export function isTikTokShopAccessTokenRejected(err: unknown): boolean {
  const e = tiktokShopError(err);
  if (!e?.code) return false;
  if (e.code === 105002) return true;
  return e.code === 36009004 && /access[_-]?token/i.test(e.message ?? '');
}

/**
 * TikTok refused the refresh token itself: no retry can work until the shop
 * is authorized again. A 5xx, a network failure, a rate limit or an error
 * about the app key or secret (a setting to fix, not an authorization to
 * repeat) is not this.
 */
export function isTikTokShopRefreshRefused(err: unknown): boolean {
  const e = tiktokShopError(err);
  if (!e?.code) return false;
  if (typeof e.status === 'number' && (e.status >= 500 || e.status === 429)) return false;
  if (TRANSIENT_CODES.has(e.code)) return false;
  return !/app[_ ]?(key|secret)/i.test(e.message ?? '');
}

/** A TikTok Shop failure in words safe to log and to show: status, TikTok's code and message. */
export function describeTikTokShopError(err: unknown): string {
  const e = tiktokShopError(err);
  if (e && (e.status !== undefined || e.code !== undefined)) {
    return [e.status !== undefined ? `HTTP ${e.status}` : undefined, e.code !== undefined ? `code ${e.code}` : undefined, e.message]
      .filter(Boolean)
      .join(': ');
  }
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string') return code;
  const msg = (err as { message?: unknown })?.message;
  return typeof msg === 'string' && !/token|sign=|secret/i.test(msg) ? msg.slice(0, 200) : 'network error';
}

/** One authorized shop, as Get Authorized Shops lists it. */
export interface TikTokShopInfo {
  id: string;
  name?: string;
  region?: string;
  code?: string;
  sellerType?: string;
  cipher: string;
}

/** The shops of a Get Authorized Shops answer. Throws on an error answer. */
export function shopsFrom(data: unknown): TikTokShopInfo[] {
  const d = (data ?? {}) as { code?: unknown; data?: { shops?: unknown } };
  if (Number(d.code) !== 0) throw answerError('Get Authorized Shops', d);
  const list = Array.isArray(d.data?.shops) ? (d.data!.shops as Array<Record<string, unknown>>) : [];
  return list
    .filter((s) => s && typeof s.cipher === 'string' && s.cipher)
    .map((s) => ({
      id: String(s.id ?? ''),
      ...(typeof s.name === 'string' ? { name: s.name } : {}),
      ...(typeof s.region === 'string' ? { region: s.region } : {}),
      ...(typeof s.code === 'string' ? { code: s.code } : {}),
      ...(typeof s.seller_type === 'string' ? { sellerType: s.seller_type } : {}),
      cipher: String(s.cipher),
    }));
}

/**
 * The shop the connector works with: the one whose id, code or name matches
 * `preferred` (TIKTOK_SHOP_SHOP_ID), else the first one TikTok lists.
 */
export function pickShop(shops: TikTokShopInfo[], preferred?: string): TikTokShopInfo | undefined {
  const want = String(preferred ?? '').trim();
  if (want && !/\{\{/.test(want)) {
    const lower = want.toLowerCase();
    const hit = shops.find(
      (s) => s.id === want || (s.code ?? '').toLowerCase() === lower || (s.name ?? '').toLowerCase() === lower,
    );
    if (hit) return hit;
  }
  return shops[0];
}

interface ShopToken {
  accessToken: string;
  shopCipher?: string;
  expiresAt: number;
  lifetimeMs: number;
  obtainedAt: number;
}

/** The stored authorization of a connector, read from its authConfig. */
interface StoredAuth {
  accessToken?: string;
  refreshToken?: string;
  shopCipher?: string;
  expiresAt?: number;
  expiresIn?: number;
  refreshTokenExpiresAt?: number;
  obtainedAt?: number;
}

/** Tokens out of a token endpoint answer. */
interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  expiresIn: number;
  refreshTokenExpiresAt?: number;
  sellerName?: string;
  sellerBaseRegion?: string;
  grantedScopes?: string[];
}

type Db = Pick<PrismaService, 'connector'>;

function unauthorized(message: string, hint?: string): Error & { status: number; hint?: string } {
  const err = new Error(message) as Error & { status: number; hint?: string };
  err.status = 401;
  if (hint) err.hint = hint;
  return err;
}

function windowFor(lifetimeMs: number): number {
  return lifetimeMs > 0 ? Math.min(REFRESH_WINDOW_MS, lifetimeMs / 2) : REFRESH_WINDOW_MS;
}

/** An error answer shaped like an axios error, so the classifiers above read it the same way. */
function answerError(what: string, data: unknown): Error & { response: { status: number; data: unknown } } {
  const d = (data ?? {}) as { code?: unknown };
  const err = new Error(`TikTok Shop refused ${what} (code ${String(d.code ?? '?')})`) as Error & {
    response: { status: number; data: unknown };
  };
  err.response = { status: 200, data };
  return err;
}

function readStored(authConfig: Record<string, unknown> | undefined): StoredAuth {
  const ac = authConfig ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() && !/\{\{/.test(v) ? v.trim() : undefined);
  const num = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  return {
    accessToken: str(ac.accessToken),
    refreshToken: str(ac.refreshToken),
    shopCipher: str(ac.shopCipher),
    expiresAt: num(ac.expiresAt),
    expiresIn: num(ac.expiresIn),
    refreshTokenExpiresAt: num(ac.refreshTokenExpiresAt),
    obtainedAt: Date.parse(String(ac.lastRefreshedAt ?? ac.authorizedAt ?? '')) || undefined,
  };
}

/**
 * What TikTok's token endpoints answer, checked. Throws on an error answer.
 * `access_token_expire_in` and `refresh_token_expire_in` are Unix timestamps
 * in seconds.
 */
export function tokensFrom(data: unknown, now = Date.now()): Tokens {
  const d = (data ?? {}) as { code?: unknown; data?: Record<string, unknown> };
  if (Number(d.code) !== 0) throw answerError('the token request', d);
  const t = d.data ?? {};
  const accessToken = typeof t.access_token === 'string' ? t.access_token : '';
  const refreshToken = typeof t.refresh_token === 'string' ? t.refresh_token : '';
  if (!accessToken || !refreshToken) throw new Error('the answer carried no access_token or refresh_token');
  const accessExpiry = Number(t.access_token_expire_in);
  const expiresAt = accessExpiry > now / 1000 ? accessExpiry * 1000 : now + DEFAULT_ACCESS_LIFETIME_S * 1000;
  const refreshExpiry = Number(t.refresh_token_expire_in);
  return {
    accessToken,
    refreshToken,
    expiresAt,
    expiresIn: Math.max(1, Math.round((expiresAt - now) / 1000)),
    ...(refreshExpiry > 0 ? { refreshTokenExpiresAt: refreshExpiry * 1000 } : {}),
    ...(typeof t.seller_name === 'string' ? { sellerName: t.seller_name } : {}),
    ...(typeof t.seller_base_region === 'string' ? { sellerBaseRegion: t.seller_base_region } : {}),
    ...(Array.isArray(t.granted_scopes) ? { grantedScopes: t.granted_scopes.map(String) } : {}),
  };
}

function authorizeAgainHint(connectorId: string | undefined, reason?: string): string {
  const page = connectorPageUrl(connectorId);
  return (
    `TikTok Shop refused the shop's refresh token${reason ? ` (${reason})` : ''}: the seller's authorization ` +
    'expired or was cancelled in Seller Center (App Store > My apps and incidents), or the token was already ' +
    `replaced. Retrying will not help. Open the connector in AnythingMCP${page ? ` (${page})` : ''} and click ` +
    'Authorize with Provider again.'
  );
}

@Injectable()
export class TikTokShopTokenService {
  private readonly logger = new Logger(TikTokShopTokenService.name);
  private readonly encryptionKey: string;

  private cache = new Map<string, ShopToken>();
  private inFlight = new Map<string, Promise<ShopToken>>();
  private refused = new Map<string, { message: string; recheckAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Optional() private readonly authStatus?: ConnectorAuthStatusService,
  ) {
    this.encryptionKey = getRequiredSecret('ENCRYPTION_KEY', this.configService.get<string>('ENCRYPTION_KEY'));
  }

  /**
   * The credentials a shop call carries: the access token (for the
   * `x-tts-access-token` header) and the shop cipher. Renews the token first
   * when it is about to expire, and reads the shop cipher when it is still
   * missing. Throws (status 401) when the shop has not been authorized, or
   * its refresh token was refused.
   */
  async getShopCredentials(config: {
    baseUrl: string;
    authConfig?: Record<string, unknown>;
    connectorId?: string;
  }): Promise<{ accessToken: string; shopCipher?: string }> {
    const token = await this.getToken(config);
    if (!token.shopCipher && config.connectorId) {
      const cipher = await this.ensureShopCipher(config, token.accessToken);
      if (cipher) token.shopCipher = cipher;
    }
    return { accessToken: token.accessToken, ...(token.shopCipher ? { shopCipher: token.shopCipher } : {}) };
  }

  private async getToken(config: {
    baseUrl: string;
    authConfig?: Record<string, unknown>;
    connectorId?: string;
  }): Promise<ShopToken> {
    const { connectorId } = config;
    const now = Date.now();
    if (connectorId) {
      const cached = this.cache.get(connectorId);
      if (cached && cached.expiresAt > now + windowFor(cached.lifetimeMs)) return cached;
      const refused = this.refusedError(connectorId);
      if (refused) throw refused;
    }

    const stored = readStored(config.authConfig);
    if (!stored.accessToken && !stored.refreshToken) {
      const page = connectorPageUrl(connectorId);
      throw unauthorized(
        'TikTok Shop: this shop has not been authorized yet. No request was sent to TikTok. ' +
          `Open the connector in AnythingMCP${page ? ` (${page})` : ''} and click Authorize with Provider.`,
      );
    }
    const lifetimeMs = (stored.expiresIn ?? DEFAULT_ACCESS_LIFETIME_S) * 1000;
    const snapshot: ShopToken | undefined =
      stored.accessToken && stored.expiresAt
        ? {
            accessToken: stored.accessToken,
            shopCipher: stored.shopCipher,
            expiresAt: stored.expiresAt,
            lifetimeMs,
            obtainedAt: stored.obtainedAt ?? stored.expiresAt - lifetimeMs,
          }
        : undefined;
    if (snapshot && snapshot.expiresAt > now + windowFor(lifetimeMs)) {
      if (connectorId) this.cache.set(connectorId, snapshot);
      return snapshot;
    }
    // Without a saved connector, nothing can be stored, so nothing is renewed either.
    if (!connectorId || !stored.refreshToken) {
      if (snapshot && snapshot.expiresAt > now) return snapshot;
      throw unauthorized(
        'TikTok Shop: the access token has expired and this connector cannot renew it. Authorize the shop again.',
      );
    }
    return this.singleFlight(connectorId, () => this.refresh(config, connectorId)).catch((err) => {
      // TikTok was unreachable or answered 5xx: an access token that is
      // still valid for a while is better than none.
      if (snapshot && snapshot.expiresAt > Date.now() && !this.refused.has(connectorId)) return snapshot;
      throw err;
    });
  }

  /**
   * A new token after TikTok refused the one sent at `sentAt`. Takes a token
   * another call obtained since, else renews (one renewal for a burst).
   */
  async renewAfterRejection(
    config: { baseUrl: string; authConfig?: Record<string, unknown>; connectorId?: string },
    sentAt: number,
  ): Promise<{ accessToken: string; shopCipher?: string } | null> {
    const { connectorId } = config;
    if (!connectorId) return null;
    if (this.refusedError(connectorId)) return null;
    const pick = (t: ShopToken) => ({ accessToken: t.accessToken, ...(t.shopCipher ? { shopCipher: t.shopCipher } : {}) });
    const cached = this.cache.get(connectorId);
    if (cached && cached.obtainedAt >= sentAt && cached.expiresAt > Date.now()) return pick(cached);
    this.cache.delete(connectorId);
    try {
      return pick(await this.singleFlight(connectorId, () => this.refresh(config, connectorId, sentAt)));
    } catch {
      return null;
    }
  }

  /**
   * Exchange the code TikTok sent back after the seller authorized the app,
   * read the authorized shops, and store tokens and shop on the connector.
   * Throws with TikTok's answer when the exchange is refused. A failure to
   * read the shops does not undo the authorization: the shop cipher is read
   * again on the first call.
   */
  async exchangeCode(input: {
    connectorId: string;
    app: TikTokShopApp;
    code: string;
    preferredShop?: string;
  }): Promise<{ shopName?: string; shopCount: number }> {
    const data = await this.tokenCall(TIKTOK_SHOP_TOKEN_GET_PATH, {
      app_key: input.app.appKey,
      app_secret: input.app.appSecret,
      auth_code: input.code,
      grant_type: 'authorized_code',
    });
    const now = Date.now();
    const tokens = tokensFrom(data, now);
    let shops: TikTokShopInfo[] = [];
    try {
      shops = await this.fetchShops(input.app, tokens.accessToken);
    } catch (err) {
      this.logger.warn(
        `Connector ${input.connectorId}: could not read the authorized TikTok shops (${describeTikTokShopError(err)})`,
      );
    }
    const shop = pickShop(shops, input.preferredShop);
    await this.withLock(input.connectorId, async (db) => {
      const saved = await this.persist(db, input.connectorId, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        expiresAt: tokens.expiresAt,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
        sellerName: tokens.sellerName,
        sellerBaseRegion: tokens.sellerBaseRegion,
        grantedScopes: tokens.grantedScopes,
        ...shopFields(shop, shops),
        authorizedAt: new Date(now).toISOString(),
        lastRefreshedAt: undefined,
      });
      if (!saved) throw new Error('the shop tokens could not be stored');
    });
    this.forget(input.connectorId);
    this.cache.set(input.connectorId, {
      accessToken: tokens.accessToken,
      shopCipher: shop?.cipher,
      expiresAt: tokens.expiresAt,
      lifetimeMs: tokens.expiresIn * 1000,
      obtainedAt: now,
    });
    await this.authStatus?.clear(input.connectorId);
    this.logger.log(`Connector ${input.connectorId}: TikTok shop authorized (${shops.length} shop(s))`);
    return { shopName: shop?.name, shopCount: shops.length };
  }

  /** The credentials changed (a new authorization, new app keys): start over. */
  forget(connectorId: string): void {
    this.cache.delete(connectorId);
    this.refused.delete(connectorId);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private singleFlight(connectorId: string, fn: () => Promise<ShopToken>): Promise<ShopToken> {
    const running = this.inFlight.get(connectorId);
    if (running) return running;
    const p = fn().finally(() => this.inFlight.delete(connectorId));
    this.inFlight.set(connectorId, p);
    return p;
  }

  private refusedError(connectorId: string): (Error & { status: number }) | undefined {
    const entry = this.refused.get(connectorId);
    if (!entry) return undefined;
    if (Date.now() >= entry.recheckAt) {
      this.refused.delete(connectorId);
      return undefined;
    }
    return unauthorized(
      `TikTok Shop: the shop's refresh token was refused, so no new access token can be obtained. No request was sent to TikTok. ${entry.message}`,
      entry.message,
    );
  }

  /** Read the authorized shops with a fresh token and store the chosen shop's cipher. */
  private async ensureShopCipher(
    config: { baseUrl: string; authConfig?: Record<string, unknown>; connectorId?: string },
    accessToken: string,
  ): Promise<string | undefined> {
    const app = tiktokShopAppFrom(resolveTikTokShopAuthConfig('HMAC', config.authConfig), config.baseUrl);
    if (!app || !config.connectorId) return undefined;
    try {
      const shops = await this.fetchShops(app, accessToken);
      const preferred = (config.authConfig ?? {}).shopId;
      const shop = pickShop(shops, typeof preferred === 'string' ? preferred : undefined);
      if (!shop) return undefined;
      await this.persist(this.prisma, config.connectorId, shopFields(shop, shops));
      const cached = this.cache.get(config.connectorId);
      if (cached) cached.shopCipher = shop.cipher;
      return shop.cipher;
    } catch (err) {
      this.logger.warn(
        `Connector ${config.connectorId}: could not read the authorized TikTok shops (${describeTikTokShopError(err)})`,
      );
      return undefined;
    }
  }

  /**
   * Renew under the connector's lock. The refresh token is read from the
   * database inside the lock: another process may have renewed it a moment
   * ago, and then its fresh access token is taken instead of spending one.
   */
  private async refresh(
    config: { baseUrl: string; authConfig?: Record<string, unknown> },
    connectorId: string,
    rejectedAt?: number,
  ): Promise<ShopToken> {
    let pending: { token: ShopToken; update: Record<string, unknown> } | undefined;
    try {
      return await this.refreshLocked(config, connectorId, rejectedAt, (p) => (pending = p));
    } catch (err) {
      if (!pending) throw err;
      this.logger.warn(`Connector ${connectorId}: the renewed TikTok Shop token was not stored under the lock; storing it again`);
      await this.persist(this.prisma, connectorId, pending.update);
      this.cache.set(connectorId, pending.token);
      return pending.token;
    }
  }

  private async refreshLocked(
    config: { baseUrl: string; authConfig?: Record<string, unknown> },
    connectorId: string,
    rejectedAt: number | undefined,
    onRenewed: (p: { token: ShopToken; update: Record<string, unknown> }) => void,
  ): Promise<ShopToken> {
    return this.withLock(connectorId, async (db) => {
      const fresh = await this.loadFromDb(db, connectorId);
      const authConfig = fresh?.authConfig ?? config.authConfig;
      const stored = readStored(authConfig);
      const now = Date.now();
      const lifetimeMs = (stored.expiresIn ?? DEFAULT_ACCESS_LIFETIME_S) * 1000;

      // Renewed by another process (or authorized again) meanwhile.
      if (stored.accessToken && stored.expiresAt) {
        const obtainedAt = stored.obtainedAt ?? 0;
        const usable =
          rejectedAt !== undefined
            ? obtainedAt > rejectedAt && stored.expiresAt > now
            : stored.expiresAt > now + windowFor(lifetimeMs);
        if (usable) {
          const token = { accessToken: stored.accessToken, shopCipher: stored.shopCipher, expiresAt: stored.expiresAt, lifetimeMs, obtainedAt };
          this.cache.set(connectorId, token);
          return token;
        }
      }

      // Refused before (by this process or another), and not authorized since.
      const status = fresh?.status;
      if (
        status?.authStatus === 'needs_reauth' &&
        status.authStatusRef &&
        status.authStatusRef === credentialRef(stored.refreshToken ?? '')
      ) {
        const message = status.authStatusMessage || authorizeAgainHint(connectorId);
        this.refused.set(connectorId, { message, recheckAt: now + REFUSED_RECHECK_MS });
        throw unauthorized(message, message);
      }

      // Read from the database, so the server's app (for a connector without
      // an App key of its own) is filled in here, not by the caller.
      const app = tiktokShopAppFrom(resolveTikTokShopAuthConfig('HMAC', authConfig), config.baseUrl);
      if (!app || !stored.refreshToken) {
        throw unauthorized('TikTok Shop: the app key, app secret or the shop authorization is missing on this connector.');
      }
      // The seller's authorization has run out: no refresh can work.
      if (stored.refreshTokenExpiresAt && stored.refreshTokenExpiresAt <= now) {
        await this.markRefused(connectorId, stored.refreshToken, 'the authorization period ended');
      }

      let tokens: Tokens;
      try {
        tokens = tokensFrom(
          await this.tokenCall(TIKTOK_SHOP_REFRESH_PATH, {
            app_key: app.appKey,
            app_secret: app.appSecret,
            refresh_token: stored.refreshToken,
            grant_type: 'refresh_token',
          }),
        );
      } catch (err) {
        const reason = describeTikTokShopError(err);
        this.logger.warn(`Connector ${connectorId}: TikTok Shop token refresh failed (${reason})`);
        if (isTikTokShopRefreshRefused(err)) await this.markRefused(connectorId, stored.refreshToken, reason);
        throw unauthorized(`TikTok Shop: could not renew the shop's access token (${reason}). Try again in a few minutes.`);
      }

      const obtainedAt = Date.now();
      const token: ShopToken = {
        accessToken: tokens.accessToken,
        shopCipher: stored.shopCipher,
        expiresAt: tokens.expiresAt,
        lifetimeMs: tokens.expiresIn * 1000,
        obtainedAt,
      };
      // Store the refresh token TikTok sent back before the lock is
      // released, and again outside it if that write failed.
      const update = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        expiresAt: tokens.expiresAt,
        ...(tokens.refreshTokenExpiresAt ? { refreshTokenExpiresAt: tokens.refreshTokenExpiresAt } : {}),
        lastRefreshedAt: new Date(obtainedAt).toISOString(),
      };
      onRenewed({ token, update });
      const saved = await this.persist(db, connectorId, update);
      if (!saved) throw new Error('the renewed TikTok Shop token could not be stored');
      this.cache.set(connectorId, token);
      this.refused.delete(connectorId);
      await this.authStatus?.clear(connectorId);
      this.logger.debug(`Connector ${connectorId}: TikTok Shop access token renewed`);
      return token;
    });
  }

  /** Mark the connector needs_reauth for this refresh token and throw. */
  private async markRefused(connectorId: string, refreshToken: string, reason: string): Promise<never> {
    const message = authorizeAgainHint(connectorId, reason);
    this.refused.set(connectorId, { message, recheckAt: Date.now() + REFUSED_RECHECK_MS });
    this.cache.delete(connectorId);
    await this.authStatus?.mark(connectorId, {
      status: 'needs_reauth',
      code: 'refresh_refused',
      message,
      ref: credentialRef(refreshToken),
    });
    throw unauthorized(message, message);
  }

  /** A GET on TikTok's token endpoints (app key and secret in the query, as TikTok documents). */
  private async tokenCall(path: string, query: Record<string, string>): Promise<unknown> {
    const url = `${TIKTOK_SHOP_AUTH_HOST}${path}`;
    await assertSafeOutboundUrl(url);
    const res = await axios.get(url, {
      params: query,
      headers: { Accept: 'application/json' },
      timeout: HTTP_TIMEOUT_MS,
      ...outboundAxiosOptions({ credentialsInBody: true }),
    });
    return res.data;
  }

  /** Get Authorized Shops, signed, with the given access token. */
  private async fetchShops(app: TikTokShopApp, accessToken: string): Promise<TikTokShopInfo[]> {
    const timestamp = Math.floor(Date.now() / 1000);
    const query = { app_key: app.appKey, timestamp: String(timestamp) };
    const sign = tiktokShopSign({ secret: app.appSecret, path: TIKTOK_SHOP_AUTHORIZED_SHOPS_PATH, query });
    const url = `${app.apiHost}${TIKTOK_SHOP_AUTHORIZED_SHOPS_PATH}`;
    await assertSafeOutboundUrl(url);
    const res = await axios.get(url, {
      params: { ...query, sign },
      headers: { 'Content-Type': 'application/json', 'x-tts-access-token': accessToken },
      timeout: HTTP_TIMEOUT_MS,
      ...outboundAxiosOptions({ credentialsInBody: true }),
    });
    return shopsFrom(res.data);
  }

  private async loadFromDb(
    db: Db,
    connectorId: string,
  ): Promise<
    | {
        authConfig: Record<string, unknown>;
        status: { authStatus: string | null; authStatusRef: string | null; authStatusMessage: string | null };
      }
    | undefined
  > {
    try {
      const row = await db.connector.findUnique({
        where: { id: connectorId },
        select: { authConfig: true, envVars: true, authStatus: true, authStatusRef: true, authStatusMessage: true },
      });
      if (!row?.authConfig) return undefined;
      const envVars = (row.envVars as Record<string, string> | null) ?? {};
      return {
        authConfig: interpolateDeep(JSON.parse(decrypt(row.authConfig, this.encryptionKey)), envVars),
        status: {
          authStatus: row.authStatus ?? null,
          authStatusRef: row.authStatusRef ?? null,
          authStatusMessage: row.authStatusMessage ?? null,
        },
      };
    } catch (err: any) {
      this.logger.warn(`Connector ${connectorId}: could not read the stored TikTok Shop authorization (${err?.message ?? err})`);
      return undefined;
    }
  }

  /** Merge token fields into the stored (encrypted) authConfig. Undefined values remove the field. False when the write failed. */
  private async persist(db: Db, connectorId: string, patch: Record<string, unknown>): Promise<boolean> {
    try {
      const row = await db.connector.findUnique({ where: { id: connectorId }, select: { authConfig: true } });
      if (!row) return true; // deleted meanwhile
      const current = row.authConfig ? JSON.parse(decrypt(row.authConfig, this.encryptionKey)) : {};
      const next: Record<string, unknown> = { ...current };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete next[k];
        else next[k] = v;
      }
      await db.connector.update({
        where: { id: connectorId },
        data: { authConfig: encrypt(JSON.stringify(next), this.encryptionKey) },
      });
      return true;
    } catch (err: any) {
      this.logger.warn(`Connector ${connectorId}: could not store the TikTok Shop tokens (${err?.message ?? err})`);
      return false;
    }
  }

  /** `fn` under a Postgres advisory lock on the connector; unlocked when no transaction can be had. */
  private async withLock<T>(connectorId: string, fn: (db: Db) => Promise<T>): Promise<T> {
    const prisma = this.prisma as unknown as {
      $transaction?: (run: (tx: any) => Promise<T>, opts: { maxWait: number; timeout: number }) => Promise<T>;
    };
    if (typeof prisma.$transaction !== 'function') return fn(this.prisma);
    let started = false;
    try {
      return await prisma.$transaction(
        async (tx) => {
          started = true;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK_NAMESPACE + connectorId}))`;
          return fn(tx);
        },
        { maxWait: LOCK_MAX_WAIT_MS, timeout: LOCK_TIMEOUT_MS },
      );
    } catch (err) {
      if (started) throw err;
      return fn(this.prisma);
    }
  }
}

/** The authConfig fields of the chosen shop (all cleared when there is none). */
function shopFields(shop: TikTokShopInfo | undefined, shops: TikTokShopInfo[]): Record<string, unknown> {
  return {
    shopCipher: shop?.cipher,
    shopId: shop?.id,
    shopName: shop?.name,
    shopRegion: shop?.region,
    shopCode: shop?.code,
    shops: shops.length > 0 ? shops : undefined,
  };
}
