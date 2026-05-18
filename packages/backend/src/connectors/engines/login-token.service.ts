import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../common/prisma.service';
import { encrypt, decrypt } from '../../common/crypto/encryption.util';
import { getRequiredSecret } from '../../common/secrets.util';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';

const DEFAULT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const DEFAULT_PROACTIVE_REFRESH_SECONDS = 24 * 60 * 60; // 1 day

export interface LoginTokenAuthConfig {
  loginUrl: string;
  loginMethod?: string; // default POST
  // Either pass a structured body (preferred — strings inside are recursively
  // interpolated with ${param} placeholders without JSON-escape pitfalls)…
  loginBody?: unknown;
  // …or a raw string template (deprecated, brittle for GraphQL mutations).
  loginBodyTemplate?: string;
  loginHeaders?: Record<string, string>;
  username: string;
  password: string;
  aud?: string;
  otp?: string;

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

  tokenJsonPath: string;
  expiryJsonPath?: string;
  audJsonPath?: string;
  expiryFormat?: 'iso8601' | 'unix' | 'ttl_seconds';
  tokenTTLSeconds?: number;

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
  private inFlight = new Map<string, Promise<LoginTokenBundle>>();

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
   * - Near expiry → relogin proactively
   */
  async getToken(
    authConfig: LoginTokenAuthConfig,
    connectorId?: string,
  ): Promise<LoginTokenBundle> {
    const key = this.cacheKey(authConfig, connectorId);
    const proactiveSec =
      authConfig.proactiveRefreshSeconds ?? DEFAULT_PROACTIVE_REFRESH_SECONDS;
    const now = Date.now();

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now + proactiveSec * 1000) {
      return cached;
    }

    if (!cached && connectorId) {
      const persisted = await this.loadFromDb(connectorId);
      if (persisted && persisted.expiresAt > now + proactiveSec * 1000) {
        this.cache.set(key, persisted);
        return persisted;
      }
    }

    return this.loginWithMutex(authConfig, connectorId);
  }

  /**
   * Force a fresh login regardless of cache state (called on 401 retry).
   */
  async forceRelogin(
    authConfig: LoginTokenAuthConfig,
    connectorId?: string,
  ): Promise<LoginTokenBundle> {
    const key = this.cacheKey(authConfig, connectorId);
    this.cache.delete(key);
    return this.loginWithMutex(authConfig, connectorId);
  }

  private async loginWithMutex(
    authConfig: LoginTokenAuthConfig,
    connectorId?: string,
  ): Promise<LoginTokenBundle> {
    const key = this.cacheKey(authConfig, connectorId);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const p = this.performLogin(authConfig, connectorId).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, p);
    return p;
  }

  private async performLogin(
    authConfig: LoginTokenAuthConfig,
    connectorId?: string,
  ): Promise<LoginTokenBundle> {
    this.requireString(authConfig.loginUrl, 'loginUrl');
    this.requireString(authConfig.username, 'username');
    this.requireString(authConfig.password, 'password');
    this.requireString(authConfig.tokenJsonPath, 'tokenJsonPath');

    const passwordToSend = await this.preparePassword(authConfig);

    const templateParams: Record<string, string> = {
      username: authConfig.username,
      [authConfig.passwordHashing?.outputParam || 'passwordHashed']:
        passwordToSend,
      password: passwordToSend,
      aud: authConfig.aud || '',
      otp: authConfig.otp || '',
    };

    const method = (authConfig.loginMethod || 'POST').toUpperCase();
    const url = authConfig.loginUrl;
    await assertSafeOutboundUrl(url);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(authConfig.loginHeaders || {}),
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
    } else {
      data = templateParams;
    }

    this.logger.debug(`LOGIN_TOKEN: logging in via ${method} ${url}`);
    const response = await axios({
      method,
      url,
      data: method === 'GET' ? undefined : data,
      params: method === 'GET' ? data : undefined,
      headers,
      timeout: 15000,
    });

    const token = jsonPath(response.data, authConfig.tokenJsonPath);
    if (!token || typeof token !== 'string') {
      throw new Error(
        `LOGIN_TOKEN: token not found at "${authConfig.tokenJsonPath}" in login response`,
      );
    }

    const expiresAt = this.computeExpiresAt(authConfig, response.data);
    const aud = authConfig.audJsonPath
      ? (jsonPath(response.data, authConfig.audJsonPath) as
          | string
          | undefined)
      : authConfig.aud;

    const bundle: LoginTokenBundle = {
      token,
      aud: aud || undefined,
      expiresAt,
      metadata: aud ? { aud } : undefined,
    };

    const key = this.cacheKey(authConfig, connectorId);
    this.cache.set(key, bundle);
    if (connectorId) {
      await this.persist(connectorId, bundle);
    }
    return bundle;
  }

  private async preparePassword(
    authConfig: LoginTokenAuthConfig,
  ): Promise<string> {
    const hashing = authConfig.passwordHashing;
    if (!hashing || hashing.scheme === 'none') return authConfig.password;
    if (hashing.scheme !== 'bcrypt') {
      throw new Error(
        `LOGIN_TOKEN: unsupported passwordHashing.scheme "${hashing.scheme}"`,
      );
    }

    const salt = await this.resolveSalt(authConfig);
    if (!salt) {
      throw new Error(
        'LOGIN_TOKEN: passwordHashing.scheme=bcrypt requires a non-empty salt',
      );
    }
    return bcrypt.hashSync(authConfig.password, salt);
  }

  private async resolveSalt(
    authConfig: LoginTokenAuthConfig,
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
    return `${authConfig.loginUrl}|${authConfig.username}`;
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
