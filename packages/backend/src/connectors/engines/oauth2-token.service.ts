import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../../common/prisma.service';
import { encrypt, decrypt } from '../../common/crypto/encryption.util';
import { getRequiredSecret } from '../../common/secrets.util';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';
import { interpolateDeep } from '../../common/env-interpolation.util';

/** Refresh tokens that expire within this window (5 minutes). */
const PROACTIVE_REFRESH_BUFFER_MS = 5 * 60 * 1000;

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

  // In-memory cache for refreshed tokens (keyed by connectorId or tokenUrl)
  private tokenCache = new Map<
    string,
    { accessToken: string; expiresAt: number }
  >();

  // Per-key mutex to prevent concurrent refresh storms
  private refreshInFlight = new Map<string, Promise<string | null>>();

  // Why the last token request for a key failed, in words safe to show the
  // caller (status + the provider's error code, never the request).
  private lastRefreshError = new Map<string, string>();

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
    const cacheKey = connectorId || String(authConfig.tokenUrl || '');
    const grant = String(authConfig.grant || 'refresh_token');

    // 1. Check cache — return immediately if well within validity
    if (cacheKey) {
      const cached = this.tokenCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now() + PROACTIVE_REFRESH_BUFFER_MS) {
        return cached.accessToken;
      }
    }

    // 2. Determine if proactive refresh is possible and needed.
    // client_credentials needs only tokenUrl + clientId/Secret; refresh_token
    // also needs a stored refreshToken.
    const hasRefreshCapability =
      grant === 'client_credentials'
        ? !!(authConfig.tokenUrl && authConfig.clientId && authConfig.clientSecret)
        : !!(authConfig.refreshToken && authConfig.tokenUrl);
    const tokenNearExpiry = this.isTokenNearExpiry(authConfig, cacheKey);

    let refreshFailed = false;
    if (hasRefreshCapability && tokenNearExpiry) {
      this.logger.debug(`OAuth2 (${grant}): token near expiry, proactive refresh...`);
      const refreshed = await this.refreshTokenWithMutex(authConfig, connectorId);
      if (refreshed) {
        return refreshed;
      }
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
    // A client_credentials connector has no token but the one it fetches. When
    // that fetch fails, sending `Authorization: Bearer ` anyway only trades the
    // token endpoint's precise answer for the API's vaguest one: Reddit
    // answers an empty bearer with its HTML "Blocked" page, and 52 calls
    // failed that way with nobody able to tell a wrong client secret from a
    // bot wall. Stop here and say what the token endpoint said.
    if (grant === 'client_credentials' && !stored) {
      const reason = cacheKey ? this.lastRefreshError.get(cacheKey) : undefined;
      let host = 'the token endpoint';
      try {
        host = new URL(String(authConfig.tokenUrl)).host;
      } catch {
        // keep the generic wording
      }
      const err = new Error(
        `OAuth2 client_credentials: could not obtain an access token from ${host}` +
          (reason ? ` (${reason})` : '') +
          '. No request was sent to the API. Check the client ID and client secret.',
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
    if (grant !== 'client_credentials' && !stored) {
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
        throw unauthorized(
          'OAuth2: this connector has not been authorized yet. No request was sent to the API. ' +
            'Open the connector in AnythingMCP and click Authorize with Provider.',
        );
      }
    }
    return stored;
  }

  /**
   * Refresh the OAuth2 access token using the refresh token.
   * On success: caches in-memory and persists to DB.
   * Returns the new access token, or null on failure.
   */
  async refreshToken(
    authConfig: Record<string, unknown>,
    connectorId?: string,
  ): Promise<string | null> {
    // Rolling refresh tokens (e.g. DATEV rotates the refresh token on every
    // use) invalidate the previous one. The in-memory registry caches an
    // authConfig snapshot that is NOT updated after a refresh — only the DB is
    // (persistRefreshedToken). So for a persisted connector always re-read the
    // freshest authConfig from the DB before refreshing; otherwise a second
    // refresh would replay the already-rotated token and DATEV would reject it.
    if (connectorId) {
      const fresh = await this.loadAuthConfigFromDb(connectorId);
      if (fresh) authConfig = { ...authConfig, ...fresh };
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
    const scope = authConfig.scope ? String(authConfig.scope) : undefined;

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
      if (!clientId || !clientSecret) {
        this.logger.warn(
          'OAuth2 client_credentials: missing clientId/clientSecret',
        );
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
      const userAgent = findHeader(authConfig.extraHeaders, 'user-agent');
      if (userAgent) headers['User-Agent'] = userAgent;

      if (grant === 'client_credentials') {
        body = { grant_type: 'client_credentials' };
        if (scope) body.scope = scope;
        if (
          authConfig.tokenAuthMethod === 'post' ||
          authConfig.tokenAuthMethod === 'client_secret_post'
        ) {
          // client_secret_post — the other method RFC 6749 §2.3.1 allows,
          // and the only one some servers document: Amadeus's token
          // endpoint takes client_id/client_secret as form fields.
          body.client_id = String(clientId);
          body.client_secret = String(clientSecret);
        } else {
          const basic = Buffer.from(`${clientId}:${clientSecret}`).toString(
            'base64',
          );
          headers.Authorization = `Basic ${basic}`;
        }
      } else {
        body = {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        };
        const useBasic =
          authConfig.tokenAuthMethod === 'basic' ||
          authConfig.tokenAuthMethod === 'client_secret_basic';
        if (useBasic && clientId && clientSecret) {
          // client_secret_basic — credentials in the Authorization header.
          // DATEV and other confidential-client providers reject body creds.
          if (clientId) body.client_id = clientId;
          const basic = Buffer.from(`${clientId}:${clientSecret}`).toString(
            'base64',
          );
          headers.Authorization = `Basic ${basic}`;
        } else {
          if (clientId) body.client_id = clientId;
          if (clientSecret) body.client_secret = clientSecret;
        }
      }

      await assertSafeOutboundUrl(tokenUrl);
      const response = await axios.post(
        tokenUrl,
        new URLSearchParams(body).toString(),
        {
          headers,
          timeout: 10000,
        },
      );

      const cacheKey = connectorId || tokenUrl;
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
      });

      // Persist to DB if connectorId is available. For client_credentials
      // there's no refresh_token to store — we just record the latest
      // access_token + its expiry so a cold-start can reuse it briefly.
      if (connectorId) {
        await this.persistRefreshedToken(
          connectorId,
          access_token,
          newRefreshToken || refreshToken || '',
          Date.now() + expiresInMs,
        );
      }

      this.logger.debug(`OAuth2 (${grant}): token refreshed successfully`);
      return access_token;
    } catch (err: any) {
      this.logger.warn(`OAuth2 (${grant}) token refresh failed: ${err.message}`);
      this.lastRefreshError.set(
        connectorId || tokenUrl,
        describeTokenError(err),
      );
      return null;
    }
  }

  /**
   * Wraps refreshToken with a per-key mutex to prevent concurrent refresh storms.
   */
  private async refreshTokenWithMutex(
    authConfig: Record<string, unknown>,
    connectorId?: string,
  ): Promise<string | null> {
    const cacheKey = connectorId || String(authConfig.tokenUrl || '');

    // If a refresh is already in-flight for this key, wait for it
    const inFlight = this.refreshInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const refreshPromise = this.refreshToken(authConfig, connectorId).finally(() => {
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
        return cached.expiresAt <= now + PROACTIVE_REFRESH_BUFFER_MS;
      }
    }

    // Check expiresAt from authConfig (set during initial OAuth grant or previous refresh)
    if (authConfig.expiresAt) {
      const expiresAt = Number(authConfig.expiresAt);
      return expiresAt <= now + PROACTIVE_REFRESH_BUFFER_MS;
    }

    // No expiry info — assume token may be stale, try proactive refresh
    return true;
  }

  /**
   * Update the connector's encrypted authConfig with the new access token
   * so it survives server restarts.
   */
  /**
   * Reads and decrypts the connector's current authConfig straight from the DB.
   * Used to obtain the freshest (possibly-rotated) refresh token, bypassing the
   * stale in-memory registry snapshot. Returns null if unavailable.
   */
  private async loadAuthConfigFromDb(
    connectorId: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const connector = await this.prisma.connector.findUnique({
        where: { id: connectorId },
        select: { authConfig: true, envVars: true },
      });
      if (!connector?.authConfig) return null;
      // Resolved like the tool path resolves the snapshot it hands us. A
      // connector whose credentials were typed after install keeps
      // `{{ETSY_REFRESH_TOKEN}}` (and the client id/secret) as placeholders in
      // authConfig, with the values in envVars; merging the raw row over the
      // resolved snapshot put the placeholders back, and the token endpoint
      // was sent `refresh_token={{ETSY_REFRESH_TOKEN}}`. Literal values
      // contain no placeholder and pass through unchanged.
      return interpolateDeep(
        JSON.parse(decrypt(connector.authConfig, this.encryptionKey)),
        (connector.envVars as Record<string, string> | null) ?? {},
      );
    } catch (err: any) {
      this.logger.warn(
        `OAuth2: failed to load fresh authConfig for ${connectorId}: ${err.message}`,
      );
      return null;
    }
  }

  private async persistRefreshedToken(
    connectorId: string,
    newAccessToken: string,
    newRefreshToken: string,
    expiresAt: number,
  ): Promise<void> {
    try {
      const connector = await this.prisma.connector.findUnique({
        where: { id: connectorId },
        select: { authConfig: true },
      });

      if (!connector?.authConfig) return;

      const authConfig = JSON.parse(
        decrypt(connector.authConfig, this.encryptionKey),
      );
      authConfig.accessToken = newAccessToken;
      authConfig.refreshToken = newRefreshToken;
      authConfig.expiresAt = expiresAt;
      authConfig.lastRefreshedAt = new Date().toISOString();

      await this.prisma.connector.update({
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
    } catch (err: any) {
      this.logger.warn(
        `OAuth2: failed to persist refreshed token: ${err.message}`,
      );
    }
  }
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
