import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../../common/prisma.service';
import { encrypt, decrypt } from '../../common/crypto/encryption.util';

/**
 * Shared OAuth2 token management: in-memory cache, refresh, and DB persistence.
 * Used by RestEngine and GraphqlEngine to handle OAuth2 token lifecycle.
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.encryptionKey =
      this.configService.get<string>('ENCRYPTION_KEY') ||
      'default-dev-key-change-in-prod!!';
  }

  /**
   * Returns the best available access token:
   * 1. Cached (refreshed) token if still valid
   * 2. Original token from authConfig
   */
  getAccessToken(
    authConfig: Record<string, unknown>,
    connectorId?: string,
  ): string {
    const cacheKey = connectorId || String(authConfig.tokenUrl || '');

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

      // Cache the new token (default 1 hour, refresh 1 min early)
      const expiresInMs = (expires_in || 3600) * 1000;
      const cacheKey = connectorId || tokenUrl;
      this.tokenCache.set(cacheKey, {
        accessToken: access_token,
        expiresAt: Date.now() + expiresInMs - 60000,
      });

      // Persist to DB if connectorId is available
      if (connectorId) {
        await this.persistRefreshedToken(
          connectorId,
          access_token,
          newRefreshToken || refreshToken,
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
   * Update the connector's encrypted authConfig with the new access token
   * so it survives server restarts.
   */
  private async persistRefreshedToken(
    connectorId: string,
    newAccessToken: string,
    newRefreshToken: string,
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
