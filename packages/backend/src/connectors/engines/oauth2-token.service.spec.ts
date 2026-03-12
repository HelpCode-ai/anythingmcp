import { OAuth2TokenService } from './oauth2-token.service';
import { PrismaService } from '../../common/prisma.service';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { encrypt } from '../../common/crypto/encryption.util';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('OAuth2TokenService', () => {
  let service: OAuth2TokenService;
  let mockPrisma: any;
  let mockConfigService: jest.Mocked<ConfigService>;

  const encryptionKey = 'test-encryption-key-32-chars!!!!';

  beforeEach(() => {
    mockPrisma = {
      connector: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    mockConfigService = {
      get: jest.fn().mockReturnValue(encryptionKey),
    } as any;

    service = new OAuth2TokenService(mockPrisma, mockConfigService);
    jest.clearAllMocks();
    // Re-mock configService.get since clearAllMocks resets it
    mockConfigService.get.mockReturnValue(encryptionKey);
  });

  describe('getAccessToken', () => {
    it('should return accessToken from authConfig when no cached token and no expiry info', async () => {
      // No expiresAt, no refreshToken → returns stored token (no refresh attempt)
      const result = await service.getAccessToken(
        { accessToken: 'stored-token' },
        'conn-1',
      );
      expect(result).toBe('stored-token');
    });

    it('should return empty string when no accessToken in authConfig', async () => {
      const result = await service.getAccessToken({}, 'conn-1');
      expect(result).toBe('');
    });

    it('should return cached token when well within validity', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          access_token: 'refreshed-token',
          expires_in: 3600,
        },
      });

      await service.refreshToken(
        {
          tokenUrl: 'https://auth/token',
          refreshToken: 'rt-123',
        },
        'conn-1',
      );

      const result = await service.getAccessToken(
        { accessToken: 'old-token', tokenUrl: 'https://auth/token' },
        'conn-1',
      );
      expect(result).toBe('refreshed-token');
    });

    it('should proactively refresh when token is near expiry', async () => {
      // First, populate the cache with a token that expires in 2 minutes (within 5-min buffer)
      mockedAxios.post.mockResolvedValue({
        data: {
          access_token: 'first-token',
          expires_in: 120, // 2 minutes — within 5-min buffer
        },
      });

      await service.refreshToken(
        { tokenUrl: 'https://auth/token', refreshToken: 'rt-123' },
        'conn-1',
      );

      // Now mock the second refresh
      mockedAxios.post.mockResolvedValue({
        data: {
          access_token: 'proactively-refreshed',
          expires_in: 3600,
        },
      });

      const result = await service.getAccessToken(
        {
          accessToken: 'old-token',
          tokenUrl: 'https://auth/token',
          refreshToken: 'rt-123',
        },
        'conn-1',
      );

      expect(result).toBe('proactively-refreshed');
      // Two POST calls total: initial + proactive
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    it('should proactively refresh when authConfig.expiresAt is near expiry', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          access_token: 'proactive-token',
          expires_in: 3600,
        },
      });

      const result = await service.getAccessToken(
        {
          accessToken: 'old-token',
          tokenUrl: 'https://auth/token',
          refreshToken: 'rt-123',
          expiresAt: Date.now() + 60000, // 1 minute — within 5-min buffer
        },
        'conn-1',
      );

      expect(result).toBe('proactive-token');
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });

    it('should fall back to stored token when proactive refresh fails', async () => {
      mockedAxios.post.mockRejectedValue(new Error('Network error'));

      const result = await service.getAccessToken(
        {
          accessToken: 'stored-token',
          tokenUrl: 'https://auth/token',
          refreshToken: 'rt-123',
          expiresAt: Date.now() + 60000, // near expiry
        },
        'conn-1',
      );

      expect(result).toBe('stored-token');
    });

    it('should deduplicate concurrent refresh calls (mutex)', async () => {
      let resolveRefresh: (value: any) => void;
      const refreshPromise = new Promise((resolve) => {
        resolveRefresh = resolve;
      });

      mockedAxios.post.mockImplementation(() => refreshPromise as any);

      const authConfig = {
        accessToken: 'old-token',
        tokenUrl: 'https://auth/token',
        refreshToken: 'rt-123',
        expiresAt: Date.now() - 1000, // expired
      };

      // Launch two concurrent getAccessToken calls
      const p1 = service.getAccessToken(authConfig, 'conn-1');
      const p2 = service.getAccessToken(authConfig, 'conn-1');

      // Resolve the single refresh
      resolveRefresh!({
        data: {
          access_token: 'deduped-token',
          expires_in: 3600,
        },
      });

      const [r1, r2] = await Promise.all([p1, p2]);

      // Both should get the same token
      expect(r1).toBe('deduped-token');
      expect(r2).toBe('deduped-token');
      // Only one POST call should have been made
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('refreshToken', () => {
    it('should POST to tokenUrl with grant_type=refresh_token', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          access_token: 'new-at',
          expires_in: 3600,
        },
      });

      const result = await service.refreshToken({
        tokenUrl: 'https://auth.example.com/token',
        refreshToken: 'rt-abc',
        clientId: 'client-id',
        clientSecret: 'client-secret',
      });

      expect(result).toBe('new-at');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://auth.example.com/token',
        expect.stringContaining('grant_type=refresh_token'),
        expect.objectContaining({
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000,
        }),
      );

      // Verify client_id and client_secret are included
      const postedBody = mockedAxios.post.mock.calls[0][1] as string;
      expect(postedBody).toContain('client_id=client-id');
      expect(postedBody).toContain('client_secret=client-secret');
    });

    it('should return null when tokenUrl is missing', async () => {
      const result = await service.refreshToken({
        refreshToken: 'rt-abc',
      });
      expect(result).toBeNull();
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('should return null when refreshToken is missing', async () => {
      const result = await service.refreshToken({
        tokenUrl: 'https://auth/token',
      });
      expect(result).toBeNull();
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('should return null when token endpoint returns no access_token', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { error: 'invalid_grant' },
      });

      const result = await service.refreshToken({
        tokenUrl: 'https://auth/token',
        refreshToken: 'rt-expired',
      });
      expect(result).toBeNull();
    });

    it('should return null on network error', async () => {
      mockedAxios.post.mockRejectedValue(new Error('Network error'));

      const result = await service.refreshToken({
        tokenUrl: 'https://auth/token',
        refreshToken: 'rt-abc',
      });
      expect(result).toBeNull();
    });

    it('should cache the refreshed token', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          access_token: 'cached-token',
          expires_in: 3600,
        },
      });

      await service.refreshToken(
        { tokenUrl: 'https://auth/token', refreshToken: 'rt' },
        'conn-1',
      );

      // Should return cached token, not the one from authConfig
      const token = await service.getAccessToken(
        { accessToken: 'old', tokenUrl: 'https://auth/token' },
        'conn-1',
      );
      expect(token).toBe('cached-token');
    });

    it('should persist refreshed token to DB when connectorId is provided', async () => {
      const authConfigObj = {
        accessToken: 'old-at',
        refreshToken: 'old-rt',
        tokenUrl: 'https://auth/token',
      };

      mockPrisma.connector.findUnique.mockResolvedValue({
        authConfig: encrypt(JSON.stringify(authConfigObj), encryptionKey),
      } as any);
      mockPrisma.connector.update.mockResolvedValue({} as any);

      mockedAxios.post.mockResolvedValue({
        data: {
          access_token: 'new-at',
          expires_in: 3600,
          refresh_token: 'new-rt',
        },
      });

      await service.refreshToken(
        { tokenUrl: 'https://auth/token', refreshToken: 'old-rt' },
        'conn-42',
      );

      expect(mockPrisma.connector.findUnique).toHaveBeenCalledWith({
        where: { id: 'conn-42' },
        select: { authConfig: true },
      });
      expect(mockPrisma.connector.update).toHaveBeenCalledWith({
        where: { id: 'conn-42' },
        data: { authConfig: expect.any(String) },
      });
    });

    it('should not persist to DB when connectorId is not provided', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          access_token: 'new-at',
          expires_in: 3600,
        },
      });

      await service.refreshToken({
        tokenUrl: 'https://auth/token',
        refreshToken: 'rt',
      });

      expect(mockPrisma.connector.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.connector.update).not.toHaveBeenCalled();
    });

    it('should use original refreshToken if provider does not return a new one', async () => {
      const authConfigObj = {
        accessToken: 'old-at',
        refreshToken: 'original-rt',
        tokenUrl: 'https://auth/token',
      };

      mockPrisma.connector.findUnique.mockResolvedValue({
        authConfig: encrypt(JSON.stringify(authConfigObj), encryptionKey),
      } as any);
      mockPrisma.connector.update.mockResolvedValue({} as any);

      mockedAxios.post.mockResolvedValue({
        data: {
          access_token: 'new-at',
          expires_in: 3600,
          // No refresh_token returned — should keep original
        },
      });

      await service.refreshToken(
        { tokenUrl: 'https://auth/token', refreshToken: 'original-rt' },
        'conn-1',
      );

      expect(mockPrisma.connector.update).toHaveBeenCalled();
    });
  });
});
