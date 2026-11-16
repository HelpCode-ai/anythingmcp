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
import { ResponseBodyError } from './response-error.util';
import { tokenFieldsAt, tokenResponsePathOf } from './token-response.util';

/**
 * Seller tokens of the Alibaba "IOP" open-platform gateways (Lazada, Miravia,
 * AliExpress).
 *
 * WHY. These gateways sign every call with the app secret (HMAC-SHA256 over
 * the API path and the parameters sorted by name, upper-case hex: the REST
 * engine already does that, see the comment above applyHmacSignature) and
 * authorize a seller with "code for token": the seller opens the gateway's
 * authorize page (`response_type=code`, `client_id` = app key,
 * `redirect_uri`, `state`), the gateway sends the browser back with `code`
 * and `state`, and the code is exchanged at the token-create operation
 * (`/auth/token/create`) for an access token and a refresh token, each with
 * its lifetime in seconds (`expires_in`, `refresh_expires_in`). The
 * token-refresh operation (`/auth/token/refresh`) renews the access token
 * until the refresh token expires; then the seller has to authorize again.
 *
 * A connector opts in with `authType: "HMAC"` and `authConfig.tokenProvider:
 * "iop"`. Nothing else uses this service. Where the gateway lives is
 * adapter configuration, not code per vendor:
 *
 *   authConfig.iop.appKey          the app key (`client_id`, signed `app_key`);
 *                                  default: signature.queryParams.app_key
 *   authConfig.iop.authorizeUrl    https URL of the seller authorize page
 *   authConfig.iop.tokenBaseUrl    https URL the token paths are appended to
 *   authConfig.iop.tokenPath       token-create operation (`/auth/token/create`)
 *   authConfig.iop.refreshPath     token-refresh operation (`/auth/token/refresh`)
 *   authConfig.iop.authorizeParams extra static query parameters of the
 *                                  authorize URL (`{ "force_auth": "true" }`)
 *   authConfig.iop.tokenResponsePath  optional dotted path of the object that
 *                                  holds the token fields, for a gateway that
 *                                  wraps them; unset, they are read at the top
 *                                  level (all three documented gateways)
 *
 * The token calls are signed with the connector's own `signature` block (its
 * secret, algorithm, `paramName`, `timestampParam` and static `queryParams`:
 * `app_key`, `sign_method`), always as an IOP *system* call: the operation's
 * path in front of the sorted parameters, whatever the business calls use
 * (AliExpress signs its `/sync` business calls without a path, but its
 * `/rest/auth/token/*` calls with one: "HTTP request sample", case 2). As the
 * official SDKs do, the system parameters (`app_key`, `sign_method`,
 * `timestamp`, `sign`) go in the query and the operation's own parameter
 * (`code` or `refresh_token`) in a form body, so it never sits in a URL.
 *
 * What it keeps, in the connector's encrypted authConfig (the same place and
 * field names as the Shopee and OAuth2 tokens, so the credential status and
 * the setup check read it the same way): accessToken, refreshToken,
 * expiresAt (ms epoch), expiresIn, refreshExpiresAt, refreshExpiresIn,
 * authorizedAt, lastRefreshedAt.
 *
 * Like ShopeeTokenService: renewed before it expires, one renewal at a time
 * per connector (in this process, and across processes under a Postgres
 * advisory lock, re-reading the stored refresh token inside it), and a
 * refresh token the gateway refuses (or that has expired by its own
 * lifetime) marks the connector needs_reauth, with one email to the owner,
 * until the seller authorizes again.
 *
 * Never logs a token, the app secret, a code or a signed URL.
 */

export const IOP_TOKEN_PROVIDER = 'iop';

/** Where the gateways send the seller back: register `<SERVER_URL>` + this as the app's callback URL. */
export const IOP_CALLBACK_PATH = '/api/iop-auth/callback';

/** Renew when fewer than this remain (or half the lifetime, if shorter). AliExpress suggests 30 minutes. */
const REFRESH_WINDOW_MS = 30 * 60 * 1000;
const HTTP_TIMEOUT_MS = 10_000;
const LOCK_NAMESPACE = 'amcp:iop-refresh:';
const LOCK_MAX_WAIT_MS = 3_000;
const LOCK_TIMEOUT_MS = 30_000;
/** After a refusal, calls fail at once for this long before the database is read again. */
const REFUSED_RECHECK_MS = 10 * 60 * 1000;

/** Whether a connector's auth gets its seller token from an IOP gateway. */
export function isIopAuth(authType: string | undefined, authConfig: unknown): boolean {
  return (
    authType === 'HMAC' &&
    !!authConfig &&
    typeof authConfig === 'object' &&
    (authConfig as { tokenProvider?: unknown }).tokenProvider === IOP_TOKEN_PROVIDER
  );
}

const usable = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && !/\{\{/.test(v);

/** Whether an IOP connector still needs the seller to authorize it (no usable token). */
export function iopNeedsAuthorization(authType: string | undefined, authConfig: unknown): boolean {
  if (!isIopAuth(authType, authConfig)) return false;
  const ac = authConfig as Record<string, unknown>;
  return !usable(ac.refreshToken) && !usable(ac.accessToken);
}

/**
 * The string an IOP system call signs: the operation's path, then every
 * parameter sorted by name (code unit order) as name + value with no
 * separators. The signature parameter and empty values are left out, as the
 * gateways' SDKs (and `${sortedParams}` in the REST engine) do.
 */
export function iopSignString(apiPath: string, params: Record<string, string>, signParam = 'sign'): string {
  return (
    apiPath +
    Object.keys(params)
      .filter((k) => k !== signParam && params[k] !== '' && params[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((k) => `${k}${params[k]}`)
      .join('')
  );
}

/** upper-case hex(HMAC(secret, apiPath + sorted parameters)). */
export function iopSign(
  secret: string,
  apiPath: string,
  params: Record<string, string>,
  algorithm = 'sha256',
  signParam = 'sign',
): string {
  return createHmac(algorithm, secret).update(iopSignString(apiPath, params, signParam), 'utf8').digest('hex').toUpperCase();
}

/** What the service needs to talk to one gateway for one connector. */
export interface IopApp {
  appKey: string;
  appSecret: string;
  /** e.g. https://auth.lazada.com/oauth/authorize */
  authorizeUrl: string;
  /** e.g. https://auth.lazada.com/rest */
  tokenBaseUrl: string;
  tokenPath: string;
  refreshPath: string;
  authorizeParams: Record<string, string>;
  /** HMAC algorithm (signature.algorithm), default sha256. */
  algorithm: string;
  /** Static query parameters every call signs (signature.queryParams): app_key, sign_method. */
  systemParams: Record<string, string>;
  /** The signature's query parameter (signature.paramName), default `sign`. */
  signParam: string;
  /** The timestamp's query parameter (signature.timestampParam), default `timestamp`. */
  timestampParam: string;
  tokenResponsePath?: string;
}

function httpsUrl(v: string): boolean {
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The gateway settings of an IOP connector from its resolved authConfig
 * (variables substituted). Undefined when a required one is missing, still a
 * `{{VAR}}`, or not an https URL / a path.
 */
export function iopAppFrom(authConfig: Record<string, unknown> | undefined): IopApp | undefined {
  if (!authConfig) return undefined;
  const iop = (authConfig.iop ?? {}) as Record<string, unknown>;
  const sig = (authConfig.signature ?? {}) as Record<string, unknown>;
  const statics = (sig.queryParams && typeof sig.queryParams === 'object' ? sig.queryParams : {}) as Record<string, unknown>;
  const text = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());
  const appKey = text(iop.appKey ?? statics.app_key);
  const appSecret = text(sig.secret);
  const authorizeUrl = text(iop.authorizeUrl);
  const tokenBaseUrl = text(iop.tokenBaseUrl).replace(/\/+$/, '');
  const tokenPath = text(iop.tokenPath);
  const refreshPath = text(iop.refreshPath);
  if (![appKey, appSecret, authorizeUrl, tokenBaseUrl, tokenPath, refreshPath].every(usable)) return undefined;
  if (!httpsUrl(authorizeUrl) || !httpsUrl(tokenBaseUrl)) return undefined;
  if (!tokenPath.startsWith('/') || !refreshPath.startsWith('/')) return undefined;
  const systemParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(statics)) {
    if (v !== undefined && v !== null) systemParams[k] = String(v);
  }
  systemParams.app_key = appKey;
  if (!systemParams.sign_method) systemParams.sign_method = 'sha256';
  if (Object.values(systemParams).some((v) => /\{\{/.test(v))) return undefined;
  const authorizeParams: Record<string, string> = {};
  if (iop.authorizeParams && typeof iop.authorizeParams === 'object' && !Array.isArray(iop.authorizeParams)) {
    for (const [k, v] of Object.entries(iop.authorizeParams as Record<string, unknown>)) {
      if (v !== undefined && v !== null) authorizeParams[k] = String(v);
    }
  }
  return {
    appKey,
    appSecret,
    authorizeUrl,
    tokenBaseUrl,
    tokenPath,
    refreshPath,
    authorizeParams,
    algorithm: text(sig.algorithm) || 'sha256',
    systemParams,
    signParam: text(sig.paramName) || 'sign',
    timestampParam: text(sig.timestampParam) || 'timestamp',
    tokenResponsePath: tokenResponsePathOf(iop.tokenResponsePath),
  };
}

/**
 * The link a seller opens to authorize the app: the gateway's authorize page
 * with the adapter's static parameters, then `response_type=code`,
 * `client_id`, `redirect_uri` and `state` (these four always win).
 */
export function buildIopAuthorizationUrl(app: IopApp, redirectUri: string, state: string): string {
  const url = new URL(app.authorizeUrl);
  for (const [k, v] of Object.entries(app.authorizeParams)) url.searchParams.set(k, v);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', app.appKey);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * A gateway answer that is an error: HTTP 4xx/5xx, or 2xx with a `code`
 * other than "0" (`{ "code": "IllegalRefreshToken", "type": "ISV",
 * "message": … }`), or AliExpress's `error_response`.
 */
export function iopError(err: unknown): { status?: number; code?: string; message?: string } | undefined {
  const res = (err as { response?: { status?: unknown; data?: unknown } })?.response;
  const data = (res?.data ?? (err as { responseBody?: unknown })?.responseBody) as Record<string, unknown> | undefined;
  const status = typeof res?.status === 'number' ? res.status : (err as { status?: unknown })?.status;
  if (!data || typeof data !== 'object') {
    return typeof status === 'number' ? { status } : undefined;
  }
  const wrapped = (data.error_response && typeof data.error_response === 'object' ? data.error_response : data) as Record<
    string,
    unknown
  >;
  const rawCode = wrapped.code;
  const code =
    (typeof rawCode === 'string' || typeof rawCode === 'number') && String(rawCode).trim() !== '' && String(rawCode) !== '0'
      ? String(rawCode).slice(0, 80)
      : undefined;
  const msg = wrapped.message ?? wrapped.msg;
  return {
    status: typeof status === 'number' ? status : undefined,
    code,
    message: typeof msg === 'string' && msg ? msg.slice(0, 200) : undefined,
  };
}

/**
 * Codes with which a gateway refuses a refresh token for good: wrong or
 * expired (`IllegalRefreshToken`, Lazada and AliExpress), or an app that can
 * only be authorized through the service market and has no refresh
 * (`AUTH_TYPE_UNSUPPORTED`). A 5xx, a network failure, a rate limit or a
 * wrong key or signature is not this.
 */
export function isIopRefreshRefused(err: unknown): boolean {
  const e = iopError(err);
  if (!e?.code) return false;
  if (typeof e.status === 'number' && e.status >= 500) return false;
  return /RefreshToken/i.test(e.code) || e.code === 'AUTH_TYPE_UNSUPPORTED';
}

/**
 * Whether a refused call may succeed with a renewed access token: the call
 * was answered 401 (an `errorWhen` rule with status 401, or HTTP 401) and
 * the gateway's code does not name the signature, the app key, the
 * timestamp or a permission, which a new token cannot fix.
 */
export function isIopAccessTokenRejected(err: unknown): boolean {
  const status =
    err instanceof ResponseBodyError
      ? err.status
      : (err as { response?: { status?: unknown } })?.response?.status;
  if (status !== 401) return false;
  const code = iopError(err)?.code ?? '';
  return !/Signature|AppKey|Timestamp|Permission|WhiteIp|InvalidCode/i.test(code);
}

/** A gateway failure in words safe to log and to show: status, the gateway's code and message. */
export function describeIopError(err: unknown): string {
  const e = iopError(err);
  if (e && (e.status !== undefined || e.code)) {
    return [e.status !== undefined ? `HTTP ${e.status}` : undefined, e.code, e.message].filter(Boolean).join(': ');
  }
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string') return code;
  const msg = (err as { message?: unknown })?.message;
  return typeof msg === 'string' && !/token|sign=|secret|code=/i.test(msg) ? msg.slice(0, 200) : 'network error';
}

interface SellerToken {
  accessToken: string;
  /** ms epoch; undefined when the gateway gave no lifetime (used until refused). */
  expiresAt?: number;
  lifetimeMs: number;
  obtainedAt: number;
}

/** The stored authorization of a connector, read from its authConfig. */
interface StoredAuth {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  expiresIn?: number;
  refreshExpiresAt?: number;
  refreshExpiresIn?: number;
  obtainedAt?: number;
}

/** What the token operations answered, checked. */
interface TokenAnswer {
  accessToken: string;
  refreshToken?: string;
  /** Seconds, from `expires_in`; else derived from `expire_time` (ms epoch, AliExpress). */
  expiresIn?: number;
  /** Seconds, from `refresh_expires_in` (0: cannot be refreshed); else from `refresh_token_valid_time`. */
  refreshExpiresIn?: number;
}

type Db = Pick<PrismaService, 'connector'>;
type Config = { baseUrl?: string; authConfig?: Record<string, unknown>; connectorId?: string };

function unauthorized(message: string, hint?: string): Error & { status: number; hint?: string } {
  const err = new Error(message) as Error & { status: number; hint?: string };
  err.status = 401;
  if (hint) err.hint = hint;
  return err;
}

function windowFor(lifetimeMs: number): number {
  return lifetimeMs > 0 ? Math.min(REFRESH_WINDOW_MS, lifetimeMs / 2) : REFRESH_WINDOW_MS;
}

const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

function readStored(authConfig: Record<string, unknown> | undefined): StoredAuth {
  const ac = authConfig ?? {};
  const str = (v: unknown) => (usable(v) ? v.trim() : undefined);
  const positive = (v: unknown) => {
    const n = num(v);
    return n !== undefined && n > 0 ? n : undefined;
  };
  return {
    accessToken: str(ac.accessToken),
    refreshToken: str(ac.refreshToken),
    expiresAt: positive(ac.expiresAt),
    expiresIn: positive(ac.expiresIn),
    refreshExpiresAt: positive(ac.refreshExpiresAt),
    refreshExpiresIn: num(ac.refreshExpiresIn),
    obtainedAt: Date.parse(String(ac.lastRefreshedAt ?? ac.authorizedAt ?? '')) || undefined,
  };
}

/** What a token operation answered, checked. Throws, shaped like an axios error, on an error answer. */
function tokensFrom(data: unknown, path: string | undefined, now: number): TokenAnswer {
  const e = iopError({ response: { status: 200, data } });
  if (e?.code) {
    const err = new Error(`The gateway refused the token request (${e.code})`) as Error & {
      response: { status: number; data: unknown };
    };
    err.response = { status: 200, data };
    throw err;
  }
  const d = path ? tokenFieldsAt(data, path) : ((data ?? {}) as Record<string, unknown>);
  if (!d || typeof d !== 'object') throw new Error(`the token answer has no object at "${path}" (authConfig.iop.tokenResponsePath)`);
  const accessToken = typeof d.access_token === 'string' ? d.access_token : '';
  if (!accessToken) throw new Error('the answer carried no access_token');
  const refreshToken = typeof d.refresh_token === 'string' && d.refresh_token ? d.refresh_token : undefined;
  // Relative lifetimes (seconds) first, as every gateway documents them;
  // AliExpress also sends absolute ms times, used only when those are absent.
  const relative = (v: unknown) => num(v);
  const fromAbsolute = (v: unknown) => {
    const at = num(v);
    return at !== undefined && at > now ? Math.floor((at - now) / 1000) : undefined;
  };
  const expiresIn = relative(d.expires_in) || fromAbsolute(d.expire_time);
  const refreshExpiresIn = relative(d.refresh_expires_in) ?? fromAbsolute(d.refresh_token_valid_time);
  return { accessToken, refreshToken, expiresIn: expiresIn && expiresIn > 0 ? expiresIn : undefined, refreshExpiresIn };
}

/** The token fields to store for an answer obtained at `at`. */
function storedFields(tokens: TokenAnswer, at: number): Record<string, unknown> {
  const out: Record<string, unknown> = {
    accessToken: tokens.accessToken,
    expiresIn: tokens.expiresIn,
    expiresAt: tokens.expiresIn ? at + tokens.expiresIn * 1000 : undefined,
  };
  // A refresh without a new refresh token keeps the stored one.
  if (tokens.refreshToken) out.refreshToken = tokens.refreshToken;
  if (tokens.refreshExpiresIn !== undefined) {
    out.refreshExpiresIn = tokens.refreshExpiresIn;
    out.refreshExpiresAt = tokens.refreshExpiresIn > 0 ? at + tokens.refreshExpiresIn * 1000 : undefined;
  }
  return out;
}

function authorizeAgainHint(connectorId: string | undefined, reason: string): string {
  const page = connectorPageUrl(connectorId);
  return (
    `The marketplace ${reason}, so no new access token can be obtained and retrying will not help. ` +
    `The seller has to authorize the app again: open the connector in AnythingMCP${page ? ` (${page})` : ''} ` +
    'and click Authorize with Provider.'
  );
}

@Injectable()
export class IopTokenService {
  private readonly logger = new Logger(IopTokenService.name);
  private readonly encryptionKey: string;

  private cache = new Map<string, SellerToken>();
  private inFlight = new Map<string, Promise<SellerToken>>();
  private refused = new Map<string, { message: string; recheckAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Optional() private readonly authStatus?: ConnectorAuthStatusService,
  ) {
    this.encryptionKey = getRequiredSecret('ENCRYPTION_KEY', this.configService.get<string>('ENCRYPTION_KEY'));
  }

  /**
   * The query parameter a seller call signs besides the app key, the
   * timestamp and the sign: `access_token`. Renews the token first when it
   * is about to expire. Throws (status 401) when the seller has not
   * authorized the app, or the refresh token expired or was refused.
   */
  async getCredentialParams(config: Config): Promise<{ access_token: string }> {
    const token = await this.getToken(config);
    return { access_token: token.accessToken };
  }

  /**
   * A new token after the gateway refused the one sent at `sentAt`. Takes a
   * token another call obtained since, else renews (one renewal for a
   * burst). Null when nothing better can be had: the caller then reports the
   * gateway's original refusal.
   */
  async renewAfterRejection(config: Config, sentAt: number): Promise<{ access_token: string } | null> {
    const { connectorId } = config;
    if (!connectorId) return null;
    if (this.refusedError(connectorId)) return null;
    const cached = this.cache.get(connectorId);
    if (cached && cached.obtainedAt >= sentAt && (cached.expiresAt === undefined || cached.expiresAt > Date.now())) {
      return { access_token: cached.accessToken };
    }
    this.cache.delete(connectorId);
    try {
      const token = await this.singleFlight(connectorId, () => this.refresh(config, connectorId, sentAt));
      return { access_token: token.accessToken };
    } catch {
      return null;
    }
  }

  /**
   * Exchange the code the gateway sent back after the seller authorized the
   * app, and store the tokens on the connector. Throws with the gateway's
   * answer when it refuses.
   */
  async exchangeCode(input: { connectorId: string; app: IopApp; code: string }): Promise<void> {
    const at = Date.now();
    const tokens = tokensFrom(await this.post(input.app, input.app.tokenPath, { code: input.code }), input.app.tokenResponsePath, at);
    const now = Date.now();
    await this.withLock(input.connectorId, async (db) => {
      const saved = await this.persist(db, input.connectorId, {
        // A new authorization replaces every stored token field.
        refreshToken: undefined,
        refreshExpiresIn: undefined,
        refreshExpiresAt: undefined,
        ...storedFields(tokens, now),
        authorizedAt: new Date(now).toISOString(),
        lastRefreshedAt: new Date(now).toISOString(),
      });
      if (!saved) throw new Error('the seller tokens could not be stored');
    });
    this.forget(input.connectorId);
    const lifetimeMs = (tokens.expiresIn ?? 0) * 1000;
    this.cache.set(input.connectorId, {
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresIn ? now + lifetimeMs : undefined,
      lifetimeMs,
      obtainedAt: now,
    });
    await this.authStatus?.clear(input.connectorId);
    this.logger.log(`Connector ${input.connectorId}: seller authorized at the IOP gateway`);
  }

  /** The credentials changed (a new authorization, new app keys): start over. */
  forget(connectorId: string): void {
    this.cache.delete(connectorId);
    this.refused.delete(connectorId);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async getToken(config: Config): Promise<SellerToken> {
    const { connectorId } = config;
    const now = Date.now();
    if (connectorId) {
      const cached = this.cache.get(connectorId);
      if (cached && (cached.expiresAt === undefined || cached.expiresAt > now + windowFor(cached.lifetimeMs))) {
        return cached;
      }
      const refused = this.refusedError(connectorId);
      if (refused) throw refused;
    }

    const stored = readStored(config.authConfig);
    if (!stored.accessToken && !stored.refreshToken) {
      const page = connectorPageUrl(connectorId);
      throw unauthorized(
        'The seller has not authorized this connector yet. No request was sent to the marketplace. ' +
          `Open the connector in AnythingMCP${page ? ` (${page})` : ''} and click Authorize with Provider.`,
      );
    }
    const lifetimeMs = (stored.expiresIn ?? 0) * 1000;
    const snapshot: SellerToken | undefined = stored.accessToken
      ? {
          accessToken: stored.accessToken,
          expiresAt: stored.expiresAt,
          lifetimeMs,
          obtainedAt: stored.obtainedAt ?? (stored.expiresAt ? stored.expiresAt - lifetimeMs : 0),
        }
      : undefined;
    // No known expiry: used until the gateway refuses it (renewAfterRejection).
    if (snapshot && (snapshot.expiresAt === undefined || snapshot.expiresAt > now + windowFor(lifetimeMs))) {
      if (connectorId) this.cache.set(connectorId, snapshot);
      return snapshot;
    }
    // Without a saved connector nothing can be stored, so nothing is renewed either.
    if (!connectorId || !stored.refreshToken) {
      if (snapshot?.expiresAt && snapshot.expiresAt > now) return snapshot;
      throw unauthorized(
        'The access token has expired and this connector cannot renew it. The seller has to authorize the app again (Authorize with Provider).',
      );
    }
    return this.singleFlight(connectorId, () => this.refresh(config, connectorId)).catch((err) => {
      // The gateway was unreachable or answered 5xx: an access token that is
      // still valid for a few minutes is better than none.
      if (snapshot?.expiresAt && snapshot.expiresAt > Date.now() && !this.refused.has(connectorId)) return snapshot;
      throw err;
    });
  }

  private singleFlight(connectorId: string, fn: () => Promise<SellerToken>): Promise<SellerToken> {
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
    return unauthorized(`No request was sent to the marketplace. ${entry.message}`, entry.message);
  }

  /** Records a refresh token that can never work again: needs_reauth, one email, calls fail fast. */
  private async markRefused(connectorId: string, refreshToken: string, code: string, message: string): Promise<never> {
    this.refused.set(connectorId, { message, recheckAt: Date.now() + REFUSED_RECHECK_MS });
    this.cache.delete(connectorId);
    await this.authStatus?.mark(connectorId, {
      status: 'needs_reauth',
      code,
      message,
      ref: credentialRef(refreshToken),
    });
    throw unauthorized(message, message);
  }

  /**
   * Renew under the connector's lock. The refresh token is read from the
   * database inside the lock: another process may have renewed a moment
   * ago, and then its fresh access token is taken instead of spending one.
   */
  private async refresh(config: Config, connectorId: string, rejectedAt?: number): Promise<SellerToken> {
    // A renewal the gateway already made, and the write that keeps it: if
    // the transaction fails after the gateway answered, it is stored again
    // outside, or the connector is left holding a refresh token that may
    // have been replaced.
    let pending: { token: SellerToken; update: Record<string, unknown> } | undefined;
    try {
      return await this.refreshLocked(config, connectorId, rejectedAt, (p) => (pending = p));
    } catch (err) {
      if (!pending) throw err;
      this.logger.warn(`Connector ${connectorId}: the renewed IOP token was not stored under the lock; storing it again`);
      await this.persist(this.prisma, connectorId, pending.update);
      this.cache.set(connectorId, pending.token);
      return pending.token;
    }
  }

  private async refreshLocked(
    config: Config,
    connectorId: string,
    rejectedAt: number | undefined,
    onRenewed: (p: { token: SellerToken; update: Record<string, unknown> }) => void,
  ): Promise<SellerToken> {
    return this.withLock(connectorId, async (db) => {
      const fresh = await this.loadFromDb(db, connectorId);
      const authConfig = fresh?.authConfig ?? config.authConfig;
      const stored = readStored(authConfig);
      const now = Date.now();
      const lifetimeMs = (stored.expiresIn ?? 0) * 1000;

      // Renewed by another process (or authorized again) meanwhile.
      if (stored.accessToken && stored.expiresAt) {
        const obtainedAt = stored.obtainedAt ?? 0;
        const fine =
          rejectedAt !== undefined
            ? obtainedAt > rejectedAt && stored.expiresAt > now
            : stored.expiresAt > now + windowFor(lifetimeMs);
        if (fine) {
          const token = { accessToken: stored.accessToken, expiresAt: stored.expiresAt, lifetimeMs, obtainedAt };
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
        const message = status.authStatusMessage || authorizeAgainHint(connectorId, 'refused the refresh token');
        this.refused.set(connectorId, { message, recheckAt: now + REFUSED_RECHECK_MS });
        throw unauthorized(message, message);
      }

      const app = iopAppFrom(authConfig);
      if (!app || !stored.refreshToken) {
        throw unauthorized(
          'The app key, the app secret, the gateway settings (authConfig.iop) or the seller authorization is missing on this connector.',
        );
      }

      // The gateway's own lifetime says the refresh token is spent: asking
      // would only be refused.
      if (stored.refreshExpiresIn === 0 || (stored.refreshExpiresAt !== undefined && stored.refreshExpiresAt <= now)) {
        const reason =
          stored.refreshExpiresIn === 0
            ? 'issued a refresh token that cannot be used (refresh_expires_in 0)'
            : `let the refresh token expire on ${new Date(stored.refreshExpiresAt!).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
        this.logger.warn(`Connector ${connectorId}: the IOP refresh token has expired; the seller has to authorize again`);
        return this.markRefused(connectorId, stored.refreshToken, 'refresh_expired', authorizeAgainHint(connectorId, reason));
      }

      let tokens: TokenAnswer;
      try {
        tokens = tokensFrom(
          await this.post(app, app.refreshPath, { refresh_token: stored.refreshToken }),
          app.tokenResponsePath,
          Date.now(),
        );
      } catch (err) {
        const reason = describeIopError(err);
        this.logger.warn(`Connector ${connectorId}: IOP token refresh failed (${reason})`);
        if (isIopRefreshRefused(err)) {
          return this.markRefused(
            connectorId,
            stored.refreshToken,
            'refresh_refused',
            authorizeAgainHint(connectorId, `refused the refresh token (${reason}): it expired or the seller revoked the authorization`),
          );
        }
        throw unauthorized(`Could not renew the seller's access token (${reason}). Try again in a few minutes.`);
      }

      const obtainedAt = Date.now();
      const update = { ...storedFields(tokens, obtainedAt), lastRefreshedAt: new Date(obtainedAt).toISOString() };
      const token: SellerToken = {
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresIn ? obtainedAt + tokens.expiresIn * 1000 : undefined,
        lifetimeMs: (tokens.expiresIn ?? 0) * 1000,
        obtainedAt,
      };
      onRenewed({ token, update });
      const saved = await this.persist(db, connectorId, update);
      if (!saved) throw new Error('the renewed IOP token could not be stored');
      this.cache.set(connectorId, token);
      this.refused.delete(connectorId);
      await this.authStatus?.clear(connectorId);
      this.logger.debug(`Connector ${connectorId}: IOP access token renewed`);
      return token;
    });
  }

  /**
   * A signed system call (token operations): app_key, sign_method,
   * timestamp and sign in the query, the operation's own parameter in a
   * form body; the path in front of the signed string.
   */
  private async post(app: IopApp, path: string, own: Record<string, string>): Promise<unknown> {
    const query: Record<string, string> = { ...app.systemParams, [app.timestampParam]: String(Date.now()) };
    query[app.signParam] = iopSign(app.appSecret, path, { ...query, ...own }, app.algorithm, app.signParam);
    const url = `${app.tokenBaseUrl}${path}`;
    await assertSafeOutboundUrl(url);
    const res = await axios.post(url, new URLSearchParams(own).toString(), {
      params: query,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8', Accept: 'application/json' },
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
      this.logger.warn(`Connector ${connectorId}: could not read the stored IOP authorization (${err?.message ?? err})`);
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
      this.logger.warn(`Connector ${connectorId}: could not store the IOP tokens (${err?.message ?? err})`);
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
