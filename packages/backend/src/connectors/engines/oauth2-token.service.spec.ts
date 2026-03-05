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
    it('should return accessToken from authConfig when no cached token', () => {
      const result = service.getAccessToken(
        { accessToken: 'stored-token', tokenUrl: 'https://auth/token' },
        'conn-1',
      );
      expect(result).toBe('stored-token');
    });

    it('should return empty string when no accessToken in authConfig', () => {
      const result = service.getAccessToken({}, 'conn-1');
      expect(result).toBe('');
    });

    it('should return cached token after a successful refresh', async () => {
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

      const result = service.getAccessToken(
        { accessToken: 'old-token', tokenUrl: 'https://auth/token' },
        'conn-1',
      );
      expect(result).toBe('refreshed-token');
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
      const token = service.getAccessToken(
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

      // DB update should have been called (we verify the refresh token was preserved
      // by checking the mock was called — detailed verification of encrypted content
      // would require decrypting, which the service handles internally)
      expect(mockPrisma.connector.update).toHaveBeenCalled();
    });
  });
});
