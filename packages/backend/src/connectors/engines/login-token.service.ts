import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { type AxiosResponse } from 'axios';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../common/prisma.service';
import { encrypt, decrypt } from '../../common/crypto/encryption.util';
import { getRequiredSecret } from '../../common/secrets.util';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';
import { outboundAxiosOptions } from '../../common/outbound-http';
import { urlForLog } from '../../common/log-safe-url.util';
import { createUnblockerProxyAgent } from './unblocker-proxy-agent';
import { ClientAssertionError, signJwt } from './client-assertion.util';
import { findUnresolvedPlaceholders } from '../../common/unresolved-placeholders.util';

const DEFAULT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const DEFAULT_PROACTIVE_REFRESH_SECONDS = 24 * 60 * 60; // 1 day
// The early-refresh window never takes more than this share of a token's
// lifetime, so a short-lived token is still reused for most of its life.
const PROACTIVE_REFRESH_LIFETIME_FRACTION = 0.2;
// ...but never less than this, so a token is not sent seconds before it dies
// (clock skew, slow upstream). Halved for tokens that live under a minute.
const MIN_PROACTIVE_REFRESH_MS = 30 * 1000;
// After a proactive re-login fails, keep serving the still-valid token for this
// long before trying again, instead of hitting the vendor's login on every call.
const PROACTIVE_RETRY_BACKOFF_MS = 30 * 1000;

/**
 * How the login request travels. A tool routed through the connector proxy
 * (`use_proxy`) passes its proxy here, so the login leaves from the same
 * address as the call it authorises: a vendor that blocks the server's IP
 * (Playtomic answers its login with a 403 page) blocks the login as well.
 */
export interface LoginRequestOptions {
  proxyUrl?: string;
}

/**
 * How long before `expiresAt` a token counts as due for renewal.
 *
 * The configured window (`proactiveRefreshSeconds`, default 24h) suits tokens
 * that live for weeks. Applied as-is to a token that lives one hour, every
 * token is "near expiry" the moment it is issued and each call logs in again:
 * a Supabase connector made one password grant per tool call that way, and
 * Supabase rate-limited a third of them. So the window is capped at a fifth of
 * the token's lifetime, with a 30 s floor (half the lifetime below a minute).
 * Tokens that live five days or more keep the configured window unchanged.
 *
 * Without `obtainedAt` the lifetime is unknown and the configured window is
 * used, as before.
 */
export function proactiveRefreshWindowMs(
  bundle: Pick<LoginTokenBundle, 'expiresAt' | 'obtainedAt'>,
  proactiveRefreshSeconds?: number,
): number {
  const configuredMs =
    (proactiveRefreshSeconds ?? DEFAULT_PROACTIVE_REFRESH_SECONDS) * 1000;
  if (!bundle.obtainedAt) return configuredMs;
  const lifetimeMs = bundle.expiresAt - bundle.obtainedAt;
  if (!(lifetimeMs > 0)) return configuredMs;
  const relativeMs = Math.max(
    lifetimeMs * PROACTIVE_REFRESH_LIFETIME_FRACTION,
    Math.min(MIN_PROACTIVE_REFRESH_MS, lifetimeMs / 2),
  );
  return Math.min(configuredMs, relativeMs);
}

export interface LoginTokenAuthConfig {
  loginUrl: string;
  loginMethod?: string; // default POST
  // Either pass a structured body (preferred — strings inside are recursively
  // interpolated with ${param} placeholders without JSON-escape pitfalls)…
  loginBody?: unknown;
  // …or a raw string template (deprecated, brittle for GraphQL mutations).
  loginBodyTemplate?: string;
  loginHeaders?: Record<string, string>;
  /**
   * Send `Authorization: Basic base64(username:password)` on the login request
   * only, for APIs whose login takes HTTP Basic credentials and answers with a
   * token (Wazuh). The engine builds the header itself: the password is not
   * offered to loginBody/loginBodyTemplate (`${password}` renders empty) and,
   * without a loginBody, the login has no body. Refused, before any request,
   * when loginHeaders already set Authorization (any case), with signedJwt,
   * with bcrypt passwordHashing, and for a username containing ":" (RFC 7617).
   */
  loginBasicAuth?: boolean;
  // Required, unless the login proves who it is with `signedJwt` instead.
  username: string;
  password: string;
  aud?: string;
  otp?: string;

  /**
   * Sign a JWT with the account's private key for each login, for APIs whose
   * login takes a client-signed token instead of a password (noon's Partner
   * API: RS256, `sub` = the key id). The token is `${signedJwt}` (or
   * `${outputParam}`) in loginBody/loginBodyTemplate. Every login signs a new
   * one: `iat` = now in whole seconds and a random `jti`, then `claims`;
   * `exp` = iat + ttlSeconds only when ttlSeconds is set. The key is read as
   * in client-assertion.util.ts (PEM, also pasted on one line).
   */
  signedJwt?: {
    privateKey: string;
    algorithm?: string; // default RS256
    keyId?: string; // `kid` header
    ttlSeconds?: number;
    claims?: Record<string, unknown>;
    outputParam?: string; // template param name (default: signedJwt)
  };

  passwordHashing?: {
    scheme: 'bcrypt' | 'none';
    saltSource?: {
      type: 'fetch' | 'static';
      method?: string; // GET/POST when type=fetch
      url?: string; // interpolated with ${username}
      headers?: Record<string, string>;
      responsePath?: string; // JSON path to salt in fetch response
      value?: string; // when type=static
    };
    outputParam?: string; // template param name (default: passwordHashed)
  };

  // One path, or several tried in order when the vendor does not document
  // the login answer's shape: the first that holds a non-empty string wins.
  tokenJsonPath: string | string[];
  expiryJsonPath?: string;
  audJsonPath?: string;
  expiryFormat?: 'iso8601' | 'unix' | 'ttl_seconds';
  tokenTTLSeconds?: number;

  // Where to extract the token from the login response.
  // 'body' (default) → jsonPath(response.data, tokenJsonPath) — JWT pattern.
  // 'cookie'         → parse Set-Cookie header for the cookie named
  //                    {cookieName}, return its value. SAP B1 Service Layer
  //                    uses this with cookieName="B1SESSION".
  tokenSource?: 'body' | 'cookie';
  cookieName?: string;
  // With tokenSource 'cookie': 'single' (default) keeps the value of
  // {cookieName}; 'all' keeps every cookie the login sets, as one
  // "a=1; b=2" string for a `Cookie: ${token}` header. For logins that set a
  // session cookie plus a load-balancer or CSRF cookie the API also wants
  // (SAP Signavio). cookieName is optional then; when set, the login fails
  // unless that cookie is among them.
  cookieMode?: 'single' | 'all';

  refreshOn401?: boolean;
  proactiveRefreshSeconds?: number;

  headerName?: string; // default Authorization
  headerTemplate?: string; // default "Bearer ${token}"
  extraHeaders?: Record<string, string>;
}

export interface LoginTokenBundle {
  token: string;
  aud?: string;
  expiresAt: number; // epoch ms
  // When the login that issued the token happened (epoch ms). Together with
  // expiresAt it gives the token's lifetime, which bounds the early-refresh
  // window. Bundles loaded from the DB take the row's updatedAt.
  obtainedAt?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Manages tokens issued by "POST credentials → receive long-lived bearer" auth flows.
 *
 * Optionally hashes the password client-side with bcrypt + a salt fetched from the
 * remote service (Sorare pattern). Caches tokens in-memory and in a dedicated DB
 * table so they survive restarts. Re-logs in on expiry or on 401 retry.
 */
@Injectable()
export class LoginTokenService {
  private readonly logger = new Logger(LoginTokenService.name);
  private readonly encryptionKey: string;

  private cache = new Map<string, LoginTokenBundle>();
  // Logins in progress (shared by getToken and forceRelogin).
  private inFlight = new Map<string, Promise<LoginTokenBundle>>();
  // getToken resolutions in progress: DB read, then a login if needed.
  private resolving = new Map<string, Promise<LoginTokenBundle>>();
  // Connector → epoch ms before which a failed proactive re-login is not retried.
  private retryAfter = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.encryptionKey = getRequiredSecret(
      'ENCRYPTION_KEY',
      this.configService.get<string>('ENCRYPTION_KEY'),
    );
  }

  /**
   * Return a valid token, fetching/refreshing as needed.
   * - Cache hit & not near expiry → return immediately
   * - Cache miss → check DB, then login if absent or expired
   * - Near expiry → relogin proactively; if that login fails while the old
   *   token is still valid, keep using the old one
   *
   * Concurrent callers for the same connector share one resolution (DB read
   * and login), so a burst of parallel tool calls logs in once.
   */
  async getToken(
    authConfig: LoginTokenAuthConfig,
    connectorId?: string,
    request: LoginRequestOptions = {},
  ): Promise<LoginTokenBundle> {
    const key = this.cacheKey(authConfig, connectorId);
    const cached = this.cache.get(key);
    if (cached && this.isFresh(cached, authConfig)) return cached;
    if (
      cached &&
      cached.expiresAt > Date.now() &&
      (this.retryAfter.get(key) ?? 0) > Date.now()
    ) {
      return cached;
    }

    const pending = this.resolving.get(key);
    if (pending) return pending;

    const p = this.resolveToken(authConfig, connectorId, cached, request).finally(() => {
      this.resolving.delete(key);
    });
    this.resolving.set(key, p);
    return p;
  }

  private async resolveToken(
    authConfig: LoginTokenAuthConfig,
    connectorId: string | undefined,
    cached: LoginTokenBundle | undefined,
    request: LoginRequestOptions,
  ): Promise<LoginTokenBundle> {
    const key = this.cacheKey(authConfig, connectorId);
    let current = cached;
    if (!current && connectorId) {
      const persisted = await this.loadFromDb(connectorId);
      if (persisted && this.isFresh(persisted, authConfig)) {
        this.cache.set(key, persisted);
        return persisted;
      }
      current = persisted ?? undefined;
    }

    try {
      return await this.loginWithMutex(authConfig, connectorId, request);
    } catch (err) {
      // A proactive refresh that fails (the vendor's login is rate-limited or
      // briefly down) must not fail a call the current token can still serve.
      if (current && current.expiresAt > Date.now()) {
        this.cache.set(key, current);
        this.retryAfter.set(key, Date.now() + PROACTIVE_RETRY_BACKOFF_MS);
        this.logger.warn(
          `LOGIN_TOKEN: proactive re-login failed for connector ${connectorId ?? '(none)'}, using the current token until it expires: ${(err as Error).message}`,
        );
        return current;
      }
      throw err;
    }
  }

  private isFresh(
    bundle: LoginTokenBundle,
    authConfig: LoginTokenAuthConfig,
  ): boolean {
    const windowMs = proactiveRefreshWindowMs(
      bundle,
      authConfig.proactiveRefreshSeconds,
    );
    return bundle.expiresAt > Date.now() + windowMs;
  }

  /**
   * Force a fresh login regardless of cache state (called on 401 retry).
   */
  async forceRelogin(
    authConfig: LoginTokenAuthConfig,
    connectorId?: string,
    request: LoginRequestOptions = {},
  ): Promise<LoginTokenBundle> {
    const key = this.cacheKey(authConfig, connectorId);
    this.cache.delete(key);
    return this.loginWithMutex(authConfig, connectorId, request);
  }

  private async loginWithMutex(
    authConfig: LoginTokenAuthConfig,
    connectorId: string | undefined,
    request: LoginRequestOptions,
  ): Promise<LoginTokenBundle> {
    const key = this.cacheKey(authConfig, connectorId);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const p = this.performLogin(authConfig, connectorId, request).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, p);
    return p;
  }

  private async performLogin(
    authConfig: LoginTokenAuthConfig,
    connectorId: string | undefined,
    request: LoginRequestOptions,
  ): Promise<LoginTokenBundle> {
    this.requireString(authConfig.loginUrl, 'loginUrl');
    if (!authConfig.signedJwt) {
      this.requireString(authConfig.username, 'username');
      this.requireString(authConfig.password, 'password');
    }
    if (authConfig.tokenSource !== 'cookie') {
      tokenJsonPaths(authConfig.tokenJsonPath);
    }

    const basicAuth = loginBasicAuthHeader(authConfig);

    const passwordToSend = authConfig.signedJwt && authConfig.password === undefined
      ? ''
      : basicAuth
        ? ''
        : await this.preparePassword(authConfig, request);
    const signedToken = authConfig.signedJwt
      ? signLoginJwt(authConfig.signedJwt)
      : undefined;

    const templateParams: Record<string, string> = {
      username: authConfig.username ?? '',
      [authConfig.passwordHashing?.outputParam || 'passwordHashed']:
        passwordToSend,
      password: passwordToSend,
      aud: authConfig.aud || '',
      otp: authConfig.otp || '',
      ...(signedToken !== undefined && {
        [authConfig.signedJwt?.outputParam || 'signedJwt']: signedToken,
      }),
    };

    const method = (authConfig.loginMethod || 'POST').toUpperCase();
    const url = authConfig.loginUrl;
    await assertSafeOutboundUrl(url);

    // `${uuid}` in a login header becomes a new random UUID for this login
    // (Walmart's token call takes the same WM_QOS.CORRELATION_ID header as its
    // API calls).
    const loginUuid = randomUUID();
    const loginHeaders = Object.fromEntries(
      Object.entries(authConfig.loginHeaders || {}).map(([k, v]) => [
        k,
        String(v).replace(/\$\{uuid\}/g, loginUuid),
      ]),
    );
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...loginHeaders,
      ...(basicAuth ? { Authorization: basicAuth.header } : {}),
    };

    let data: unknown;
    if (authConfig.loginBody !== undefined) {
      data = interpolateDeep(authConfig.loginBody, templateParams);
    } else if (authConfig.loginBodyTemplate) {
      const rendered = renderTemplate(
        authConfig.loginBodyTemplate,
        templateParams,
      );
      try {
        data = JSON.parse(rendered);
      } catch (e: any) {
        throw new Error(
          `LOGIN_TOKEN loginBodyTemplate produced invalid JSON: ${e.message}`,
        );
      }
    } else if (basicAuth) {
      // The credentials travel in the Authorization header only.
      data = undefined;
    } else {
      data = templateParams;
    }

    this.logger.debug(
      `LOGIN_TOKEN: logging in via ${method} ${urlForLog(url, { secrets: [authConfig.password, passwordToSend, signedToken ?? '', ...(basicAuth?.secrets ?? [])] })}${request.proxyUrl ? ' (via proxy)' : ''}`,
    );
    let response: AxiosResponse;
    try {
      response = await axios({
        method,
        url,
        data: method === 'GET' ? undefined : data,
        params: method === 'GET' ? data : undefined,
        headers,
        timeout: 15000,
        ...outboundAxiosOptions({
          credentialHeaders: Object.keys(authConfig.loginHeaders || {}),
          credentialsInBody: true,
        }),
        ...proxyAgents(request),
      });
    } catch (err) {
      if (basicAuth) scrubLoginError(err, basicAuth.secrets);
      throw err;
    }

    let token: unknown;
    if (authConfig.tokenSource === 'cookie' && authConfig.cookieMode === 'all') {
      token = extractAllSetCookies(response.headers);
      if (!token) {
        throw new Error('LOGIN_TOKEN: the login response set no cookies');
      }
      const required = authConfig.cookieName;
      if (required && !extractSetCookieValue(response.headers, required)) {
        throw new Error(
          `LOGIN_TOKEN: cookie "${required}" not found in Set-Cookie response headers`,
        );
      }
    } else if (authConfig.tokenSource === 'cookie') {
      const cookieName = authConfig.cookieName;
      if (!cookieName) {
        throw new Error(
          'LOGIN_TOKEN: tokenSource=cookie requires "cookieName" to be set',
        );
      }
      token = extractSetCookieValue(response.headers, cookieName);
      if (!token) {
        throw new Error(
          `LOGIN_TOKEN: cookie "${cookieName}" not found in Set-Cookie response headers`,
        );
      }
    } else {
      const paths = tokenJsonPaths(authConfig.tokenJsonPath);
      token = readTokenAt(response.data, paths);
      if (!token) {
        // Far and away the commonest reason the token is missing is that the
        // login itself was refused — wrong password, 2FA, a locked account.
        // The endpoint answers 200 and puts the reason in the body, so saying
        // "token not found at data.signIn.jwtToken.token" describes our own
        // JSON path and hides the vendor's explanation. Sorare accounted for
        // thirteen failures reported that way.
        const refusal = extractLoginRefusal(response.data);
        throw new Error(
          refusal
            ? `LOGIN_TOKEN: the service refused the login — ${refusal}`
            : `LOGIN_TOKEN: token not found at ${paths.map((p) => `"${p}"`).join(', ')} in login response`,
        );
      }
    }

    const obtainedAt = Date.now();
    const expiresAt = this.computeExpiresAt(authConfig, response.data);
    const aud = authConfig.audJsonPath
      ? (jsonPath(response.data, authConfig.audJsonPath) as
          | string
          | undefined)
      : authConfig.aud;

    const bundle: LoginTokenBundle = {
      token: String(token),
      aud: aud || undefined,
      expiresAt,
      obtainedAt,
      metadata: aud ? { aud } : undefined,
    };

    const key = this.cacheKey(authConfig, connectorId);
    this.cache.set(key, bundle);
    this.retryAfter.delete(key);
    if (connectorId) {
      await this.persist(connectorId, bundle);
    }
    return bundle;
  }

  private async preparePassword(
    authConfig: LoginTokenAuthConfig,
    request: LoginRequestOptions,
  ): Promise<string> {
    const hashing = authConfig.passwordHashing;
    if (!hashing || hashing.scheme === 'none') return authConfig.password;
    if (hashing.scheme !== 'bcrypt') {
      throw new Error(
        `LOGIN_TOKEN: unsupported passwordHashing.scheme "${hashing.scheme}"`,
      );
    }

    const salt = await this.resolveSalt(authConfig, request);
    if (!salt) {
      throw new Error(
        'LOGIN_TOKEN: passwordHashing.scheme=bcrypt requires a non-empty salt',
      );
    }
    return bcrypt.hashSync(authConfig.password, salt);
  }

  private async resolveSalt(
    authConfig: LoginTokenAuthConfig,
    request: LoginRequestOptions,
  ): Promise<string | null> {
    const src = authConfig.passwordHashing?.saltSource;
    if (!src) return null;
    if (src.type === 'static') return src.value || null;
    if (src.type !== 'fetch') {
      throw new Error(
        `LOGIN_TOKEN: unsupported saltSource.type "${src.type}"`,
      );
    }
    if (!src.url) {
      throw new Error('LOGIN_TOKEN: saltSource.url is required when type=fetch');
    }

    const url = src.url.replace(/\$\{username\}/g, encodeURIComponent(authConfig.username));
    await assertSafeOutboundUrl(url);

    const method = (src.method || 'GET').toUpperCase();
    const response = await axios({
      method,
      url,
      headers: src.headers,
      timeout: 10000,
      ...outboundAxiosOptions({ credentialHeaders: Object.keys(src.headers || {}) }),
      ...proxyAgents(request),
    });

    const path = src.responsePath || 'salt';
    const salt = jsonPath(response.data, path);
    if (!salt || typeof salt !== 'string') {
      throw new Error(
        `LOGIN_TOKEN: salt not found at "${path}" in ${url} response`,
      );
    }
    return salt;
  }

  private computeExpiresAt(
    authConfig: LoginTokenAuthConfig,
    responseBody: unknown,
  ): number {
    const now = Date.now();
    const ttlFallbackMs =
      (authConfig.tokenTTLSeconds ?? DEFAULT_TOKEN_TTL_SECONDS) * 1000;

    if (!authConfig.expiryJsonPath) {
      return now + ttlFallbackMs;
    }

    const raw = jsonPath(responseBody, authConfig.expiryJsonPath);
    if (raw === undefined || raw === null || raw === '') {
      return now + ttlFallbackMs;
    }

    const fmt = authConfig.expiryFormat || 'iso8601';
    if (fmt === 'iso8601') {
      const t = Date.parse(String(raw));
      return Number.isFinite(t) ? t : now + ttlFallbackMs;
    }
    if (fmt === 'unix') {
      const n = Number(raw);
      if (!Number.isFinite(n)) return now + ttlFallbackMs;
      return n < 1e12 ? n * 1000 : n;
    }
    if (fmt === 'ttl_seconds') {
      const n = Number(raw);
      return Number.isFinite(n) ? now + n * 1000 : now + ttlFallbackMs;
    }
    return now + ttlFallbackMs;
  }

  private cacheKey(
    authConfig: LoginTokenAuthConfig,
    connectorId?: string,
  ): string {
    if (connectorId) return connectorId;
    const who = authConfig.username ?? authConfig.signedJwt?.claims?.sub;
    return `${authConfig.loginUrl}|${String(who ?? '')}`;
  }

  private async loadFromDb(
    connectorId: string,
  ): Promise<LoginTokenBundle | null> {
    try {
      const row = await this.prisma.connectorAuthCache.findUnique({
        where: { connectorId },
      });
      if (!row) return null;
      return {
        token: decrypt(row.token, this.encryptionKey),
        expiresAt: row.expiresAt.getTime(),
        // persist() writes the row right after the login, so updatedAt is
        // when the token was issued.
        obtainedAt: row.updatedAt?.getTime(),
        aud: (row.metadata as { aud?: string } | null)?.aud,
        metadata: (row.metadata as Record<string, unknown> | null) || undefined,
      };
    } catch (err: any) {
      this.logger.warn(
        `LOGIN_TOKEN: failed to load cached token for ${connectorId}: ${err.message}`,
      );
      return null;
    }
  }

  private async persist(
    connectorId: string,
    bundle: LoginTokenBundle,
  ): Promise<void> {
    try {
      const encrypted = encrypt(bundle.token, this.encryptionKey);
      const metadata = bundle.metadata || (bundle.aud ? { aud: bundle.aud } : null);
      await this.prisma.connectorAuthCache.upsert({
        where: { connectorId },
        update: {
          token: encrypted,
          metadata: (metadata as object) ?? undefined,
          expiresAt: new Date(bundle.expiresAt),
        },
        create: {
          connectorId,
          token: encrypted,
          metadata: (metadata as object) ?? undefined,
          expiresAt: new Date(bundle.expiresAt),
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `LOGIN_TOKEN: failed to persist token for ${connectorId}: ${err.message}`,
      );
    }
  }

  private requireString(value: unknown, name: string): void {
    if (!value || typeof value !== 'string') {
      throw new Error(`LOGIN_TOKEN: authConfig.${name} is required`);
    }
  }
}

/**
 * The login's `Authorization: Basic` header when `loginBasicAuth` is true,
 * else undefined. Built here from username and password, never through a
 * template. Explicit configuration conflicts are refused instead of resolved
 * silently: an Authorization in loginHeaders (which one would the vendor see?),
 * signedJwt (no password), bcrypt passwordHashing (Basic sends the password
 * as is) and a username with ":" (RFC 7617 cannot encode it). No error quotes
 * a credential. `secrets` lists the strings to keep out of logs and errors.
 */
export function loginBasicAuthHeader(
  cfg: LoginTokenAuthConfig,
): { header: string; secrets: string[] } | undefined {
  const flag = (cfg as { loginBasicAuth?: unknown }).loginBasicAuth;
  if (flag === undefined || flag === false) return undefined;
  if (flag !== true) {
    throw new Error('LOGIN_TOKEN: loginBasicAuth must be true or false');
  }
  if (cfg.signedJwt) {
    throw new Error('LOGIN_TOKEN: loginBasicAuth cannot be combined with signedJwt');
  }
  if (cfg.passwordHashing && cfg.passwordHashing.scheme !== 'none') {
    throw new Error(
      'LOGIN_TOKEN: loginBasicAuth sends the password as is and cannot be combined with passwordHashing',
    );
  }
  if (Object.keys(cfg.loginHeaders || {}).some((h) => h.toLowerCase() === 'authorization')) {
    throw new Error(
      'LOGIN_TOKEN: loginBasicAuth sets the login Authorization header itself; remove Authorization from loginHeaders',
    );
  }
  for (const name of ['username', 'password'] as const) {
    const v = cfg[name];
    if (!v || typeof v !== 'string') {
      throw new Error(`LOGIN_TOKEN: authConfig.${name} is required`);
    }
  }
  if (cfg.username.includes(':')) {
    throw new Error('LOGIN_TOKEN: loginBasicAuth: the username must not contain ":"');
  }
  const encoded = Buffer.from(`${cfg.username}:${cfg.password}`, 'utf8').toString('base64');
  return { header: `Basic ${encoded}`, secrets: [cfg.password, encoded] };
}

/**
 * Remove the Basic credentials from a failed login's error before it travels
 * on: the Authorization header from the request config axios attaches (also
 * under response.config), the raw request head Node keeps on the request, and
 * any occurrence of a secret in the message. Status and response stay, so the
 * callers still see a 401 as a 401.
 */
function scrubLoginError(err: unknown, secrets: string[]): void {
  if (!err || typeof err !== 'object') return;
  const e = err as {
    message?: unknown;
    config?: { headers?: unknown };
    response?: { config?: { headers?: unknown } };
    request?: { _header?: unknown };
  };
  for (const holder of [e.config, e.response?.config]) {
    const headers = holder?.headers as Record<string, unknown> | undefined;
    if (!headers || typeof headers !== 'object') continue;
    const del = (headers as { delete?: unknown }).delete;
    if (typeof del === 'function') del.call(headers, 'Authorization');
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'authorization') delete headers[k];
    }
  }
  if (e.request && typeof e.request === 'object' && typeof e.request._header === 'string') {
    e.request._header = e.request._header.replace(/^authorization:.*$/gim, 'Authorization: [redacted]');
  }
  if (typeof e.message === 'string') {
    let m = e.message;
    for (const secret of secrets) if (secret) m = m.split(secret).join('[redacted]');
    e.message = m;
  }
}

/**
 * The token path(s) of an authConfig as a list. A single string is the usual
 * form; a list is for logins whose answer is undocumented, tried in order.
 * Anything else (missing, empty, a non-string entry) is a configuration error.
 */
export function tokenJsonPaths(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || list.some((p) => !p || typeof p !== 'string')) {
    throw new Error(
      'LOGIN_TOKEN: authConfig.tokenJsonPath is required (a path, or a list of paths)',
    );
  }
  return list as string[];
}

/** The first non-empty string found at one of `paths`, in order. */
export function readTokenAt(body: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = jsonPath(body, path);
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/**
 * Resolve a dotted/bracket JSON path against a value.
 * Supports a.b.c and a.b[0].c.
 */
export function jsonPath(value: unknown, path: string): unknown {
  if (value === undefined || value === null) return undefined;
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur: unknown = value;
  for (const p of parts) {
    if (cur === undefined || cur === null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(p);
      cur = Number.isFinite(idx) ? cur[idx] : undefined;
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Render a string template by replacing ${name} placeholders.
 * Simple substitution: missing params render as empty string. No JSON-escape
 * awareness — use `loginBody` (structured) instead of `loginBodyTemplate` (raw)
 * when the body contains nested string contexts (e.g. GraphQL mutations).
 */
/**
 * The JWT a `signedJwt` login sends. Errors name what is wrong (key missing,
 * not PEM, wrong type, a claim whose variable is empty) and never carry key
 * material. Exported for the tests.
 */
export function signLoginJwt(
  cfg: NonNullable<LoginTokenAuthConfig['signedJwt']>,
  now: number = Date.now(),
): string {
  const claims = cfg.claims ?? {};
  for (const [name, v] of Object.entries(claims)) {
    if (typeof v !== 'string') continue;
    const unresolved = findUnresolvedPlaceholders(v);
    if (!v.trim() || unresolved.length > 0) {
      throw new Error(
        `LOGIN_TOKEN: signedJwt: the "${name}" claim is not set` +
          (unresolved.length > 0 ? ` ({{${unresolved[0]}}} has no value)` : ''),
      );
    }
  }
  const iat = Math.floor(now / 1000);
  const ttl = Number(cfg.ttlSeconds);
  const payload: Record<string, unknown> = {
    iat,
    jti: randomUUID(),
    ...claims,
    ...(Number.isFinite(ttl) && ttl > 0 ? { exp: iat + Math.floor(ttl) } : {}),
  };
  try {
    return signJwt({
      privateKey: cfg.privateKey,
      algorithm: cfg.algorithm,
      keyId: cfg.keyId,
      payload,
    });
  } catch (err) {
    if (err instanceof ClientAssertionError) {
      throw new Error(`LOGIN_TOKEN: signedJwt: ${err.message.replace(/^client assertion: /, '')}`);
    }
    throw err;
  }
}

export function renderTemplate(
  template: string,
  params: Record<string, string>,
): string {
  return template.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_m, name: string) => params[name] ?? '',
  );
}

/**
 * Recursively walk a value, substituting `${param}` placeholders in any string
 * leaves with values from `params`. Object/array structure is preserved.
 *
 * - Full-string reference "${name}" → params.name (any type passes through)
 * - Embedded "...${name}..." → string interpolation, missing → ''
 * - Non-strings → returned unchanged
 */
/**
 * Pull the value of a named cookie from a response's Set-Cookie header(s).
 * Axios exposes the header as either a single string or an array of strings
 * depending on whether the upstream sent multiple Set-Cookie headers.
 *
 * Example: extractSetCookieValue(headers, "B1SESSION") with
 *   Set-Cookie: B1SESSION=ABC123; Path=/; HttpOnly
 * returns "ABC123".
 *
 * When the same cookie is set more than once, the last non-empty value wins,
 * as it does in a browser. Vinted clears `access_token_web` on one domain
 * (`access_token_web=; Max-Age=-1`) and sets the real token on another in the
 * same response; taking the first match returned the empty deletion and the
 * login failed with "cookie not found".
 */
export function extractSetCookieValue(
  headers: Record<string, unknown> | undefined,
  cookieName: string,
): string | null {
  if (!headers) return null;
  const raw = (headers['set-cookie'] ?? headers['Set-Cookie']) as
    | string
    | string[]
    | undefined;
  if (!raw) return null;
  const entries = Array.isArray(raw) ? raw : [raw];
  const prefix = `${cookieName}=`;
  let found: string | null = null;
  for (const entry of entries) {
    const trimmed = entry.trimStart();
    if (trimmed.startsWith(prefix)) {
      const valueEnd = trimmed.indexOf(';', prefix.length);
      const value = trimmed.slice(
        prefix.length,
        valueEnd === -1 ? undefined : valueEnd,
      );
      if (value) found = value;
    }
  }
  return found;
}

/**
 * Every cookie a response sets, as the value of a `Cookie` request header:
 * `name=value` pairs joined with "; ", in the order they were set. Attributes
 * (Path, Domain, HttpOnly ...) are dropped. When a name is set more than once
 * the last value wins and keeps its first position; a deletion (empty value
 * or Max-Age <= 0) removes it, as a browser would. Null when nothing is left.
 *
 * SAP Signavio's login sets JSESSIONID plus a load-balancer cookie; sending
 * only the session cookie lands the next call on another node, which does not
 * know the session.
 */
export function extractAllSetCookies(
  headers: Record<string, unknown> | undefined,
): string | null {
  if (!headers) return null;
  const raw = (headers['set-cookie'] ?? headers['Set-Cookie']) as
    | string
    | string[]
    | undefined;
  if (!raw) return null;
  const entries = Array.isArray(raw) ? raw : [raw];
  const jar = new Map<string, string>();
  for (const entry of entries) {
    const [pair, ...attributes] = String(entry).split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    const expired = attributes.some((a) => {
      const m = /^\s*max-age\s*=\s*(-?\d+)\s*$/i.exec(a);
      return m !== null && Number(m[1]) <= 0;
    });
    if (!value || expired) {
      jar.delete(name);
      continue;
    }
    jar.set(name, value);
  }
  if (jar.size === 0) return null;
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

export function interpolateDeep(
  value: unknown,
  params: Record<string, string>,
): unknown {
  if (typeof value === 'string') {
    const fullMatch = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    if (fullMatch) {
      const v = params[fullMatch[1]];
      return v ?? '';
    }
    return value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_m, name: string) => params[name] ?? '',
    );
  }
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, params));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateDeep(v, params);
    }
    return out;
  }
  return value;
}

/**
 * Pull a human-readable refusal out of a login response that returned 200
 * without a token. Covers the two shapes vendors actually use: a GraphQL-style
 * `errors: [{ message }]` (at the root or nested under the mutation payload),
 * and a flat `error` / `message` / `error_description` string.
 */
export function extractLoginRefusal(body: unknown): string | null {
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): string | null => {
    if (!node || typeof node !== 'object' || depth > 4 || seen.has(node)) {
      return null;
    }
    seen.add(node);
    const obj = node as Record<string, unknown>;

    const errors = obj.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const messages = errors
        .map((e) =>
          typeof e === 'string'
            ? e
            : typeof (e as Record<string, unknown>)?.message === 'string'
              ? ((e as Record<string, unknown>).message as string)
              : null,
        )
        .filter((m): m is string => !!m);
      if (messages.length > 0) return messages.join('; ');
    }

    for (const key of ['error_description', 'error', 'message']) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }

    for (const v of Object.values(obj)) {
      const found = walk(v, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(body, 0);
}

/**
 * Agents for a login that goes through the connector proxy, set after the
 * outbound spread as the tool calls do (see rest.engine). Empty without one.
 */
function proxyAgents(request: LoginRequestOptions) {
  if (!request.proxyUrl) return {};
  const agent = createUnblockerProxyAgent(request.proxyUrl);
  return { httpAgent: agent, httpsAgent: agent, proxy: false as const };
}

/**
 * Placeholder renderer for LOGIN_TOKEN API headers: `${token}`, `${aud}` and
 * `${uuid}`. The UUID is drawn once per request, so two headers that both use
 * `${uuid}` carry the same value.
 */
export function loginTokenHeaderInterpolator(
  token: string,
  aud?: string,
): (s: string) => string {
  let uuid: string | undefined;
  return (s: string): string =>
    s
      .replace(/\$\{token\}/g, token)
      .replace(/\$\{aud\}/g, aud || '')
      .replace(/\$\{uuid\}/g, () => (uuid ??= randomUUID()));
}
