import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../../common/prisma.service';
import { encrypt, decrypt } from '../../common/crypto/encryption.util';
import { getRequiredSecret } from '../../common/secrets.util';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';

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

    // 1. Check cache — return immediately if well within validity
    if (cacheKey) {
      const cached = this.tokenCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now() + PROACTIVE_REFRESH_BUFFER_MS) {
        return cached.accessToken;
      }
    }

    // 2. Determine if proactive refresh is possible and needed
    const hasRefreshCapability = !!(authConfig.refreshToken && authConfig.tokenUrl);
    const tokenNearExpiry = this.isTokenNearExpiry(authConfig, cacheKey);

    if (hasRefreshCapability && tokenNearExpiry) {
      this.logger.debug('OAuth2: token near expiry, proactive refresh...');
      const refreshed = await this.refreshTokenWithMutex(authConfig, connectorId);
      if (refreshed) {
        return refreshed;
      }
      // Refresh failed — fall through to return stored token
    }

    // 3. Return the best available token (cached or stored)
    if (cacheKey) {
      const cached = this.tokenCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.accessToken;
      }
    }

    return String(authConfig.accessToken || '');
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
    const tokenUrl = String(authConfig.tokenUrl || '');
    const refreshToken = String(authConfig.refreshToken || '');

    if (!tokenUrl || !refreshToken) {
      this.logger.warn('OAuth2 refresh: missing tokenUrl or refreshToken');
      return null;
    }

    const clientId = authConfig.clientId
      ? String(authConfig.clientId)
      : undefined;
    const clientSecret = authConfig.clientSecret
      ? String(authConfig.clientSecret)
      : undefined;

    try {
      const body: Record<string, string> = {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      };
      if (clientId) body.client_id = clientId;
      if (clientSecret) body.client_secret = clientSecret;

      await assertSafeOutboundUrl(tokenUrl);
      const response = await axios.post(
        tokenUrl,
        new URLSearchParams(body).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000,
        },
      );

      const { access_token, expires_in, refresh_token: newRefreshToken } =
        response.data;
      if (!access_token) return null;

      // Cache the new token
      const expiresInMs = (expires_in || 3600) * 1000;
      const cacheKey = connectorId || tokenUrl;
      this.tokenCache.set(cacheKey, {
        accessToken: access_token,
        expiresAt: Date.now() + expiresInMs,
      });

      // Persist to DB if connectorId is available
      if (connectorId) {
        await this.persistRefreshedToken(
          connectorId,
          access_token,
          newRefreshToken || refreshToken,
          Date.now() + expiresInMs,
        );
      }

      this.logger.debug('OAuth2: token refreshed successfully');
      return access_token;
    } catch (err: any) {
      this.logger.warn(`OAuth2 token refresh failed: ${err.message}`);
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
