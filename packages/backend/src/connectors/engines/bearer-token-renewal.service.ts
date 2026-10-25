import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../../common/prisma.service';
import { decrypt, encrypt } from '../../common/crypto/encryption.util';
import { getRequiredSecret } from '../../common/secrets.util';
import { connectorPageUrl } from '../../common/url.util';
import { getAdapter } from '../../adapters/catalog';
import { ConnectorAuthStatusService, credentialRef, expiredTokenHint } from './connector-auth-status.service';

/**
 * Renewal of pasted bearer tokens that expire, for providers that let a
 * token be exchanged for a longer one without a browser sign-in.
 *
 * WHY. Meta's Facebook Login issues no refresh tokens. A token copied from
 * the Graph API Explorer lasts one or two hours, an exchanged ("long-lived")
 * user token about 60 days, and the connector then fails with error 190
 * until someone pastes a new one. One paying workspace's Instagram connector
 * did exactly that on 17 Oct 2026 (190/463 "Session has expired"), then kept
 * failing with 190/467 once the session was logged out.
 *
 * An adapter declares the capability in its BEARER_TOKEN authConfig:
 *
 *   "tokenRenewal": {
 *     "provider": "meta",            // or "instagram_login"
 *     "appIdVar": "META_APP_ID",     // connector variables, both optional
 *     "appSecretVar": "META_APP_SECRET",
 *     "pageIdVar": "FACEBOOK_PAGE_ID" // optional: derive a Page token
 *   }
 *
 * Variable names, not {{placeholders}}: the app id and secret are optional,
 * and an unset placeholder would stop every call. Connectors installed before
 * an adapter declared it get it from the catalog (see withTokenRenewal).
 *
 * What happens, per connector:
 *   - a token not seen before (installed, or pasted again) is exchanged for a
 *     long-lived one when the app id and secret are set (meta), or for a Page
 *     token that never expires when the adapter names a Page id;
 *   - the long-lived token and its expiry are stored encrypted in
 *     connector_auth_cache, and renewed on the first call once fewer than
 *     `renewWithinDays` (10) remain; one renewal at a time per connector,
 *     across processes (advisory lock);
 *   - without the app secret, debug_token reads the expiry (with the token
 *     itself, which works for the app's developers) and the connector shows
 *     a warning before it expires;
 *   - Meta error 190 with a session that cannot come back (logged out,
 *     password changed, expired) marks the connector as needing a new token,
 *     and calls fail at once until a different token is saved.
 *
 * Never logs a token, the app secret or a URL that carries them.
 */

export interface TokenRenewalSpec {
  provider: 'meta' | 'instagram_login';
  appIdVar?: string;
  appSecretVar?: string;
  pageIdVar?: string;
  /** Graph API version for the exchange; defaults to the base URL's, else v25.0. */
  graphVersion?: string;
  /** Renew when fewer days than this remain. Default 10. */
  renewWithinDays?: number;
}

/** The spec with the variables' values filled in, as the engine receives it. */
export interface ResolvedTokenRenewal extends TokenRenewalSpec {
  appId?: string;
  appSecret?: string;
  pageId?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RENEW_WITHIN_DAYS = 10;
const DEFAULT_GRAPH_VERSION = 'v25.0';
const HTTP_TIMEOUT_MS = 10_000;
/** After a failed renewal, wait this long before trying again (the token still works meanwhile). */
const RENEW_RETRY_MS = 6 * 60 * 60 * 1000;
/** Instagram refuses to refresh a token younger than a day. */
const IG_MIN_AGE_MS = DAY_MS;
const LOCK_NAMESPACE = 'amcp:bearer-renew:';
const LOCK_MAX_WAIT_MS = 3_000;
const LOCK_TIMEOUT_MS = 30_000;
const CACHE_KIND = 'bearer_renewal';

/** Status codes this service sets; a working token clears the warnings among them. */
const WARNING_CODES = ['meta_expiring', 'renewal_failed'];

interface TokenState {
  /** credentialRef of the token the user pasted, which this state derives from. */
  sourceRef: string;
  /** The token to send. */
  token: string;
  /** ms epoch; null = never expires, undefined = unknown. */
  expiresAt?: number | null;
  /** When `token` was issued or obtained (ms epoch), if known. */
  obtainedAt?: number;
  /** Don't try to renew before this (after a failed attempt). */
  retryAfter?: number;
}

type Db = Pick<PrismaService, 'connectorAuthCache'>;

/**
 * Fill in the renewal spec of a BEARER_TOKEN connector: the connector's own
 * authConfig.tokenRenewal, else its catalog adapter's. Returns authConfig
 * unchanged when there is none. Pure; called on every call path that builds
 * an engine config (MCP calls, Run test, Test connection).
 */
export function withTokenRenewal(
  authType: string | undefined,
  authConfig: Record<string, unknown> | undefined,
  connectorConfig: unknown,
  envVars: Record<string, string> | null | undefined,
): Record<string, unknown> | undefined {
  if (authType !== 'BEARER_TOKEN' || !authConfig) return authConfig;
  let spec = asSpec(authConfig.tokenRenewal);
  if (!spec) {
    const slug = (connectorConfig as { adapterSlug?: unknown } | null | undefined)?.adapterSlug;
    const adapter = typeof slug === 'string' ? getAdapter(slug) : undefined;
    spec = asSpec((adapter?.connector?.authConfig as Record<string, unknown> | undefined)?.tokenRenewal);
  }
  if (!spec) return authConfig;
  const env = envVars ?? {};
  const value = (name?: string) => {
    const v = name ? env[name] : undefined;
    return typeof v === 'string' && v.trim() && !/\{\{/.test(v) ? v.trim() : undefined;
  };
  const resolved: ResolvedTokenRenewal = {
    ...spec,
    appId: value(spec.appIdVar),
    appSecret: value(spec.appSecretVar),
    pageId: value(spec.pageIdVar),
  };
  return { ...authConfig, tokenRenewal: resolved };
}

function asSpec(value: unknown): TokenRenewalSpec | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const provider = (value as { provider?: unknown }).provider;
  return provider === 'meta' || provider === 'instagram_login' ? (value as TokenRenewalSpec) : undefined;
}

/** Meta's error 190 subcodes after which the same token can never work again. */
const META_DEAD_SESSION: Record<number, { code: string; what: string }> = {
  458: { code: 'meta_app_removed', what: 'the user removed the app from their account' },
  460: { code: 'meta_password_changed', what: 'the password of the account was changed' },
  463: { code: 'meta_token_expired', what: 'the token has expired' },
  464: { code: 'meta_unconfirmed_user', what: 'the account is not confirmed' },
  467: { code: 'meta_logged_out', what: 'the user logged out, which ends the session' },
};

/** The Graph API error of an axios error, when Meta sent one. */
export function metaGraphError(err: unknown): { code?: number; subcode?: number; message?: string } | undefined {
  const data = (err as { response?: { data?: unknown } })?.response?.data as
    | { error?: { code?: unknown; error_subcode?: unknown; message?: unknown } }
    | undefined;
  const e = data && typeof data === 'object' ? data.error : undefined;
  if (!e || typeof e !== 'object') return undefined;
  return {
    code: typeof e.code === 'number' ? e.code : undefined,
    subcode: typeof e.error_subcode === 'number' ? e.error_subcode : undefined,
    message: typeof e.message === 'string' ? e.message.slice(0, 200) : undefined,
  };
}

@Injectable()
export class BearerTokenRenewalService {
  private readonly logger = new Logger(BearerTokenRenewalService.name);
  private readonly encryptionKey: string;

  private state = new Map<string, TokenState>();
  /** Connectors whose stored state was read from the database (present or not). */
  private loaded = new Set<string>();
  private inFlight = new Map<string, Promise<string>>();
  /** Tokens Meta refused for good: connectorId → the token's ref and what to do. */
  private blocked = new Map<string, { ref: string; message: string }>();
  /** The expiry warning last recorded per connector, so a call does not repeat it. */
  private warned = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Optional() private readonly authStatus?: ConnectorAuthStatusService,
  ) {
    this.encryptionKey = getRequiredSecret(
      'ENCRYPTION_KEY',
      this.configService.get<string>('ENCRYPTION_KEY'),
    );
  }

  /**
   * The token to send for a BEARER_TOKEN connector. Without a renewal spec
   * or a saved connector, the pasted token, exactly as before.
   */
  async getToken(authConfig: Record<string, unknown>, connectorId?: string): Promise<string> {
    const pasted = typeof authConfig.token === 'string' ? authConfig.token : String(authConfig.token ?? '');
    const spec = asSpec(authConfig.tokenRenewal) as ResolvedTokenRenewal | undefined;
    if (!spec || !connectorId || !pasted) return pasted;
    const ref = credentialRef(pasted)!;

    const block = this.blocked.get(connectorId);
    if (block) {
      if (block.ref === ref) throw blockedError(block.message);
      // A different token was saved: whatever was wrong with the old one is over.
      this.blocked.delete(connectorId);
      await this.authStatus?.clear(connectorId);
    }

    const current = await this.loadState(connectorId);
    if (current && current.sourceRef === ref) {
      if (this.shouldRenew(current, spec)) {
        return this.singleFlight(connectorId, () => this.renew(connectorId, current, spec)).catch(
          () => current.token,
        );
      }
      await this.warnIfExpiring(connectorId, current, spec);
      return current.token;
    }
    // A token this connector has not used yet.
    return this.singleFlight(connectorId, () => this.adopt(connectorId, pasted, ref, spec)).catch(
      () => pasted,
    );
  }

  /**
   * The API refused the token. When Meta says the session is gone for good,
   * mark the connector, block further calls with this token and return the
   * hint for the caller; undefined for any other failure.
   */
  async onRejected(
    authConfig: Record<string, unknown> | undefined,
    connectorId: string | undefined,
    error: unknown,
  ): Promise<string | undefined> {
    const spec = asSpec(authConfig?.tokenRenewal) as ResolvedTokenRenewal | undefined;
    if (!spec || !connectorId || !authConfig) return undefined;
    const meta = metaGraphError(error);
    if (!meta || meta.code !== 190) return undefined;
    const dead = meta.subcode !== undefined ? META_DEAD_SESSION[meta.subcode] : undefined;
    // 190 without a subcode is a malformed or revoked token: just as final.
    const code = dead?.code ?? 'meta_token_invalid';
    const what = dead?.what ?? 'the token is invalid or was revoked';
    const message = deadTokenHint(what, spec, connectorId);
    const pasted = String(authConfig.token ?? '');
    const ref = credentialRef(pasted);
    if (!ref) return undefined;
    this.blocked.set(connectorId, { ref, message });
    // The token sent may have been our renewed one: forget it, the next
    // paste starts over.
    this.state.delete(connectorId);
    this.logger.warn(`Connector ${connectorId}: Meta refused the token for good (190/${meta.subcode ?? '-'})`);
    await this.authStatus?.mark(connectorId, { status: 'needs_reauth', code, message, ref });
    return message;
  }

  /** The credentials changed (new token, new app id/secret): start over. */
  forget(connectorId: string): void {
    this.state.delete(connectorId);
    this.loaded.delete(connectorId);
    this.blocked.delete(connectorId);
    this.warned.delete(connectorId);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private canExchange(spec: ResolvedTokenRenewal): boolean {
    return spec.provider === 'meta' && !!spec.appId && !!spec.appSecret;
  }

  private shouldRenew(st: TokenState, spec: ResolvedTokenRenewal): boolean {
    if (st.expiresAt === null || st.expiresAt === undefined) return false;
    if (st.retryAfter && Date.now() < st.retryAfter) return false;
    if (st.expiresAt <= Date.now()) return false; // an expired token cannot be exchanged
    const within = (spec.renewWithinDays ?? DEFAULT_RENEW_WITHIN_DAYS) * DAY_MS;
    if (st.expiresAt - Date.now() > within) return false;
    if (spec.provider === 'meta') return this.canExchange(spec);
    // instagram_login: needs no secret, but a token at least a day old.
    return !st.obtainedAt || Date.now() - st.obtainedAt >= IG_MIN_AGE_MS;
  }

  private singleFlight(connectorId: string, fn: () => Promise<string>): Promise<string> {
    const running = this.inFlight.get(connectorId);
    if (running) return running;
    const p = fn().finally(() => this.inFlight.delete(connectorId));
    this.inFlight.set(connectorId, p);
    return p;
  }

  /** A token not seen before: exchange it if possible, else find out when it expires. */
  private async adopt(
    connectorId: string,
    pasted: string,
    ref: string,
    spec: ResolvedTokenRenewal,
  ): Promise<string> {
    // Whatever was recorded against an earlier token no longer applies.
    await this.authStatus?.clear(connectorId, { exceptRef: ref });

    // What Meta knows about the token. A System User or Page token never
    // expires and is not a user token, so it is used as it is.
    const info = await this.inspect(pasted, spec).catch(() => undefined);
    const neverExpires = info?.expiresAt === null;

    if (!neverExpires && (this.canExchange(spec) || spec.provider === 'instagram_login')) {
      const exchanged = await this.withLock(connectorId, async (db) => {
        // Another process may have exchanged this very token a moment ago.
        const stored = await this.readStored(connectorId, db);
        if (stored && stored.sourceRef === ref) return stored;
        const out = await (spec.provider === 'meta'
          ? this.metaExchange(pasted, spec)
          : this.instagramRefresh(pasted)
        ).catch((err) => {
          this.logger.warn(`Connector ${connectorId}: token exchange failed (${describeError(err)})`);
          return { error: describeError(err) } as const;
        });
        if ('error' in out) return { error: out.error } as const;
        let st: TokenState = {
          sourceRef: ref,
          token: out.token,
          expiresAt: out.expiresAt,
          obtainedAt: Date.now(),
        };
        if (spec.pageId) st = (await this.derivePageToken(connectorId, st, spec)) ?? st;
        await this.writeStored(connectorId, st, db);
        return st;
      }).catch((err) => ({ error: describeError(err) }) as const);
      if (!('error' in exchanged)) {
        this.state.set(connectorId, exchanged);
        this.loaded.add(connectorId);
        await this.afterNewToken(connectorId, exchanged);
        this.logger.log(
          `Connector ${connectorId}: pasted token exchanged` +
            (exchanged.expiresAt ? `, valid until ${new Date(exchanged.expiresAt).toISOString()}` : ', no expiry'),
        );
        return exchanged.token;
      }
      if (spec.provider === 'meta') {
        await this.authStatus?.mark(connectorId, {
          status: 'expiring',
          code: 'renewal_failed',
          message:
            `Meta refused to exchange the token for a long-lived one (${exchanged.error}). Check ` +
            `${varNames(spec)}: they must belong to the Meta app the token was created with.`,
          ref,
        });
      }
    }

    // No exchange: the pasted token as it is, with its expiry when known.
    const st: TokenState = {
      sourceRef: ref,
      token: pasted,
      expiresAt: info?.expiresAt,
      obtainedAt: info?.issuedAt,
      // An Instagram token younger than a day cannot be refreshed yet.
      ...(spec.provider === 'instagram_login' ? { retryAfter: Date.now() + RENEW_RETRY_MS } : {}),
    };
    this.state.set(connectorId, st);
    this.loaded.add(connectorId);
    if (info) await this.authStatus?.setTokenExpiry(connectorId, info.expiresAt ? new Date(info.expiresAt) : null);
    await this.warnIfExpiring(connectorId, st, spec);
    return pasted;
  }

  /** The stored long-lived token is close to expiry: renew it. */
  private async renew(connectorId: string, current: TokenState, spec: ResolvedTokenRenewal): Promise<string> {
    const result = await this.withLock(connectorId, async (db) => {
      const stored = await this.readStored(connectorId, db);
      // Renewed by another process meanwhile.
      if (stored && stored.sourceRef === current.sourceRef && stored.token !== current.token) return stored;
      const out =
        spec.provider === 'meta'
          ? await this.metaExchange(current.token, spec)
          : await this.instagramRefresh(current.token);
      const st: TokenState = {
        sourceRef: current.sourceRef,
        token: out.token,
        expiresAt: out.expiresAt,
        obtainedAt: Date.now(),
      };
      await this.writeStored(connectorId, st, db);
      return st;
    }).catch(async (err) => {
      this.logger.warn(`Connector ${connectorId}: token renewal failed (${describeError(err)})`);
      current.retryAfter = Date.now() + RENEW_RETRY_MS;
      await this.warnIfExpiring(connectorId, current, spec, describeError(err));
      throw err;
    });

    // Meta may hand back a token that expires no later than the old one.
    const extended =
      result.expiresAt === null ||
      (typeof result.expiresAt === 'number' &&
        typeof current.expiresAt === 'number' &&
        result.expiresAt > current.expiresAt + DAY_MS);
    if (!extended) result.retryAfter = Date.now() + RENEW_RETRY_MS;
    this.state.set(connectorId, result);
    if (extended) {
      await this.afterNewToken(connectorId, result);
      this.logger.log(
        `Connector ${connectorId}: token renewed` +
          (result.expiresAt ? `, valid until ${new Date(result.expiresAt).toISOString()}` : ', no expiry'),
      );
    } else {
      await this.warnIfExpiring(connectorId, result, spec, 'the provider did not extend the token');
    }
    return result.token;
  }

  private async afterNewToken(connectorId: string, st: TokenState): Promise<void> {
    await this.authStatus?.setTokenExpiry(connectorId, st.expiresAt ? new Date(st.expiresAt) : null);
    await this.authStatus?.clear(connectorId, { onlyCodes: WARNING_CODES });
  }

  /**
   * A token that will stop working soon and cannot be renewed here: say so.
   * One that already has is no longer a warning: the connector needs a new
   * token, and its owner gets the single email (an expired token cannot be
   * exchanged). The call still goes out; Meta's answer has the last word.
   */
  private async warnIfExpiring(
    connectorId: string,
    st: TokenState,
    spec: ResolvedTokenRenewal,
    failure?: string,
  ): Promise<void> {
    if (typeof st.expiresAt !== 'number') return;
    if (st.expiresAt <= Date.now()) {
      const message = expiredTokenHint(new Date(st.expiresAt), connectorId);
      if (this.warned.get(connectorId) === message) return;
      this.warned.set(connectorId, message);
      await this.authStatus?.mark(connectorId, {
        status: 'needs_reauth',
        code: 'token_expired',
        message,
        ref: st.sourceRef,
      });
      return;
    }
    const within = (spec.renewWithinDays ?? DEFAULT_RENEW_WITHIN_DAYS) * DAY_MS;
    if (st.expiresAt - Date.now() > within) return;
    if (!failure && this.shouldRenew(st, spec)) return; // will be renewed on this call
    const message = expiringHint(st.expiresAt, spec, failure);
    if (this.warned.get(connectorId) === message) return;
    this.warned.set(connectorId, message);
    await this.authStatus?.mark(connectorId, {
      status: 'expiring',
      code: 'meta_expiring',
      message,
      ref: st.sourceRef,
    });
  }

  private async loadState(connectorId: string): Promise<TokenState | undefined> {
    const cached = this.state.get(connectorId);
    if (cached || this.loaded.has(connectorId)) return cached;
    const stored = await this.readStored(connectorId, this.prisma).catch(() => undefined);
    this.loaded.add(connectorId);
    if (stored) this.state.set(connectorId, stored);
    return stored;
  }

  private async readStored(connectorId: string, db: Db): Promise<TokenState | undefined> {
    const row = await db.connectorAuthCache.findUnique({ where: { connectorId } });
    const meta = (row?.metadata ?? null) as { kind?: unknown; sourceRef?: unknown; obtainedAt?: unknown; neverExpires?: unknown } | null;
    if (!row || !meta || meta.kind !== CACHE_KIND || typeof meta.sourceRef !== 'string') return undefined;
    let token: string;
    try {
      token = decrypt(row.token, this.encryptionKey);
    } catch {
      return undefined;
    }
    return {
      sourceRef: meta.sourceRef,
      token,
      expiresAt: meta.neverExpires === true ? null : row.expiresAt.getTime(),
      obtainedAt: typeof meta.obtainedAt === 'number' ? meta.obtainedAt : undefined,
    };
  }

  private async writeStored(connectorId: string, st: TokenState, db: Db): Promise<void> {
    // The column is required: a token that never expires gets a far date and a flag.
    const expiresAt = new Date(st.expiresAt ?? Date.now() + 10 * 365 * DAY_MS);
    const data = {
      token: encrypt(st.token, this.encryptionKey),
      expiresAt,
      metadata: {
        kind: CACHE_KIND,
        sourceRef: st.sourceRef,
        obtainedAt: st.obtainedAt ?? Date.now(),
        neverExpires: st.expiresAt === null,
      },
    };
    await db.connectorAuthCache.upsert({
      where: { connectorId },
      create: { connectorId, ...data },
      update: data,
    });
  }

  /**
   * Runs `fn` under a Postgres advisory lock on the connector (the OAuth2
   * refresh does the same), so two processes never exchange at once. Runs
   * unlocked when no transaction can be had.
   */
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

  // ── provider calls ─────────────────────────────────────────────────────

  private graphBase(spec: ResolvedTokenRenewal): string {
    const version = /^v\d+\.\d+$/.test(spec.graphVersion ?? '') ? spec.graphVersion : DEFAULT_GRAPH_VERSION;
    return `https://graph.facebook.com/${version}`;
  }

  /** fb_exchange_token: a short- or long-lived user token in, a long-lived one out. */
  private async metaExchange(
    token: string,
    spec: ResolvedTokenRenewal,
  ): Promise<{ token: string; expiresAt: number | null }> {
    const res = await axios.get(`${this.graphBase(spec)}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: spec.appId,
        client_secret: spec.appSecret,
        fb_exchange_token: token,
      },
      timeout: HTTP_TIMEOUT_MS,
    });
    const accessToken = res.data?.access_token;
    if (typeof accessToken !== 'string' || !accessToken) throw new Error('the answer carried no access_token');
    const expiresIn = Number(res.data?.expires_in);
    return { token: accessToken, expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : null };
  }

  /** Instagram API with Instagram Login: refresh a long-lived token, no secret needed. */
  private async instagramRefresh(token: string): Promise<{ token: string; expiresAt: number | null }> {
    const res = await axios.get('https://graph.instagram.com/refresh_access_token', {
      params: { grant_type: 'ig_refresh_token', access_token: token },
      timeout: HTTP_TIMEOUT_MS,
    });
    const accessToken = res.data?.access_token;
    if (typeof accessToken !== 'string' || !accessToken) throw new Error('the answer carried no access_token');
    const expiresIn = Number(res.data?.expires_in);
    return { token: accessToken, expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : null };
  }

  /**
   * A Page token from a long-lived user token: it does not expire. Undefined
   * when the token cannot see the Page (then the user token is used).
   */
  private async derivePageToken(
    connectorId: string,
    user: TokenState,
    spec: ResolvedTokenRenewal,
  ): Promise<TokenState | undefined> {
    try {
      const res = await axios.get(`${this.graphBase(spec)}/${encodeURIComponent(spec.pageId!)}`, {
        params: { fields: 'access_token', access_token: user.token },
        timeout: HTTP_TIMEOUT_MS,
      });
      const pageToken = res.data?.access_token;
      if (typeof pageToken !== 'string' || !pageToken) return undefined;
      return { sourceRef: user.sourceRef, token: pageToken, expiresAt: null, obtainedAt: Date.now() };
    } catch (err) {
      this.logger.warn(`Connector ${connectorId}: could not derive a Page token (${describeError(err)})`);
      return undefined;
    }
  }

  /**
   * When a token expires, from debug_token. Asked with the app token when the
   * app id and secret are set, else with the token itself, which Meta accepts
   * from the app's own developers. Undefined when Meta does not say.
   */
  private async inspect(
    token: string,
    spec: ResolvedTokenRenewal,
  ): Promise<{ expiresAt: number | null; issuedAt?: number } | undefined> {
    if (spec.provider !== 'meta') return undefined;
    const accessToken = spec.appId && spec.appSecret ? `${spec.appId}|${spec.appSecret}` : token;
    const res = await axios.get(`${this.graphBase(spec)}/debug_token`, {
      params: { input_token: token, access_token: accessToken },
      timeout: HTTP_TIMEOUT_MS,
    });
    const data = res.data?.data;
    if (!data || typeof data !== 'object') return undefined;
    const expires = Number(data.expires_at);
    const issued = Number(data.issued_at);
    if (!Number.isFinite(expires)) return undefined;
    return {
      // 0 means the token does not expire (System User and Page tokens).
      expiresAt: expires === 0 ? null : expires * 1000,
      issuedAt: issued > 0 ? issued * 1000 : undefined,
    };
  }
}

function blockedError(message: string): Error & { status: number; hint: string } {
  const err = new Error(
    `Meta refused this connector's access token for good. No request was sent to the API. ${message}`,
  ) as Error & { status: number; hint: string };
  err.status = 401;
  err.hint = message;
  return err;
}

function varNames(spec: TokenRenewalSpec): string {
  return `${spec.appIdVar ?? 'META_APP_ID'} and ${spec.appSecretVar ?? 'META_APP_SECRET'}`;
}

function deadTokenHint(what: string, spec: TokenRenewalSpec, connectorId: string): string {
  const page = connectorPageUrl(connectorId);
  const where = `the connector's variables in AnythingMCP${page ? ` (${page})` : ''}`;
  return (
    `Meta ended this token's session (${what}); retrying will not help. Paste a new token into ${where}. ` +
    (spec.provider === 'meta'
      ? 'A System User token with expiry Never does not expire; a user token is exchanged for a ' +
        `long-lived one and renewed automatically when ${varNames(spec)} are set.`
      : 'Generate a new long-lived token for the Instagram account.')
  );
}

function expiringHint(expiresAt: number, spec: TokenRenewalSpec, failure?: string): string {
  const when = new Date(expiresAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const left = expiresAt - Date.now();
  const kind = left < 2 * DAY_MS ? 'a short-lived token' : 'a token that expires soon';
  if (spec.provider !== 'meta') {
    return `The access token expires on ${when}${failure ? ` and could not be renewed (${failure})` : ''}. Paste a new long-lived token before then.`;
  }
  if (failure) {
    return (
      `The Meta token expires on ${when} and could not be renewed (${failure}). Paste a new token, ` +
      'or a System User token with expiry Never, before then.'
    );
  }
  return (
    `This is ${kind}: it stops working on ${when}. Add your app id and secret (${varNames(spec)}) to ` +
    'renew it automatically, or paste a long-lived token (a System User token with expiry Never does not expire).'
  );
}

/** A provider failure in words safe to log: status and Meta's error, never the request. */
function describeError(err: unknown): string {
  const status = (err as { response?: { status?: unknown } })?.response?.status;
  const meta = metaGraphError(err);
  if (typeof status === 'number') {
    return [
      `HTTP ${status}`,
      meta?.code !== undefined ? `code ${meta.code}${meta.subcode ? `/${meta.subcode}` : ''}` : undefined,
      meta?.message,
    ]
      .filter(Boolean)
      .join(': ');
  }
  const e = err as { code?: unknown; message?: unknown };
  if (typeof e?.code === 'string') return e.code;
  return typeof e?.message === 'string' && !/access_token|client_secret/.test(e.message) ? e.message : 'network error';
}
