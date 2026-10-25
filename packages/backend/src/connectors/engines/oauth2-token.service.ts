import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../../common/prisma.service';
import { encrypt, decrypt } from '../../common/crypto/encryption.util';
import { getRequiredSecret } from '../../common/secrets.util';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';
import { interpolateDeep } from '../../common/env-interpolation.util';
import {
  clientAssertionParams,
  clientAssertionSettingsFrom,
  isPrivateKeyJwt,
} from './client-assertion.util';
import { outboundAxiosOptions } from '../../common/outbound-http';
import { connectorPageUrl } from '../../common/url.util';
import { isMachineGrant } from '../oauth-grant.util';
import { ConnectorAuthStatusService, credentialRef } from './connector-auth-status.service';

/** Refresh tokens that expire within this window (5 minutes). */
const PROACTIVE_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * How long before expiry a token is renewed. Five minutes, or half the
 * token's lifetime when that is shorter: Sage issues 5-minute access tokens,
 * so a flat 5-minute window made every call a refresh, and Sage rotates the
 * refresh token on each one.
 */
function refreshWindowMs(lifetimeMs: number | undefined): number {
  return lifetimeMs && lifetimeMs > 0
    ? Math.min(PROACTIVE_REFRESH_BUFFER_MS, lifetimeMs / 2)
    : PROACTIVE_REFRESH_BUFFER_MS;
}

/**
 * The cross-process refresh lock (see withRefreshLock): how long to wait for
 * a database connection to hold it, and how long the holding transaction may
 * live (the token request alone may take 10 s).
 */
const REFRESH_LOCK_MAX_WAIT_MS = 3_000;
const REFRESH_LOCK_TIMEOUT_MS = 30_000;
const REFRESH_LOCK_NAMESPACE = 'amcp:oauth2-refresh:';

/**
 * After a refresh token was refused, calls fail at once for this long before
 * the database is asked again whether the connector was re-authorized (by
 * another process, say). The token endpoint is not asked again until the
 * stored refresh token changes.
 */
const REFUSED_RECHECK_MS = 10 * 60 * 1000;

/** What a renewal may do besides asking the token endpoint. */
interface RenewOptions {
  /**
   * Take the token stored on the connector instead of spending the refresh
   * token, when another process (the other half of a blue/green deploy) or a
   * new authorization stored a usable one.
   */
  adoptStored?: boolean;
  /**
   * The API refused a token sent at this time: a stored token only counts
   * when it was obtained afterwards, whatever its expiry says.
   */
  rejectedAt?: number;
}

/** The connector reads and writes a renewal makes: the client, or the lock's transaction. */
type ConnectorDb = Pick<PrismaService, 'connector'>;

/** A renewed token that still has to be stored. */
interface Rotation {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  expiresIn?: number;
}

/** What a renewal under the lock obtained, and whether it was stored. */
interface PendingRotation {
  rotation?: Rotation;
  saved?: boolean;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
  /** The lifetime the provider gave the token, for refreshWindowMs. */
  lifetimeMs: number;
  /** When the token was obtained, so a caller holding an older one can tell. */
  obtainedAt: number;
}

/**
 * Shared OAuth2 token management: in-memory cache, proactive refresh, and DB persistence.
 * Used by RestEngine, GraphqlEngine, and McpClientEngine to handle OAuth2 token lifecycle.
 *
 * Proactive refresh: tokens are refreshed *before* they expire so callers never see a 401
 * due to token expiration.
 */
@Injectable()
export class OAuth2TokenService {
  private readonly logger = new Logger(OAuth2TokenService.name);
  private readonly encryptionKey: string;

  // In-memory cache for refreshed tokens (see keyFor)
  private tokenCache = new Map<string, CachedToken>();

  // Per-key mutex to prevent concurrent refresh storms
  private refreshInFlight = new Map<string, Promise<string | null>>();

  // Why the last token request for a key failed, in words safe to show the
  // caller (status + the provider's error code, never the request).
  private lastRefreshError = new Map<string, string>();

  // Connectors whose refresh token the provider refused (invalid_grant):
  // what to tell the caller, and when to look at the database again.
  private refused = new Map<string, { message: string; recheckAt: number }>();

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
   * Returns the best available access token, refreshing proactively if needed.
   *
   * 1. Cached token still valid (> 5 min remaining) → return immediately
   * 2. Token expired or near-expiry AND refreshToken available → refresh first, then return
   * 3. Refresh fails → fall back to stored token (caller's 401 retry will catch it)
   */
  async getAccessToken(
    authConfig: Record<string, unknown>,
    connectorId?: string,
  ): Promise<string> {
    const cacheKey = keyFor(authConfig, connectorId);
    const grant = String(authConfig.grant || 'refresh_token');

    // 1. Check cache — return immediately if well within validity
    if (cacheKey) {
      const cached = this.tokenCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now() + refreshWindowMs(cached.lifetimeMs)) {
        return cached.accessToken;
      }
    }

    // The provider refused this connector's refresh token: say so at once,
    // without asking the token endpoint or the API again.
    const refusedError = this.refusedRefreshError(connectorId);
    if (refusedError) throw refusedError;

    // 2. Determine if proactive refresh is possible and needed.
    // client_credentials needs only tokenUrl + clientId/Secret; password needs
    // tokenUrl + username/password; refresh_token needs a stored refreshToken.
    const hasRefreshCapability =
      grant === 'client_credentials'
        ? !!(
            authConfig.tokenUrl &&
            authConfig.clientId &&
            (authConfig.clientSecret || isPrivateKeyJwt(authConfig.tokenAuthMethod))
          )
        : grant === 'password'
          ? !!(authConfig.tokenUrl && authConfig.username && authConfig.password)
          : !!(authConfig.refreshToken && authConfig.tokenUrl);
    const tokenNearExpiry = this.isTokenNearExpiry(authConfig, cacheKey);

    let refreshFailed = false;
    if (hasRefreshCapability && tokenNearExpiry) {
      this.logger.debug(`OAuth2 (${grant}): token near expiry, proactive refresh...`);
      const refreshed = await this.refreshTokenWithMutex(authConfig, connectorId);
      if (refreshed) {
        return refreshed;
      }
      // The refresh token was refused for good: the stored access token has
      // expired or is about to, so sending it would only earn a 401.
      const refused = this.refusedRefreshError(connectorId);
      if (refused) throw refused;
      // Refresh failed — fall through to return stored token
      refreshFailed = true;
    }

    // 3. Return the best available token (cached or stored)
    if (cacheKey) {
      const cached = this.tokenCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.accessToken;
      }
    }

    const stored = String(authConfig.accessToken || '');
    // A client_credentials or password connector has no token but the one it
    // fetches. When that fetch fails, sending `Authorization: Bearer ` anyway
    // only trades the token endpoint's precise answer for the API's vaguest
    // one: Reddit answers an empty bearer with its HTML "Blocked" page, and 52
    // calls failed that way with nobody able to tell a wrong client secret
    // from a bot wall. Stop here and say what the token endpoint said.
    if (isMachineGrant(grant) && !stored) {
      const reason = cacheKey ? this.lastRefreshError.get(cacheKey) : undefined;
      let host = 'the token endpoint';
      try {
        host = new URL(String(authConfig.tokenUrl)).host;
      } catch {
        // keep the generic wording
      }
      const err = new Error(
        `OAuth2 ${grant}: could not obtain an access token from ${host}` +
          (reason ? ` (${reason})` : '') +
          '. No request was sent to the API. ' +
          (grant === 'password'
            ? 'Check the username and password, and the client ID and client secret if the provider needs them.'
            : 'Check the client ID and client secret.'),
      ) as Error & { status?: number };
      // Lets the install-form probe classify this as rejected credentials.
      err.status = 401;
      throw err;
    }
    // The refresh-token grant, with nothing to send. Same reasoning as above:
    // `Authorization: Bearer ` earns the API's vaguest answer — Etsy's is
    // `403 Invalid access token: not a Bearer token`, which sent a user
    // looking at the token's format when the refresh token itself had been
    // refused. Only reached when there is no token at all, so a connector that
    // has one (stored, or cached) behaves exactly as before.
    if (!isMachineGrant(grant) && !stored) {
      if (refreshFailed) {
        const reason = cacheKey ? this.lastRefreshError.get(cacheKey) : undefined;
        throw unauthorized(
          `OAuth2: could not renew the access token at ${hostOf(authConfig.tokenUrl)}` +
            (reason ? ` (${reason})` : '') +
            '. No request was sent to the API. If the refresh token was refused, ' +
            'authorize the connector again (Authorize with Provider on its page in AnythingMCP) ' +
            'or replace its refresh token.',
        );
      }
      if (!authConfig.refreshToken && authConfig.authorizationUrl) {
        const page = connectorPageUrl(connectorId);
        throw unauthorized(
          'OAuth2: this connector has not been authorized yet. No request was sent to the API. ' +
            `Open the connector in AnythingMCP${page ? ` (${page})` : ''} and click Authorize with Provider.`,
        );
      }
    }
    return stored;
  }

  /**
   * Refresh the OAuth2 access token using the refresh token.
   * On success: caches in-memory and persists to DB.
   * Returns the new access token, or null on failure.
   *
   * For a saved connector the whole renewal (read the stored refresh token,
   * ask the token endpoint, store what it returned) runs under a database
   * lock on the connector, so two processes never spend the same refresh
   * token: a provider that rotates it (Cloudinary, JTL, Sage, DATEV) accepts
   * the first and refuses the second with invalid_grant.
   */
  async refreshToken(
    authConfig: Record<string, unknown>,
    connectorId?: string,
    options: RenewOptions = {},
  ): Promise<string | null> {
    if (!connectorId) return this.renew(authConfig, undefined, this.prisma, options);
    return this.withRefreshLock(connectorId, (db, pending) =>
      this.renew(authConfig, connectorId, db, options, pending),
    );
  }

  /**
   * Runs `fn` while holding a Postgres advisory lock on the connector, inside
   * a transaction whose client `fn` uses for its reads and writes (one
   * connection, so a full pool cannot deadlock against itself). The renewed
   * token is written before the lock is released; should the transaction
   * fail after the token endpoint answered, the token is written again
   * outside it rather than lost.
   *
   * Without a way to take the lock (no interactive transactions, or no
   * connection free within REFRESH_LOCK_MAX_WAIT_MS) the renewal runs
   * unlocked, as it did before, guarded only by the in-process mutex.
   */
  private async withRefreshLock(
    connectorId: string,
    fn: (db: ConnectorDb, pending: PendingRotation) => Promise<string | null>,
  ): Promise<string | null> {
    const prisma = this.prisma as unknown as {
      $transaction?: (
        run: (tx: any) => Promise<void>,
        opts: { maxWait: number; timeout: number },
      ) => Promise<void>;
    };
    if (typeof prisma.$transaction !== 'function') {
      return fn(this.prisma, {});
    }

    const pending: PendingRotation = {};
    let started = false;
    let outcome: { value: string | null } | undefined;
    let failure: unknown;
    try {
      await prisma.$transaction(
        async (tx) => {
          started = true;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${REFRESH_LOCK_NAMESPACE + connectorId}))`;
          outcome = { value: await fn(tx, pending) };
        },
        { maxWait: REFRESH_LOCK_MAX_WAIT_MS, timeout: REFRESH_LOCK_TIMEOUT_MS },
      );
    } catch (err: any) {
      if (!started) {
        this.logger.warn(
          `OAuth2: no database connection for the refresh lock of connector ${connectorId} ` +
            `(${err?.message ?? err}); refreshing without it`,
        );
        return fn(this.prisma, {});
      }
      failure = err;
    }

    // The token endpoint rotated the refresh token, but the write did not
    // survive (it failed, which leaves Postgres to roll the transaction back
    // on commit, or the transaction itself failed): store it again outside,
    // or the connector is left holding a refresh token the provider revoked.
    if (pending.rotation && (failure !== undefined || !pending.saved)) {
      this.logger.warn(
        `OAuth2: the renewed token of connector ${connectorId} was not stored under the refresh lock` +
          (failure !== undefined ? ` (${(failure as Error)?.message ?? failure})` : '') +
          '; storing it again',
      );
      const r = pending.rotation;
      await this.persistRefreshedToken(this.prisma, connectorId, r.accessToken, r.refreshToken, r.expiresAt, r.expiresIn);
      return r.accessToken;
    }
    if (outcome) return outcome.value;
    throw failure;
  }

  /**
   * The stored token, when it can be used instead of a renewal (see
   * RenewOptions.adoptStored). Cached like a renewed one.
   */
  private adoptStoredToken(
    stored: Record<string, unknown>,
    connectorId: string,
    options: RenewOptions,
  ): string | null {
    if (!options.adoptStored) return null;
    const accessToken = typeof stored.accessToken === 'string' ? stored.accessToken : '';
    const expiresAt = Number(stored.expiresAt);
    if (!accessToken || !Number.isFinite(expiresAt) || expiresAt <= 0) return null;

    const obtainedAt =
      Date.parse(String(stored.lastRefreshedAt ?? stored.authorizedAt ?? '')) || 0;
    const expiresIn = Number(stored.expiresIn);
    const lifetimeMs =
      expiresIn > 0 ? expiresIn * 1000 : obtainedAt ? Math.max(0, expiresAt - obtainedAt) : 0;
    const now = Date.now();

    const usable =
      options.rejectedAt !== undefined
        ? obtainedAt > options.rejectedAt && expiresAt > now
        : expiresAt > now + refreshWindowMs(lifetimeMs || undefined);
    if (!usable) return null;

    this.tokenCache.set(connectorId, {
      accessToken,
      expiresAt,
      lifetimeMs: lifetimeMs || expiresAt - now,
      obtainedAt: obtainedAt || now,
    });
    this.lastRefreshError.delete(connectorId);
    this.logger.debug(`OAuth2: using the token stored on connector ${connectorId} instead of renewing`);
    return accessToken;
  }

  private async renew(
    authConfig: Record<string, unknown>,
    connectorId: string | undefined,
    db: ConnectorDb,
    options: RenewOptions,
    pending: PendingRotation = {},
  ): Promise<string | null> {
    const cacheKey = keyFor(authConfig, connectorId);
    // Refused a moment ago (see refusedRefreshError): not again.
    if (this.refusedRefreshError(connectorId)) return null;
    // Rolling refresh tokens (e.g. DATEV rotates the refresh token on every
    // use) invalidate the previous one. The in-memory registry caches an
    // authConfig snapshot that is NOT updated after a refresh — only the DB is
    // (persistRefreshedToken). So for a persisted connector always re-read the
    // freshest authConfig from the DB before refreshing; otherwise a second
    // refresh would replay the already-rotated token and DATEV would reject it.
    // The connector's own headers, for the User-Agent the API calls carry.
    let connectorHeaders: unknown;
    if (connectorId) {
      const fresh = await this.loadAuthConfigFromDb(connectorId, db);
      if (fresh) {
        const adopted = this.adoptStoredToken(fresh.authConfig, connectorId, options);
        if (adopted) return adopted;
        authConfig = { ...authConfig, ...fresh.authConfig };
        // Refused before (by this process or another), and nobody has
        // authorized again since: the token endpoint would refuse it again.
        const status = fresh.status;
        if (
          status?.authStatus === 'needs_reauth' &&
          status.authStatusRef &&
          !isMachineGrant(String(authConfig.grant || 'refresh_token')) &&
          status.authStatusRef === credentialRef(String(authConfig.refreshToken || ''))
        ) {
          this.noteRefused(
            connectorId,
            status.authStatusMessage || genericRefusedHint(authConfig.tokenUrl, connectorId),
          );
          this.lastRefreshError.set(
            cacheKey,
            'the provider refused this refresh token before; it was not sent again',
          );
          return null;
        }
      }
      connectorHeaders = fresh?.headers;
    }

    const tokenUrl = String(authConfig.tokenUrl || '');
    const grant = String(authConfig.grant || 'refresh_token');
    const refreshToken = String(authConfig.refreshToken || '');
    const clientId = authConfig.clientId
      ? String(authConfig.clientId)
      : undefined;
    const clientSecret = authConfig.clientSecret
      ? String(authConfig.clientSecret)
      : undefined;
    // Adapters write `scope`; the connector form writes `scopes`.
    const scope = authConfig.scope
      ? String(authConfig.scope)
      : authConfig.scopes
        ? String(authConfig.scopes)
        : undefined;
    // private_key_jwt: the client proves itself with a JWT signed by its own
    // key (RFC 7523), so there is no client secret to send or to require.
    const privateKeyJwt = isPrivateKeyJwt(authConfig.tokenAuthMethod);

    if (!tokenUrl) {
      this.logger.warn('OAuth2 refresh: missing tokenUrl');
      return null;
    }

    if (grant === 'client_credentials') {
      // SAP S/4HANA Cloud Public Edition and most service-to-service OAuth2
      // servers reject client_id/client_secret in the body — they MUST be
      // sent via HTTP Basic Authorization header (RFC 6749 §2.3.1). We rely
      // on the Basic header path and keep the body to grant_type + scope,
      // unless the adapter sets tokenAuthMethod: client_secret_post.
      if (!clientId || (!clientSecret && !privateKeyJwt)) {
        this.logger.warn(
          'OAuth2 client_credentials: missing clientId/clientSecret',
        );
        return null;
      }
    } else if (grant === 'password') {
      if (!authConfig.username || !authConfig.password) {
        this.logger.warn('OAuth2 password: missing username/password');
        return null;
      }
    } else if (!refreshToken) {
      this.logger.warn('OAuth2 refresh: missing refreshToken');
      return null;
    }

    try {
      let body: Record<string, string>;
      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
      };
      // The adapter's User-Agent applies to the token request too. Reddit
      // throttles generic agents ("axios/1.x" is one) and asks every client,
      // token endpoint included, to identify itself. Only the User-Agent is
      // forwarded: other extraHeaders (Etsy's x-api-key) belong to the API.
      const userAgent = tokenEndpointUserAgent(authConfig, connectorHeaders);
      if (userAgent) headers['User-Agent'] = userAgent;

      if (isMachineGrant(grant)) {
        body =
          grant === 'password'
            ? {
                grant_type: 'password',
                username: String(authConfig.username),
                password: String(authConfig.password),
              }
            : { grant_type: 'client_credentials' };
        if (scope) body.scope = scope;
        if (privateKeyJwt) {
          Object.assign(
            body,
            clientAssertionParams(clientAssertionSettingsFrom(authConfig, tokenUrl)),
          );
        } else if (
          authConfig.tokenAuthMethod === 'post' ||
          authConfig.tokenAuthMethod === 'client_secret_post'
        ) {
          // client_secret_post — the other method RFC 6749 §2.3.1 allows,
          // and the only one some servers document: Amadeus's token
          // endpoint takes client_id/client_secret as form fields.
          if (clientId) body.client_id = String(clientId);
          if (clientSecret) body.client_secret = String(clientSecret);
        } else if (clientId && clientSecret) {
          // Datto RMM's password grant takes its fixed client this way:
          // Basic public-client:public.
          const basic = Buffer.from(`${clientId}:${clientSecret}`).toString(
            'base64',
          );
          headers.Authorization = `Basic ${basic}`;
        } else if (clientId) {
          // A public client on the password grant: identified, no secret.
          body.client_id = String(clientId);
        }
      } else {
        body = {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        };
        // RFC 8707: an MCP connector authorized with a resource indicator
        // asks for tokens for that same resource on every refresh.
        if (typeof authConfig.resource === 'string' && authConfig.resource) {
          body.resource = authConfig.resource;
        }
        const useBasic =
          authConfig.tokenAuthMethod === 'basic' ||
          authConfig.tokenAuthMethod === 'client_secret_basic';
        if (privateKeyJwt) {
          // A new assertion per request: Revolut Business rejects a refresh
          // whose assertion has expired, and asks for short-lived ones. The
          // client id travels in the assertion's `sub`, not the body.
          Object.assign(
            body,
            clientAssertionParams(clientAssertionSettingsFrom(authConfig, tokenUrl)),
          );
        } else if (useBasic && clientId && clientSecret) {
          // client_secret_basic — credentials in the Authorization header.
          // DATEV and other confidential-client providers reject body creds.
          if (clientId) body.client_id = clientId;
          const basic = Buffer.from(`${clientId}:${clientSecret}`).toString(
            'base64',
          );
          headers.Authorization = `Basic ${basic}`;
        } else {
          if (clientId) body.client_id = clientId;
          // A public client ('none') never sends a secret.
          if (clientSecret && authConfig.tokenAuthMethod !== 'none') {
            body.client_secret = clientSecret;
          }
        }
      }

      // A few providers renew at their own endpoint: Worksection issues
      // tokens at /oauth2/token but only refreshes at /oauth2/refresh, and
      // answers a refresh sent to /oauth2/token without an access_token.
      const postUrl =
        !isMachineGrant(grant) && typeof authConfig.refreshUrl === 'string' && authConfig.refreshUrl
          ? authConfig.refreshUrl
          : tokenUrl;
      await assertSafeOutboundUrl(postUrl);
      const response = await axios.post(
        postUrl,
        new URLSearchParams(body).toString(),
        {
          headers,
          timeout: 10000,
          ...outboundAxiosOptions({ credentialsInBody: true }),
        },
      );

      const { access_token, expires_in, refresh_token: newRefreshToken } =
        response.data;
      if (!access_token) {
        this.lastRefreshError.set(cacheKey, 'the response carried no access_token');
        return null;
      }
      this.lastRefreshError.delete(cacheKey);

      // Cache the new token
      const expiresInMs = (expires_in || 3600) * 1000;
      this.tokenCache.set(cacheKey, {
        accessToken: access_token,
        expiresAt: Date.now() + expiresInMs,
        lifetimeMs: expiresInMs,
        obtainedAt: Date.now(),
      });

      // Persist to DB if connectorId is available. For client_credentials
      // and password there's no refresh_token to use — we just record the
      // latest access_token + its expiry so a cold-start can reuse it.
      if (connectorId) {
        const rotation: Rotation = {
          accessToken: access_token,
          refreshToken: newRefreshToken || refreshToken || '',
          expiresAt: Date.now() + expiresInMs,
          expiresIn: expires_in,
        };
        pending.rotation = rotation;
        pending.saved = await this.persistRefreshedToken(
          db,
          connectorId,
          rotation.accessToken,
          rotation.refreshToken,
          rotation.expiresAt,
          rotation.expiresIn,
        );
      }

      // A token came back: whatever was recorded against the old one is over.
      if (connectorId) {
        this.refused.delete(connectorId);
        await this.authStatus?.clear(connectorId);
      }

      this.logger.debug(`OAuth2 (${grant}): token refreshed successfully`);
      return access_token;
    } catch (err: any) {
      const reason = describeTokenError(err);
      this.logger.warn(
        `OAuth2 (${grant}) token refresh failed` +
          (connectorId ? ` for connector ${connectorId}` : '') +
          `: ${reason}`,
      );
      this.lastRefreshError.set(cacheKey, reason);
      // The refresh token itself was refused (expired, revoked, already
      // rotated): no retry can succeed until someone authorizes again.
      // Remember it, so the next calls neither ask the token endpoint nor
      // send an expired token to the API, and tell the workspace.
      if (connectorId && !isMachineGrant(grant) && isRefusedRefreshToken(err)) {
        const issue = refusedRefreshIssue({
          tokenUrl,
          authorizedAt: authConfig.authorizedAt,
          reason,
          connectorId,
        });
        this.noteRefused(connectorId, issue.message);
        await this.authStatus?.mark(connectorId, {
          status: 'needs_reauth',
          code: issue.code,
          message: issue.message,
          ref: credentialRef(refreshToken),
        });
      }
      return null;
    }
  }

  private noteRefused(connectorId: string, message: string): void {
    this.refused.set(connectorId, { message, recheckAt: Date.now() + REFUSED_RECHECK_MS });
  }

  /**
   * The error for a call on a connector whose refresh token was refused,
   * while that is fresh in memory; undefined otherwise, and once
   * REFUSED_RECHECK_MS has passed, so the next renewal looks at the database
   * again (where a re-authorization by another process would show).
   */
  private refusedRefreshError(
    connectorId?: string,
  ): (Error & { status?: number; hint?: string }) | undefined {
    if (!connectorId) return undefined;
    const entry = this.refused.get(connectorId);
    if (!entry) return undefined;
    if (Date.now() >= entry.recheckAt) {
      this.refused.delete(connectorId);
      return undefined;
    }
    const err = unauthorized(
      "OAuth2: the provider refused this connector's refresh token, so no new access token can be " +
        `obtained. No request was sent to the API. ${entry.message}`,
    ) as Error & { status?: number; hint?: string };
    err.hint = entry.message;
    return err;
  }

  /**
   * A new token after the API answered 401 to a request sent at `sentAt`.
   *
   * Goes through the same mutex as the proactive refresh, and first takes a
   * token another call obtained after `sentAt`. A burst of calls that all hit
   * 401 used to refresh once each with the same refresh token: a provider
   * that rotates it (JTL, Sage, DATEV) accepts the first and refuses or
   * revokes the rest.
   */
  async renewAfterRejection(
    authConfig: Record<string, unknown>,
    connectorId: string | undefined,
    sentAt: number,
  ): Promise<string | null> {
    const cached = this.tokenCache.get(keyFor(authConfig, connectorId));
    if (cached && cached.obtainedAt >= sentAt && cached.expiresAt > Date.now()) {
      return cached.accessToken;
    }
    return this.refreshTokenWithMutex(authConfig, connectorId, {
      adoptStored: true,
      rejectedAt: sentAt,
    });
  }

  /**
   * The error to give the caller when the API refused the token and the
   * renewal failed too: the API's bare 401 says nothing about why, while the
   * token endpoint usually does ("The refresh token is invalid. Token has
   * been revoked"). Undefined when no renewal failed.
   */
  renewalFailedError(
    authConfig: Record<string, unknown>,
    connectorId?: string,
  ): (Error & { status?: number }) | undefined {
    const refused = this.refusedRefreshError(connectorId);
    if (refused) return refused;
    const reason = this.lastRefreshError.get(keyFor(authConfig, connectorId));
    if (!reason) return undefined;
    return unauthorized(
      `OAuth2: the API refused the access token (401) and it could not be renewed at ` +
        `${hostOf(authConfig.tokenUrl)} (${reason}). ` +
        (isMachineGrant(authConfig.grant)
          ? `Check the credentials the ${String(authConfig.grant)} grant sends to the token URL.`
          : 'If the refresh token was refused, authorize the connector again ' +
            '(Authorize with Provider on its page in AnythingMCP) or replace its refresh token.'),
    );
  }

  /**
   * Drop what is held in memory for a connector whose credentials were just
   * replaced (a new authorization, new client settings), so the next call
   * uses the stored ones instead of a token or an error from before.
   */
  forget(connectorId: string): void {
    this.tokenCache.delete(connectorId);
    this.lastRefreshError.delete(connectorId);
    this.refused.delete(connectorId);
  }

  /**
   * Wraps refreshToken with a per-key mutex to prevent concurrent refresh
   * storms: every caller in this process that needs a new token for the
   * connector while one is being obtained waits for that one. Across
   * processes, refreshToken's database lock does the same, and a renewal
   * that waited there takes the token the other process stored.
   */
  private async refreshTokenWithMutex(
    authConfig: Record<string, unknown>,
    connectorId?: string,
    options: RenewOptions = { adoptStored: true },
  ): Promise<string | null> {
    const cacheKey = keyFor(authConfig, connectorId);

    // If a refresh is already in-flight for this key, wait for it
    const inFlight = this.refreshInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const refreshPromise = this.refreshToken(authConfig, connectorId, options).finally(() => {
      this.refreshInFlight.delete(cacheKey);
    });

    this.refreshInFlight.set(cacheKey, refreshPromise);
    return refreshPromise;
  }

  /**
   * Check if the token is expired or near-expiry.
   */
  private isTokenNearExpiry(
    authConfig: Record<string, unknown>,
    cacheKey: string,
  ): boolean {
    const now = Date.now();

    // Check cached token first
    if (cacheKey) {
      const cached = this.tokenCache.get(cacheKey);
      if (cached) {
        return cached.expiresAt <= now + refreshWindowMs(cached.lifetimeMs);
      }
    }

    // Check expiresAt from authConfig (set during initial OAuth grant or previous refresh)
    if (authConfig.expiresAt) {
      const expiresAt = Number(authConfig.expiresAt);
      const expiresIn = Number(authConfig.expiresIn);
      return (
        expiresAt <= now + refreshWindowMs(expiresIn > 0 ? expiresIn * 1000 : undefined)
      );
    }

    // No expiry info — assume token may be stale, try proactive refresh
    return true;
  }

  /**
   * Reads and decrypts the connector's current authConfig straight from the DB.
   * Used to obtain the freshest (possibly-rotated) refresh token, bypassing the
   * stale in-memory registry snapshot. Returns null if unavailable.
   */
  private async loadAuthConfigFromDb(
    connectorId: string,
    db: ConnectorDb = this.prisma,
  ): Promise<{
    authConfig: Record<string, unknown>;
    headers: unknown;
    status?: {
      authStatus: string | null;
      authStatusRef: string | null;
      authStatusMessage: string | null;
    };
  } | null> {
    try {
      const connector = await db.connector.findUnique({
        where: { id: connectorId },
        select: {
          authConfig: true,
          envVars: true,
          headers: true,
          authStatus: true,
          authStatusRef: true,
          authStatusMessage: true,
        },
      });
      if (!connector?.authConfig) return null;
      const envVars = (connector.envVars as Record<string, string> | null) ?? {};
      // Resolved like the tool path resolves the snapshot it hands us. A
      // connector whose credentials were typed after install keeps
      // `{{ETSY_REFRESH_TOKEN}}` (and the client id/secret) as placeholders in
      // authConfig, with the values in envVars; merging the raw row over the
      // resolved snapshot put the placeholders back, and the token endpoint
      // was sent `refresh_token={{ETSY_REFRESH_TOKEN}}`. Literal values
      // contain no placeholder and pass through unchanged.
      return {
        authConfig: interpolateDeep(
          JSON.parse(decrypt(connector.authConfig, this.encryptionKey)),
          envVars,
        ),
        headers: interpolateDeep(connector.headers ?? undefined, envVars),
        status: {
          authStatus: connector.authStatus ?? null,
          authStatusRef: connector.authStatusRef ?? null,
          authStatusMessage: connector.authStatusMessage ?? null,
        },
      };
    } catch (err: any) {
      this.logger.warn(
        `OAuth2: failed to load fresh authConfig for ${connectorId}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Store a renewed token on the connector. False when the write failed, so
   * the caller can try again outside a transaction that may not commit.
   */
  private async persistRefreshedToken(
    db: ConnectorDb,
    connectorId: string,
    newAccessToken: string,
    newRefreshToken: string,
    expiresAt: number,
    expiresIn?: number,
  ): Promise<boolean> {
    try {
      const connector = await db.connector.findUnique({
        where: { id: connectorId },
        select: { authConfig: true },
      });

      // Deleted meanwhile, or never had credentials: nothing to keep.
      if (!connector?.authConfig) return true;

      const authConfig = JSON.parse(
        decrypt(connector.authConfig, this.encryptionKey),
      );
      authConfig.accessToken = newAccessToken;
      authConfig.refreshToken = newRefreshToken;
      authConfig.expiresAt = expiresAt;
      if (typeof expiresIn === 'number' && expiresIn > 0) authConfig.expiresIn = expiresIn;
      authConfig.lastRefreshedAt = new Date().toISOString();

      await db.connector.update({
        where: { id: connectorId },
        data: {
          authConfig: encrypt(
            JSON.stringify(authConfig),
            this.encryptionKey,
          ),
        },
      });

      this.logger.debug(
        `OAuth2: persisted refreshed token for connector ${connectorId}`,
      );
      return true;
    } catch (err: any) {
      this.logger.warn(
        `OAuth2: failed to persist refreshed token for connector ${connectorId}: ${err.message}`,
      );
      return false;
    }
  }
}

/**
 * What the cache, the mutex and the last error are keyed on. A saved
 * connector is keyed on its id. A config without one (tried before it is
 * saved) gets a key of its own, tied to that config object: the token URL
 * alone, the old key, is the same for every workspace that uses the
 * provider, so one workspace's token could be served to another's call.
 */
const unsavedKeys = new WeakMap<object, string>();
let unsavedSeq = 0;

function keyFor(authConfig: Record<string, unknown>, connectorId?: string): string {
  if (connectorId) return connectorId;
  let key = unsavedKeys.get(authConfig);
  if (!key) {
    key = `unsaved:${++unsavedSeq}`;
    unsavedKeys.set(authConfig, key);
  }
  return key;
}

/** An error the install-form probe and the tool path classify as rejected credentials. */
function unauthorized(message: string): Error & { status?: number } {
  const err = new Error(message) as Error & { status?: number };
  err.status = 401;
  return err;
}

function hostOf(url: unknown): string {
  try {
    return new URL(String(url)).host;
  } catch {
    return 'the token endpoint';
  }
}

/** Case-insensitive lookup in an adapter's extraHeaders object. */
/**
 * The User-Agent for a request to the token endpoint: the one the API calls
 * carry, so a provider that identifies clients by it (Reddit throttles
 * generic agents such as "axios/1.x") sees the same client at both. The REST
 * engine sends the connector's headers with authConfig.extraHeaders on top,
 * so extraHeaders wins here too. Undefined when neither sets one, which
 * leaves the HTTP client's default as before.
 */
export function tokenEndpointUserAgent(
  authConfig: Record<string, unknown> | undefined,
  connectorHeaders?: unknown,
): string | undefined {
  return (
    findHeader(authConfig?.extraHeaders, 'user-agent') ??
    findHeader(connectorHeaders, 'user-agent')
  );
}

function findHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === name && typeof v === 'string' && v) return v;
  }
  return undefined;
}

/**
 * A token-endpoint failure in words that are safe to hand back to the caller:
 * the HTTP status plus the provider's own error code (RFC 6749 §5.2
 * `error`/`error_description`, or Reddit's `message`). Never the raw body,
 * which might be an HTML page, and never anything from the request.
 */
function describeTokenError(err: any): string {
  const status = err?.response?.status;
  if (typeof status !== 'number') return String(err?.code || err?.message || 'network error');
  const data = err.response.data;
  const fields =
    data && typeof data === 'object'
      ? [data.error, data.error_description, data.message]
          .filter((v) => typeof v === 'string' && v.length > 0)
          .map((v: string) => v.slice(0, 120))
      : [];
  return [`HTTP ${status}`, ...new Set(fields)].join(': ');
}

/**
 * The token endpoint refused the refresh token itself, as opposed to a
 * network error, a 5xx or a misconfigured client. RFC 6749 §5.2 calls it
 * invalid_grant (Google, Microsoft, Salesforce, Xero, Dropbox, Reddit…);
 * a few providers use a word of their own.
 */
export function isRefusedRefreshToken(err: any): boolean {
  const status = err?.response?.status;
  if (typeof status !== 'number' || status < 400 || status >= 500) return false;
  const data = err.response.data;
  if (!data || typeof data !== 'object') return false;
  const code = typeof data.error === 'string' ? data.error : '';
  if (['invalid_grant', 'invalid_refresh_token', 'expired_refresh_token'].includes(code)) return true;
  // HubSpot answers {"status":"BAD_REFRESH_TOKEN"}.
  return data.status === 'BAD_REFRESH_TOKEN';
}

const GOOGLE_TOKEN_HOSTS = new Set(['oauth2.googleapis.com', 'accounts.google.com', 'www.googleapis.com']);
const DAY_MS = 24 * 60 * 60 * 1000;

export const GOOGLE_TESTING_APP_HINT =
  'Google revoked the sign-in 7 days after it was granted. This happens when the OAuth app in your ' +
  "Google Cloud project is in 'Testing'. Publish it ('In production') under APIs & Services → " +
  'OAuth consent screen, then click Authorize with Provider again.';

function genericRefusedHint(tokenUrl: unknown, connectorId?: string, reason?: string): string {
  const page = connectorPageUrl(connectorId);
  return (
    `The provider (${hostOf(tokenUrl)}) refused the refresh token${reason ? ` (${reason})` : ''}: it ` +
    'has expired or was revoked, and retrying will not help. Authorize again: open the connector in ' +
    `AnythingMCP${page ? ` (${page})` : ''} and click Authorize with Provider.`
  );
}

/**
 * What to tell the user about a refused refresh token. Google refuses the
 * refresh tokens of an OAuth app in "Testing" 7 days after consent, so a
 * refusal 6.5 to 8 days after the last authorization almost certainly means
 * that, and the fix is in the Google Cloud console rather than here.
 */
export function refusedRefreshIssue(input: {
  tokenUrl: unknown;
  authorizedAt: unknown;
  reason?: string;
  connectorId?: string;
  now?: number;
}): { code: 'google_testing_7d' | 'refresh_refused'; message: string } {
  const host = hostOf(input.tokenUrl);
  const authorizedAt = Date.parse(String(input.authorizedAt ?? ''));
  const age = (input.now ?? Date.now()) - authorizedAt;
  if (
    GOOGLE_TOKEN_HOSTS.has(host) &&
    Number.isFinite(authorizedAt) &&
    age >= 6.5 * DAY_MS &&
    age <= 8 * DAY_MS
  ) {
    return { code: 'google_testing_7d', message: GOOGLE_TESTING_APP_HINT };
  }
  return {
    code: 'refresh_refused',
    message: genericRefusedHint(input.tokenUrl, input.connectorId, input.reason),
  };
}
