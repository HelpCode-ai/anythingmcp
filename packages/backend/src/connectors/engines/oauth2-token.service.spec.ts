import { OAuth2TokenService } from './oauth2-token.service';
import { PrismaService } from '../../common/prisma.service';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { generateKeyPairSync, verify } from 'crypto';
import { encrypt, decrypt } from '../../common/crypto/encryption.util';
import * as etsyAdapter from '../../adapters/intl/etsy.json';

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

  describe('client_credentials grant', () => {
    it('posts grant_type=client_credentials with HTTP Basic auth header', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { access_token: 's4-at', expires_in: 3600 },
      });

      const token = await service.refreshToken({
        grant: 'client_credentials',
        tokenUrl:
          'https://my300000.authentication.eu10.hana.ondemand.com/oauth/token',
        clientId: 'my-client-id',
        clientSecret: 'my-client-secret',
        scope: 'API_BUSINESS_PARTNER_0001',
      });

      expect(token).toBe('s4-at');
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      const [url, body, opts] = mockedAxios.post.mock.calls[0] as any;
      expect(url).toContain('hana.ondemand.com');
      expect(body).toContain('grant_type=client_credentials');
      expect(body).toContain('scope=API_BUSINESS_PARTNER_0001');
      // Critical: client creds in Basic header, NOT in body.
      const expectedBasic =
        'Basic ' +
        Buffer.from('my-client-id:my-client-secret').toString('base64');
      expect(opts.headers.Authorization).toBe(expectedBasic);
      expect(body).not.toContain('client_id=');
      expect(body).not.toContain('client_secret=');
    });

    it('sends client credentials as form fields when tokenAuthMethod is client_secret_post (Amadeus)', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { access_token: 'amadeus-at', expires_in: 1799 },
      });

      const token = await service.refreshToken({
        grant: 'client_credentials',
        tokenAuthMethod: 'client_secret_post',
        tokenUrl: 'https://api.amadeus.com/v1/security/oauth2/token',
        clientId: 'api-key',
        clientSecret: 'api-secret',
      });

      expect(token).toBe('amadeus-at');
      const [, body, opts] = mockedAxios.post.mock.calls[0] as any;
      expect(new URLSearchParams(body)).toEqual(
        new URLSearchParams(
          'grant_type=client_credentials&client_id=api-key&client_secret=api-secret',
        ),
      );
      expect(opts.headers['Content-Type']).toBe(
        'application/x-www-form-urlencoded',
      );
      expect(opts.headers.Authorization).toBeUndefined();
    });

    it('returns null when client_credentials grant lacks clientId/Secret', async () => {
      const token = await service.refreshToken({
        grant: 'client_credentials',
        tokenUrl: 'https://example.com/oauth/token',
      });
      expect(token).toBeNull();
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('client_credentials path is reachable from getAccessToken without a refreshToken', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { access_token: 'fresh', expires_in: 3600 },
      });

      const token = await service.getAccessToken({
        grant: 'client_credentials',
        tokenUrl: 'https://example.com/oauth/token',
        clientId: 'id',
        clientSecret: 'secret',
      });

      expect(token).toBe('fresh');
    });

    it("forwards the adapter's User-Agent to the token request, and nothing else from extraHeaders", async () => {
      mockedAxios.post.mockResolvedValue({
        data: { access_token: 'rd', expires_in: 3600 },
      });

      await service.refreshToken({
        grant: 'client_credentials',
        tokenUrl: 'https://www.reddit.com/api/v1/access_token',
        clientId: 'id',
        clientSecret: 'secret',
        extraHeaders: {
          'User-Agent': 'web:anythingmcp:v1 (by /u/anythingmcp)',
          'x-api-key': 'belongs-to-the-api',
        },
      });

      const [, , opts] = mockedAxios.post.mock.calls[0] as any;
      expect(opts.headers['User-Agent']).toBe(
        'web:anythingmcp:v1 (by /u/anythingmcp)',
      );
      expect(opts.headers['x-api-key']).toBeUndefined();
    });

    it('throws what the token endpoint said instead of sending an empty bearer', async () => {
      // Reddit's real answer to a wrong client ID/secret.
      mockedAxios.post.mockRejectedValue(
        Object.assign(new Error('Request failed with status code 401'), {
          response: { status: 401, data: { message: 'Unauthorized', error: 401 } },
        }),
      );

      const call = service.getAccessToken(
        {
          grant: 'client_credentials',
          tokenUrl: 'https://www.reddit.com/api/v1/access_token',
          clientId: 'wrong-id',
          clientSecret: 'wrong-secret',
        },
        'conn-rd',
      );

      await expect(call).rejects.toMatchObject({
        status: 401,
        message: expect.stringContaining(
          'could not obtain an access token from www.reddit.com (HTTP 401: Unauthorized)',
        ),
      });
      await expect(call).rejects.not.toThrow(/wrong-secret|wrong-id/);
    });

    it('still falls back to a stored token when a client_credentials refresh fails', async () => {
      mockedAxios.post.mockRejectedValue(new Error('ETIMEDOUT'));

      const token = await service.getAccessToken({
        grant: 'client_credentials',
        tokenUrl: 'https://example.com/oauth/token',
        clientId: 'id',
        clientSecret: 'secret',
        accessToken: 'persisted-at',
      });

      expect(token).toBe('persisted-at');
    });
  });

  describe('rolling refresh tokens', () => {
    it('refreshes using the freshest refresh token from the DB, not the stale snapshot', async () => {
      // DB holds the rotated ("fresh") refresh token; the caller passes a stale
      // snapshot. The refresh must use the DB value (DATEV invalidates the old one).
      mockPrisma.connector.findUnique.mockResolvedValue({
        authConfig: encrypt(
          JSON.stringify({
            tokenUrl: 'https://sandbox-api.datev.de/token',
            refreshToken: 'FRESH_RT',
            clientId: 'cid',
            clientSecret: 'sec',
            tokenAuthMethod: 'basic',
          }),
          encryptionKey,
        ),
      });
      mockedAxios.post.mockResolvedValue({
        data: { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 },
      });

      const result = await service.refreshToken(
        {
          tokenUrl: 'https://sandbox-api.datev.de/token',
          refreshToken: 'STALE_RT',
          clientId: 'cid',
          clientSecret: 'sec',
          tokenAuthMethod: 'basic',
        },
        'conn-1',
      );

      expect(result).toBe('AT2');
      const body = String(mockedAxios.post.mock.calls[0][1]);
      expect(body).toContain('refresh_token=FRESH_RT');
      expect(body).not.toContain('STALE_RT');
      // Basic auth used (DATEV requires client_secret_basic), secret not in body.
      const cfg = mockedAxios.post.mock.calls[0][2] as any;
      expect(cfg.headers.Authorization).toBe(
        'Basic ' + Buffer.from('cid:sec').toString('base64'),
      );
      expect(body).not.toContain('client_secret=');
    });
  });

  /**
   * Etsy connectors installed with a pasted refresh token are in daily use.
   * The adapter gained an authorization URL (so new installs can authorize in
   * the browser), but installed rows keep the authConfig they were created
   * with — the catalog re-sync never touches auth. These pin the refresh path
   * those rows depend on, with the row shaped exactly as an import produces it.
   */
  describe('Etsy connectors installed with a refresh token (existing rows)', () => {
    const etsyTemplate = (etsyAdapter as any).connector.authConfig as Record<string, unknown>;
    const fill = (value: unknown, vars: Record<string, string>): any =>
      JSON.parse(
        JSON.stringify(value).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m)),
      );
    const creds = {
      ETSY_CLIENT_ID: 'keystring123',
      ETSY_CLIENT_SECRET: 'sharedsecret456',
      ETSY_REFRESH_TOKEN: '12345678.pasted-refresh-token',
    };
    // A row created before the adapter had authorizationUrl/scopes.
    const legacyRow = () => {
      const row = fill(etsyTemplate, creds);
      delete row.authorizationUrl;
      delete row.scopes;
      return row;
    };
    const storeRow = (row: Record<string, unknown>, envVars?: Record<string, string>) =>
      mockPrisma.connector.findUnique.mockResolvedValue({
        authConfig: encrypt(JSON.stringify(row), encryptionKey),
        envVars: envVars ?? null,
      });

    it('refreshes with the stored token, client credentials in the body, no Basic header', async () => {
      const row = legacyRow();
      storeRow(row);
      mockedAxios.post.mockResolvedValue({
        data: {
          access_token: '12345678.new-access',
          refresh_token: '12345678.rotated-refresh',
          expires_in: 3600,
        },
      });

      const token = await service.getAccessToken(row, 'etsy-conn');

      expect(token).toBe('12345678.new-access');
      const [url, body, opts] = mockedAxios.post.mock.calls[0] as any[];
      expect(url).toBe('https://api.etsy.com/v3/public/oauth/token');
      const params = new URLSearchParams(String(body));
      expect(params.get('grant_type')).toBe('refresh_token');
      expect(params.get('refresh_token')).toBe('12345678.pasted-refresh-token');
      expect(params.get('client_id')).toBe('keystring123');
      expect(params.get('client_secret')).toBe('sharedsecret456');
      expect(opts.headers.Authorization).toBeUndefined();
      // The API key belongs to the API calls, not the token request.
      expect(opts.headers['x-api-key']).toBeUndefined();
    });

    it('stores the rotated refresh token and uses it for the next refresh', async () => {
      const row = legacyRow();
      storeRow(row);
      mockedAxios.post.mockResolvedValueOnce({
        data: { access_token: 'AT1', refresh_token: 'RT-rotated-1', expires_in: 3600 },
      });

      await service.refreshToken(row, 'etsy-conn');

      const saved = mockPrisma.connector.update.mock.calls[0][0].data.authConfig;
      const persisted = JSON.parse(decrypt(saved, encryptionKey));
      expect(persisted.refreshToken).toBe('RT-rotated-1');
      expect(persisted.accessToken).toBe('AT1');
      // Everything else on the row is kept as it was.
      expect(persisted.extraHeaders).toEqual(row.extraHeaders);
      expect(persisted.clientId).toBe('keystring123');
      expect(persisted.authorizationUrl).toBeUndefined();

      // Second refresh: the registry still holds the old snapshot, the DB the
      // rotated token. Etsy has already invalidated the old one.
      storeRow(persisted);
      mockedAxios.post.mockResolvedValueOnce({
        data: { access_token: 'AT2', refresh_token: 'RT-rotated-2', expires_in: 3600 },
      });
      await service.refreshToken(row, 'etsy-conn');
      const second = new URLSearchParams(String(mockedAxios.post.mock.calls[1][1]));
      expect(second.get('refresh_token')).toBe('RT-rotated-1');
    });

    it('behaves the same once the row also carries the new authorization settings', async () => {
      // A row authorized in the browser: same template, plus authorizationUrl
      // and scopes. The refresh request must be byte-for-byte the same shape.
      const row = fill(etsyTemplate, creds);
      expect(row.authorizationUrl).toBe('https://www.etsy.com/oauth/connect');
      storeRow(row);
      mockedAxios.post.mockResolvedValue({
        data: { access_token: 'AT', refresh_token: 'RT2', expires_in: 3600 },
      });

      await expect(service.getAccessToken(row, 'etsy-conn')).resolves.toBe('AT');
      const params = new URLSearchParams(String(mockedAxios.post.mock.calls[0][1]));
      expect([...params.keys()].sort()).toEqual(
        ['client_id', 'client_secret', 'grant_type', 'refresh_token'],
      );
    });

    it('keeps serving a stored access token when a refresh fails', async () => {
      const row = { ...legacyRow(), accessToken: 'still-valid', expiresAt: Date.now() + 60_000 };
      storeRow(row);
      mockedAxios.post.mockRejectedValue(new Error('ETIMEDOUT'));

      await expect(service.getAccessToken(row, 'etsy-conn')).resolves.toBe('still-valid');
    });

    it('resolves credentials that live in env vars when reading the row back', async () => {
      // Credentials typed after install: authConfig keeps the placeholders, the
      // values are in envVars. The tool path hands us a resolved snapshot, and
      // the fresh read from the DB must not put the placeholders back.
      const row = fill(etsyTemplate, {});
      delete row.authorizationUrl;
      delete row.scopes;
      storeRow(row, creds);
      mockedAxios.post.mockResolvedValue({
        data: { access_token: 'AT', refresh_token: 'RT2', expires_in: 3600 },
      });

      await service.getAccessToken(fill(row, creds), 'etsy-conn');

      const params = new URLSearchParams(String(mockedAxios.post.mock.calls[0][1]));
      expect(params.get('refresh_token')).toBe('12345678.pasted-refresh-token');
      expect(params.get('client_id')).toBe('keystring123');
      expect(String(mockedAxios.post.mock.calls[0][1])).not.toContain('%7B%7B');
    });
  });

  describe('no token to send', () => {
    it('says the refresh token was refused instead of sending an empty bearer', async () => {
      // Etsy's answer to `Bearer ` is "403 Invalid access token: not a Bearer
      // token", which sends people looking at the wrong thing.
      mockedAxios.post.mockRejectedValue(
        Object.assign(new Error('Request failed with status code 400'), {
          response: {
            status: 400,
            data: { error: 'invalid_grant', error_description: 'Invalid refresh token' },
          },
        }),
      );

      const call = service.getAccessToken(
        {
          tokenUrl: 'https://api.etsy.com/v3/public/oauth/token',
          clientId: 'id',
          clientSecret: 'secret',
          refreshToken: 'bad-token',
        },
        'conn-bad',
      );

      await expect(call).rejects.toMatchObject({
        status: 401,
        message: expect.stringContaining(
          'could not renew the access token at api.etsy.com (HTTP 400: invalid_grant: Invalid refresh token)',
        ),
      });
      await expect(call).rejects.not.toThrow(/bad-token|secret/);
    });

    it('says the connector has not been authorized when it never was', async () => {
      const call = service.getAccessToken(
        {
          authorizationUrl: 'https://www.etsy.com/oauth/connect',
          tokenUrl: 'https://api.etsy.com/v3/public/oauth/token',
          clientId: 'id',
          refreshToken: '',
        },
        'conn-new',
      );

      await expect(call).rejects.toMatchObject({
        status: 401,
        message: expect.stringContaining('has not been authorized yet'),
      });
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('still returns an empty token for a connector without an authorization URL', async () => {
      await expect(service.getAccessToken({ clientId: 'id' }, 'conn-x')).resolves.toBe('');
    });
  });

  describe('private_key_jwt (Revolut Business)', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    // What an env var holds after a paste into a single-line input.
    const pastedPem = privateKey
      .export({ type: 'pkcs1', format: 'pem' })
      .toString()
      .replace(/\n/g, '');
    const revolut = {
      tokenUrl: 'https://b2b.revolut.com/api/1.0/auth/token',
      clientId: 'revolut-client-id',
      refreshToken: 'oa_prod_refresh',
      tokenAuthMethod: 'private_key_jwt',
      clientAssertion: {
        privateKey: pastedPem,
        claims: { iss: 'cloud.anythingmcp.com', aud: 'https://revolut.com' },
      },
    };

    it('refreshes with a freshly signed assertion and no client secret', async () => {
      mockedAxios.post.mockResolvedValue({
        // Revolut's refresh answer carries no new refresh token.
        data: { access_token: 'oa_prod_new', token_type: 'bearer', expires_in: 2399 },
      });

      await expect(service.refreshToken(revolut)).resolves.toBe('oa_prod_new');

      const [url, body, opts] = mockedAxios.post.mock.calls[0] as any;
      expect(url).toBe('https://b2b.revolut.com/api/1.0/auth/token');
      const form = new URLSearchParams(body);
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('refresh_token')).toBe('oa_prod_refresh');
      expect(form.get('client_assertion_type')).toBe(
        'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      );
      expect(form.has('client_id')).toBe(false);
      expect(form.has('client_secret')).toBe(false);
      expect(opts.headers.Authorization).toBeUndefined();

      const [h, p, sig] = String(form.get('client_assertion')).split('.');
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
      expect(claims.iss).toBe('cloud.anythingmcp.com');
      expect(claims.sub).toBe('revolut-client-id');
      expect(claims.aud).toBe('https://revolut.com');
      expect(claims.exp - claims.iat).toBe(300);
      expect(
        verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url')),
      ).toBe(true);
    });

    it('keeps the refresh token Revolut did not rotate', async () => {
      mockedAxios.post.mockResolvedValue({ data: { access_token: 'at2', expires_in: 2399 } });
      mockPrisma.connector.findUnique.mockResolvedValue({
        authConfig: encrypt(JSON.stringify(revolut), encryptionKey),
        envVars: {},
      });
      await service.refreshToken(revolut, 'conn-rev');
      const saved = JSON.parse(
        decrypt(mockPrisma.connector.update.mock.calls[0][0].data.authConfig, encryptionKey),
      );
      expect(saved.accessToken).toBe('at2');
      expect(saved.refreshToken).toBe('oa_prod_refresh');
    });

    it('resolves the key from env vars when reading the row back', async () => {
      mockedAxios.post.mockResolvedValue({ data: { access_token: 'at3', expires_in: 2399 } });
      const stored = {
        ...revolut,
        clientAssertion: {
          privateKey: '{{REVOLUT_PRIVATE_KEY}}',
          claims: { iss: '{{REVOLUT_REDIRECT_DOMAIN}}', aud: 'https://revolut.com' },
        },
      };
      mockPrisma.connector.findUnique.mockResolvedValue({
        authConfig: encrypt(JSON.stringify(stored), encryptionKey),
        envVars: {
          REVOLUT_PRIVATE_KEY: pastedPem,
          REVOLUT_REDIRECT_DOMAIN: 'amcp.example.org',
        },
      });
      await expect(service.refreshToken(stored, 'conn-rev2')).resolves.toBe('at3');
      const form = new URLSearchParams((mockedAxios.post.mock.calls[0] as any)[1]);
      const p = String(form.get('client_assertion')).split('.')[1];
      expect(JSON.parse(Buffer.from(p, 'base64url').toString()).iss).toBe('amcp.example.org');
    });

    it('says the key is missing instead of calling the token endpoint', async () => {
      const unset = {
        ...revolut,
        clientAssertion: { privateKey: '{{REVOLUT_PRIVATE_KEY}}', claims: revolut.clientAssertion.claims },
      };
      await expect(service.refreshToken(unset, undefined)).resolves.toBeNull();
      expect(mockedAxios.post).not.toHaveBeenCalled();
      await expect(service.getAccessToken(unset)).rejects.toThrow(
        /client assertion: the private key is not set \(\{\{REVOLUT_PRIVATE_KEY\}\} has no value\)/,
      );
    });

    it('also authenticates a client_credentials grant without a secret', async () => {
      mockedAxios.post.mockResolvedValue({ data: { access_token: 'cc-at', expires_in: 600 } });
      await expect(
        service.getAccessToken({
          grant: 'client_credentials',
          tokenUrl: 'https://idp.example.com/token',
          clientId: 'svc',
          tokenAuthMethod: 'private_key_jwt',
          clientAssertion: { privateKey: pastedPem },
        }),
      ).resolves.toBe('cc-at');
      const form = new URLSearchParams((mockedAxios.post.mock.calls[0] as any)[1]);
      expect(form.get('grant_type')).toBe('client_credentials');
      const p = String(form.get('client_assertion')).split('.')[1];
      // RFC 7523 defaults: iss = sub = client id, aud = token endpoint.
      expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toMatchObject({
        iss: 'svc',
        sub: 'svc',
        aud: 'https://idp.example.com/token',
      });
    });
  });
});
