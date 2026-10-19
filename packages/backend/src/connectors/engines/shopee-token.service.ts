import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../../common/prisma.service';
import { decrypt, encrypt } from '../../common/crypto/encryption.util';
import { getRequiredSecret } from '../../common/secrets.util';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { outboundAxiosOptions } from '../../common/outbound-http';
import { connectorPageUrl } from '../../common/url.util';
import { ConnectorAuthStatusService, credentialRef } from './connector-auth-status.service';

/**
 * Shopee Open Platform (API v2) shop tokens.
 *
 * WHY. Shopee signs every call with the partner key (HMAC-SHA256 over the
 * partner id, the API path, a timestamp and, for shop calls, the access token
 * and shop id) and authorizes a shop with its own flow rather than OAuth 2:
 * the seller opens a signed `auth_partner` link, Shopee sends the browser back
 * with `code` and `shop_id`, and the code is exchanged at
 * `/api/v2/auth/token/get` for an access token (about 4 hours) and a refresh
 * token (about 30 days). `/api/v2/auth/access_token/get` renews both, and the
 * refresh token rotates: the one just spent is no good again, so the new one
 * has to be stored before anything else happens.
 *
 * A connector opts in with `authType: "HMAC"` and `authConfig.tokenProvider:
 * "shopee"`. Nothing else uses this service.
 *
 * What it keeps, in the connector's encrypted authConfig (the same place and
 * field names as OAuth2 tokens, so the credential status and the setup check
 * read it the same way): accessToken, refreshToken, expiresAt (ms epoch),
 * expiresIn, shopId, authorizedAt, lastRefreshedAt.
 *
 * Like OAuth2TokenService: renewed before it expires, one renewal at a time
 * per connector (in this process, and across processes under a Postgres
 * advisory lock, re-reading the stored refresh token inside it), and a refresh
 * token Shopee refuses marks the connector needs_reauth, with one email to
 * the owner, until the shop is authorized again.
 *
 * Never logs a token, the partner key or a signed URL.
 */

export const SHOPEE_TOKEN_PROVIDER = 'shopee';

export const SHOPEE_AUTH_PARTNER_PATH = '/api/v2/shop/auth_partner';
export const SHOPEE_TOKEN_GET_PATH = '/api/v2/auth/token/get';
export const SHOPEE_REFRESH_PATH = '/api/v2/auth/access_token/get';

/** Renew when fewer than this remain (or half the lifetime, if shorter). */
const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_ACCESS_LIFETIME_S = 4 * 60 * 60;
const HTTP_TIMEOUT_MS = 10_000;
const LOCK_NAMESPACE = 'amcp:shopee-refresh:';
const LOCK_MAX_WAIT_MS = 3_000;
const LOCK_TIMEOUT_MS = 30_000;
/** After a refusal, calls fail at once for this long before the database is read again. */
const REFUSED_RECHECK_MS = 10 * 60 * 1000;

/** Whether a connector's auth is a Shopee shop authorization. */
export function isShopeeAuth(authType: string | undefined, authConfig: unknown): boolean {
  return (
    authType === 'HMAC' &&
    !!authConfig &&
    typeof authConfig === 'object' &&
    (authConfig as { tokenProvider?: unknown }).tokenProvider === SHOPEE_TOKEN_PROVIDER
  );
}

/** Whether a Shopee connector still needs its shop authorized (no usable token). */
export function shopeeNeedsAuthorization(authType: string | undefined, authConfig: unknown): boolean {
  if (!isShopeeAuth(authType, authConfig)) return false;
  const ac = authConfig as Record<string, unknown>;
  const usable = (v: unknown) => typeof v === 'string' && v.trim() !== '' && !/\{\{/.test(v);
  return !usable(ac.refreshToken) && !usable(ac.accessToken);
}

/** hex(HMAC-SHA256(partner_key, base)), as Shopee signs everything. */
export function shopeeSign(partnerKey: string, base: string): string {
  return createHmac('sha256', partnerKey).update(base, 'utf8').digest('hex');
}

/**
 * The base string Shopee signs: partner_id + api_path + timestamp, then
 * access_token + shop_id for shop calls. `path` is the path only
 * (`/api/v2/shop/get_shop_info`), never the host or the query.
 */
export function shopeeBaseString(input: {
  partnerId: string | number;
  path: string;
  timestamp: number | string;
  accessToken?: string;
  shopId?: string | number;
}): string {
  return (
    `${input.partnerId}${input.path}${input.timestamp}` +
    (input.accessToken !== undefined ? `${input.accessToken}${input.shopId ?? ''}` : '')
  );
}

/** What the service needs to talk to Shopee for one connector. */
export interface ShopeeApp {
  /** e.g. https://partner.shopeemobile.com (no path). */
  host: string;
  partnerId: string;
  partnerKey: string;
}

/**
 * The app settings of a Shopee connector from its resolved authConfig and
 * base URL: the partner id (authConfig.partnerId, else the signed
 * partner_id query parameter), the partner key (the signature secret) and the
 * host (the base URL's origin). Undefined when one is missing.
 */
export function shopeeAppFrom(
  authConfig: Record<string, unknown> | undefined,
  baseUrl: string | undefined,
): ShopeeApp | undefined {
  if (!authConfig) return undefined;
  const sig = (authConfig.signature ?? {}) as Record<string, unknown>;
  const query = (sig.queryParams ?? {}) as Record<string, unknown>;
  const partnerId = String(authConfig.partnerId ?? query.partner_id ?? '').trim();
  const partnerKey = String(sig.secret ?? '').trim();
  let host = '';
  try {
    host = new URL(String(baseUrl ?? '')).origin;
  } catch {
    host = '';
  }
  const unresolved = (v: string) => !v || /\{\{/.test(v);
  if (unresolved(partnerId) || unresolved(partnerKey) || !host || host === 'null') return undefined;
  return { host, partnerId, partnerKey };
}

/**
 * The link a seller opens to authorize the shop. Signed as a public call over
 * `/api/v2/shop/auth_partner`; Shopee sends the browser to `redirect` with
 * `code` and `shop_id`.
 */
export function buildShopeeAuthorizationUrl(app: ShopeeApp, redirect: string, now = Date.now()): string {
  const timestamp = Math.floor(now / 1000);
  const sign = shopeeSign(
    app.partnerKey,
    shopeeBaseString({ partnerId: app.partnerId, path: SHOPEE_AUTH_PARTNER_PATH, timestamp }),
  );
  const q = new URLSearchParams({
    partner_id: app.partnerId,
    timestamp: String(timestamp),
    sign,
    redirect,
  });
  return `${app.host}${SHOPEE_AUTH_PARTNER_PATH}?${q.toString()}`;
}

/** A Shopee API answer that is an error: HTTP 4xx/5xx, or 2xx with a non-empty `error`. */
export function shopeeError(err: unknown): { status?: number; error?: string; message?: string } | undefined {
  const res = (err as { response?: { status?: unknown; data?: unknown } })?.response;
  const data = (res?.data ?? (err as { responseBody?: unknown })?.responseBody) as
    | { error?: unknown; message?: unknown; msg?: unknown }
    | undefined;
  const status = typeof res?.status === 'number' ? res.status : (err as { status?: unknown })?.status;
  if (!data || typeof data !== 'object') {
    return typeof status === 'number' ? { status } : undefined;
  }
  return {
    status: typeof status === 'number' ? status : undefined,
    error: typeof data.error === 'string' && data.error ? data.error.slice(0, 80) : undefined,
    message:
      typeof data.message === 'string' && data.message
        ? data.message.slice(0, 200)
        : typeof data.msg === 'string'
          ? data.msg.slice(0, 200)
          : undefined,
  };
}

/**
 * Shopee refused the access token of a shop call (expired, or replaced by a
 * renewal elsewhere), so a fresh one may fix it: `invalid_acceess_token`
 * (Shopee's spelling; `invalid_access_token` accepted too), the older
 * `error_auth` "Invalid access_token", and an expired shop authorization,
 * which the renewal then reports as refused.
 */
export function isShopeeAccessTokenRejected(err: unknown): boolean {
  const e = shopeeError(err);
  if (!e?.error) return false;
  if (/^invalid_ac+e+s+_token$/i.test(e.error)) return true;
  if (e.error === 'shop_access_expired') return true;
  return e.error === 'error_auth' && /access[_ ]?token/i.test(e.message ?? '');
}

/**
 * Error codes with which Shopee refuses a refresh token for good: wrong or
 * already rotated (`error_shop_refresh_token`), expired after 30 days
 * (`refresh_token_expired`), the shop's authorization expired or was
 * cancelled (`shop_access_expired`, `shop_no_linked`), or the shop is banned.
 * Shopee is replacing the generic `error_auth` with these; the old form is
 * read from its message.
 */
const SHOPEE_REFRESH_REFUSED = new Set([
  'error_shop_refresh_token',
  'error_merchant_refresh_token',
  'refresh_token_expired',
  'shop_access_expired',
  'merchant_access_expired',
  'shop_no_linked',
  'merchant_no_linked',
  'shop_banned',
]);

/**
 * Shopee refused the refresh token itself: no retry can work until the shop
 * is authorized again. A 5xx, a network failure, a rate limit or a wrong
 * partner key (`error_sign`, `invalid_partner_id`) is not this.
 */
export function isShopeeRefreshRefused(err: unknown): boolean {
  const e = shopeeError(err);
  if (!e?.error) return false;
  if (typeof e.status === 'number' && e.status >= 500) return false;
  if (SHOPEE_REFRESH_REFUSED.has(e.error)) return true;
  return e.error === 'error_auth' && /refresh[_ ]?token/i.test(e.message ?? '');
}

/** A Shopee failure in words safe to log and to show: status, Shopee's code and message. */
export function describeShopeeError(err: unknown): string {
  const e = shopeeError(err);
  if (e && (e.status !== undefined || e.error)) {
    return [e.status !== undefined ? `HTTP ${e.status}` : undefined, e.error, e.message].filter(Boolean).join(': ');
  }
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string') return code;
  const msg = (err as { message?: unknown })?.message;
  return typeof msg === 'string' && !/token|sign=|partner_key/i.test(msg) ? msg.slice(0, 200) : 'network error';
}

interface ShopToken {
  accessToken: string;
  shopId: string;
  expiresAt: number;
  lifetimeMs: number;
  obtainedAt: number;
}

/** The stored authorization of a connector, read from its authConfig. */
interface StoredAuth {
  accessToken?: string;
  refreshToken?: string;
  shopId?: string;
  expiresAt?: number;
  expiresIn?: number;
  obtainedAt?: number;
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

function readStored(authConfig: Record<string, unknown> | undefined): StoredAuth {
  const ac = authConfig ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() && !/\{\{/.test(v) ? v.trim() : undefined);
  const num = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  const shop = ac.shopId ?? ac.shop_id;
  return {
    accessToken: str(ac.accessToken),
    refreshToken: str(ac.refreshToken),
    shopId: shop !== undefined && shop !== null && String(shop).trim() ? String(shop).trim() : undefined,
    expiresAt: num(ac.expiresAt),
    expiresIn: num(ac.expiresIn),
    obtainedAt: Date.parse(String(ac.lastRefreshedAt ?? ac.authorizedAt ?? '')) || undefined,
  };
}

/** What Shopee's token endpoints answer, checked. Throws on an error answer. */
function tokensFrom(data: unknown): { accessToken: string; refreshToken: string; expiresIn: number } {
  const d = (data ?? {}) as Record<string, unknown>;
  if (typeof d.error === 'string' && d.error) {
    // Shaped like an axios error so the classifiers above read it the same way.
    const err = new Error(`Shopee refused the token request (${d.error})`) as Error & {
      response: { status: number; data: unknown };
    };
    err.response = { status: 200, data: d };
    throw err;
  }
  const accessToken = typeof d.access_token === 'string' ? d.access_token : '';
  const refreshToken = typeof d.refresh_token === 'string' ? d.refresh_token : '';
  if (!accessToken || !refreshToken) throw new Error('the answer carried no access_token or refresh_token');
  const expiresIn = Number(d.expire_in ?? d.expires_in);
  return { accessToken, refreshToken, expiresIn: expiresIn > 0 ? expiresIn : DEFAULT_ACCESS_LIFETIME_S };
}

function authorizeAgainHint(connectorId: string | undefined, reason?: string): string {
  const page = connectorPageUrl(connectorId);
  return (
    `Shopee refused the shop's refresh token${reason ? ` (${reason})` : ''}: it expired (it lasts about 30 days ` +
    'without a call), was already used, or the shop cancelled or let its authorization expire. Retrying will not ' +
    `help. Open the connector in AnythingMCP${page ? ` (${page})` : ''} and click Authorize with Provider again.`
  );
}

@Injectable()
export class ShopeeTokenService {
  private readonly logger = new Logger(ShopeeTokenService.name);
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
   * The query parameters a shop call carries besides the partner id,
   * timestamp and sign: `access_token` and `shop_id`. Renews the token first
   * when it is about to expire. Throws (status 401) when the shop has not
   * been authorized, or its refresh token was refused.
   */
  async getShopParams(
    config: { baseUrl: string; authConfig?: Record<string, unknown>; connectorId?: string },
  ): Promise<{ access_token: string; shop_id: string }> {
    const token = await this.getToken(config);
    return { access_token: token.accessToken, shop_id: token.shopId };
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
    if (!stored.shopId || (!stored.accessToken && !stored.refreshToken)) {
      const page = connectorPageUrl(connectorId);
      throw unauthorized(
        'Shopee: this shop has not been authorized yet. No request was sent to Shopee. ' +
          `Open the connector in AnythingMCP${page ? ` (${page})` : ''} and click Authorize with Provider.`,
      );
    }
    const lifetimeMs = (stored.expiresIn ?? DEFAULT_ACCESS_LIFETIME_S) * 1000;
    const snapshot: ShopToken | undefined =
      stored.accessToken && stored.expiresAt
        ? {
            accessToken: stored.accessToken,
            shopId: stored.shopId,
            expiresAt: stored.expiresAt,
            lifetimeMs,
            obtainedAt: stored.obtainedAt ?? stored.expiresAt - lifetimeMs,
          }
        : undefined;
    if (snapshot && snapshot.expiresAt > now + windowFor(lifetimeMs)) {
      if (connectorId) this.cache.set(connectorId, snapshot);
      return snapshot;
    }
    // Without a saved connector (a call whose credentials depend on the
    // caller), nothing can be stored, so nothing is renewed either.
    if (!connectorId || !stored.refreshToken) {
      if (snapshot && snapshot.expiresAt > now) return snapshot;
      throw unauthorized(
        'Shopee: the access token has expired and this connector cannot renew it. Authorize the shop again.',
      );
    }
    return this.singleFlight(connectorId, () => this.refresh(config, connectorId)).catch((err) => {
      // Shopee was unreachable or answered 5xx: an access token that is
      // still valid for a few minutes is better than none.
      if (snapshot && snapshot.expiresAt > Date.now() && !this.refused.has(connectorId)) return snapshot;
      throw err;
    });
  }

  /**
   * A new token after Shopee refused the one sent at `sentAt`. Takes a token
   * another call obtained since, else renews (one renewal for a burst).
   */
  async renewAfterRejection(
    config: { baseUrl: string; authConfig?: Record<string, unknown>; connectorId?: string },
    sentAt: number,
  ): Promise<{ access_token: string; shop_id: string } | null> {
    const { connectorId } = config;
    if (!connectorId) return null;
    // Refused a moment ago: not again.
    if (this.refusedError(connectorId)) return null;
    const cached = this.cache.get(connectorId);
    if (cached && cached.obtainedAt >= sentAt && cached.expiresAt > Date.now()) {
      return { access_token: cached.accessToken, shop_id: cached.shopId };
    }
    this.cache.delete(connectorId);
    try {
      const token = await this.singleFlight(connectorId, () => this.refresh(config, connectorId, sentAt));
      return { access_token: token.accessToken, shop_id: token.shopId };
    } catch {
      return null;
    }
  }

  /**
   * Exchange the code Shopee sent back after the seller authorized the shop,
   * and store the tokens on the connector. Throws with Shopee's answer when
   * it refuses.
   */
  async exchangeCode(input: { connectorId: string; app: ShopeeApp; code: string; shopId: string }): Promise<void> {
    const shopId = Number(input.shopId);
    if (!Number.isSafeInteger(shopId) || shopId <= 0) throw new Error('Shopee sent back no valid shop_id.');
    const data = await this.post(input.app, SHOPEE_TOKEN_GET_PATH, {
      code: input.code,
      shop_id: shopId,
      partner_id: Number(input.app.partnerId),
    });
    const tokens = tokensFrom(data);
    const now = Date.now();
    await this.withLock(input.connectorId, async (db) => {
      const saved = await this.persist(db, input.connectorId, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        expiresAt: now + tokens.expiresIn * 1000,
        shopId: String(shopId),
        authorizedAt: new Date(now).toISOString(),
      });
      if (!saved) throw new Error('the shop tokens could not be stored');
    });
    this.forget(input.connectorId);
    this.cache.set(input.connectorId, {
      accessToken: tokens.accessToken,
      shopId: String(shopId),
      expiresAt: now + tokens.expiresIn * 1000,
      lifetimeMs: tokens.expiresIn * 1000,
      obtainedAt: now,
    });
    await this.authStatus?.clear(input.connectorId);
    this.logger.log(`Connector ${input.connectorId}: Shopee shop authorized`);
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
      `Shopee: the shop's refresh token was refused, so no new access token can be obtained. No request was sent to Shopee. ${entry.message}`,
      entry.message,
    );
  }

  /**
   * Renew under the connector's lock. The refresh token is read from the
   * database inside the lock: another process may have rotated it a moment
   * ago, and then its fresh access token is taken instead of spending one.
   */
  private async refresh(
    config: { baseUrl: string; authConfig?: Record<string, unknown> },
    connectorId: string,
    rejectedAt?: number,
  ): Promise<ShopToken> {
    // A rotation Shopee already made, and the write that keeps it: if the
    // transaction fails after Shopee answered, it is stored again outside,
    // or the connector is left holding a refresh token Shopee revoked.
    let pending: { token: ShopToken; update: Record<string, unknown> } | undefined;
    try {
      return await this.refreshLocked(config, connectorId, rejectedAt, (p) => (pending = p));
    } catch (err) {
      if (!pending) throw err;
      this.logger.warn(`Connector ${connectorId}: the renewed Shopee token was not stored under the lock; storing it again`);
      await this.persist(this.prisma, connectorId, pending.update);
      this.cache.set(connectorId, pending.token);
      return pending.token;
    }
  }

  private async refreshLocked(
    config: { baseUrl: string; authConfig?: Record<string, unknown> },
    connectorId: string,
    rejectedAt: number | undefined,
    onRotated: (p: { token: ShopToken; update: Record<string, unknown> }) => void,
  ): Promise<ShopToken> {
    return this.withLock(connectorId, async (db) => {
      const fresh = await this.loadFromDb(db, connectorId);
      const authConfig = fresh?.authConfig ?? config.authConfig;
      const stored = readStored(authConfig);
      const now = Date.now();
      const lifetimeMs = (stored.expiresIn ?? DEFAULT_ACCESS_LIFETIME_S) * 1000;

      // Renewed by another process (or authorized again) meanwhile.
      if (stored.accessToken && stored.expiresAt && stored.shopId) {
        const obtainedAt = stored.obtainedAt ?? 0;
        const usable =
          rejectedAt !== undefined
            ? obtainedAt > rejectedAt && stored.expiresAt > now
            : stored.expiresAt > now + windowFor(lifetimeMs);
        if (usable) {
          const token = { accessToken: stored.accessToken, shopId: stored.shopId, expiresAt: stored.expiresAt, lifetimeMs, obtainedAt };
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

      const app = shopeeAppFrom(authConfig, config.baseUrl);
      if (!app || !stored.refreshToken || !stored.shopId) {
        throw unauthorized('Shopee: the partner id, partner key or the shop authorization is missing on this connector.');
      }

      let tokens: ReturnType<typeof tokensFrom>;
      try {
        tokens = tokensFrom(
          await this.post(app, SHOPEE_REFRESH_PATH, {
            refresh_token: stored.refreshToken,
            shop_id: Number(stored.shopId),
            partner_id: Number(app.partnerId),
          }),
        );
      } catch (err) {
        const reason = describeShopeeError(err);
        this.logger.warn(`Connector ${connectorId}: Shopee token refresh failed (${reason})`);
        if (isShopeeRefreshRefused(err)) {
          const message = authorizeAgainHint(connectorId, reason);
          this.refused.set(connectorId, { message, recheckAt: Date.now() + REFUSED_RECHECK_MS });
          this.cache.delete(connectorId);
          await this.authStatus?.mark(connectorId, {
            status: 'needs_reauth',
            code: 'refresh_refused',
            message,
            ref: credentialRef(stored.refreshToken),
          });
          throw unauthorized(message, message);
        }
        throw unauthorized(`Shopee: could not renew the shop's access token (${reason}). Try again in a few minutes.`);
      }

      const obtainedAt = Date.now();
      const token: ShopToken = {
        accessToken: tokens.accessToken,
        shopId: stored.shopId,
        expiresAt: obtainedAt + tokens.expiresIn * 1000,
        lifetimeMs: tokens.expiresIn * 1000,
        obtainedAt,
      };
      // The refresh token just spent is dead: store the new one before the
      // lock is released, and again outside it if that write failed.
      const update = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        expiresAt: token.expiresAt,
        lastRefreshedAt: new Date(obtainedAt).toISOString(),
      };
      onRotated({ token, update });
      const saved = await this.persist(db, connectorId, update);
      if (!saved) throw new Error('the renewed Shopee token could not be stored');
      this.cache.set(connectorId, token);
      this.refused.delete(connectorId);
      await this.authStatus?.clear(connectorId);
      this.logger.debug(`Connector ${connectorId}: Shopee access token renewed`);
      return token;
    });
  }

  /** A signed public call (token endpoints): partner_id, timestamp and sign in the query, JSON body. */
  private async post(app: ShopeeApp, path: string, body: Record<string, unknown>): Promise<unknown> {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = shopeeSign(app.partnerKey, shopeeBaseString({ partnerId: app.partnerId, path, timestamp }));
    const url = `${app.host}${path}`;
    await assertSafeOutboundUrl(url);
    const res = await axios.post(url, body, {
      params: { partner_id: app.partnerId, timestamp, sign },
      headers: { 'Content-Type': 'application/json' },
      timeout: HTTP_TIMEOUT_MS,
      ...outboundAxiosOptions({ credentialsInBody: true }),
    });
    return res.data;
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
      this.logger.warn(`Connector ${connectorId}: could not read the stored Shopee authorization (${err?.message ?? err})`);
      return undefined;
    }
  }

  /** Merge token fields into the stored (encrypted) authConfig. False when the write failed. */
  private async persist(db: Db, connectorId: string, patch: Record<string, unknown>): Promise<boolean> {
    try {
      const row = await db.connector.findUnique({ where: { id: connectorId }, select: { authConfig: true } });
      if (!row) return true; // deleted meanwhile
      const current = row.authConfig ? JSON.parse(decrypt(row.authConfig, this.encryptionKey)) : {};
      await db.connector.update({
        where: { id: connectorId },
        data: { authConfig: encrypt(JSON.stringify({ ...current, ...patch }), this.encryptionKey) },
      });
      return true;
    } catch (err: any) {
      this.logger.warn(`Connector ${connectorId}: could not store the Shopee tokens (${err?.message ?? err})`);
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
