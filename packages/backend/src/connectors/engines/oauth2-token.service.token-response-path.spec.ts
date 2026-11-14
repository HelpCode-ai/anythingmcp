import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { OAuth2TokenService } from './oauth2-token.service';
import { encrypt, decrypt } from '../../common/crypto/encryption.util';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * `authConfig.tokenResponsePath`: a token endpoint that wraps the token
 * fields, as Joom does ({ code, message, data: { access_token, … } }).
 * Opt-in: without the field the answer is read at the top level, as always.
 */
describe('OAuth2TokenService with tokenResponsePath', () => {
  const encryptionKey = 'test-encryption-key-32-chars!!!!';
  let service: OAuth2TokenService;
  let prisma: any;

  // Built at runtime so no literal looks like a real credential.
  const accessToken = ['at', 'a'.repeat(20)].join('-');
  const rotatedRefresh = ['rt', 'n'.repeat(20)].join('-');
  const wrapped = (data: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
    data: { code: 0, message: '', ...extra, ...(data === null ? {} : { data }) },
  });

  // The same connector without the field, and with it.
  const plain = {
    tokenUrl: 'https://api-merchant.joom.com/api/v2/oauth/access_token',
    refreshUrl: 'https://api-merchant.joom.com/api/v2/oauth/refresh_token',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'rt-old',
  };
  const joom = { ...plain, tokenResponsePath: 'data' };

  beforeEach(() => {
    prisma = { connector: { findUnique: jest.fn(), update: jest.fn() } };
    const config = { get: jest.fn().mockReturnValue(encryptionKey) } as unknown as ConfigService;
    service = new OAuth2TokenService(prisma, config);
    mockedAxios.post.mockReset();
  });

  it('reads the access token, the refresh token and the lifetime from the wrapper on a refresh', async () => {
    prisma.connector.findUnique.mockResolvedValue({
      authConfig: encrypt(JSON.stringify(joom), encryptionKey),
    });
    prisma.connector.update.mockResolvedValue({});
    mockedAxios.post.mockResolvedValue(
      wrapped({ access_token: accessToken, refresh_token: rotatedRefresh, expires_in: 2592000, expiry_time: 1900000000 }),
    );
    const before = Date.now();

    await expect(service.refreshToken(joom, 'conn-joom')).resolves.toBe(accessToken);

    const [url, body] = mockedAxios.post.mock.calls[0] as any;
    expect(url).toBe(joom.refreshUrl);
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt-old',
      client_id: 'client-id',
      client_secret: 'client-secret',
    });

    // Stored: the new pair and the lifetime the wrapper named, with the path kept.
    const saved = JSON.parse(decrypt(prisma.connector.update.mock.calls[0][0].data.authConfig, encryptionKey));
    expect(saved).toMatchObject({
      accessToken,
      refreshToken: rotatedRefresh,
      expiresIn: 2592000,
      tokenResponsePath: 'data',
      refreshUrl: joom.refreshUrl,
    });
    expect(saved.expiresAt).toBeGreaterThanOrEqual(before + 2592000 * 1000);

    // Cached for the lifetime the wrapper named: no second request.
    await expect(service.getAccessToken(joom, 'conn-joom')).resolves.toBe(accessToken);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('keeps the refresh token in use when the wrapper returns none', async () => {
    prisma.connector.findUnique.mockResolvedValue({
      authConfig: encrypt(JSON.stringify(joom), encryptionKey),
    });
    prisma.connector.update.mockResolvedValue({});
    mockedAxios.post.mockResolvedValue(wrapped({ access_token: accessToken, expires_in: 3600 }));

    await service.refreshToken(joom, 'conn-joom');

    const saved = JSON.parse(decrypt(prisma.connector.update.mock.calls[0][0].data.authConfig, encryptionKey));
    expect(saved.refreshToken).toBe('rt-old');
  });

  it('follows a deeper path', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { status: 'ok', result: { token: { access_token: accessToken, expires_in: 60 } } },
    });
    await expect(
      service.refreshToken({ ...joom, tokenResponsePath: 'result.token' }),
    ).resolves.toBe(accessToken);
  });

  it('reads a client_credentials answer from the wrapper too', async () => {
    mockedAxios.post.mockResolvedValue(wrapped({ access_token: accessToken, expires_in: 900 }));

    const token = await service.getAccessToken({
      grant: 'client_credentials',
      tokenUrl: 'https://auth.example.com/token',
      tokenResponsePath: 'data',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });

    expect(token).toBe(accessToken);
    expect(mockedAxios.post.mock.calls[0][1]).toBe('grant_type=client_credentials');
  });

  it("fails with the provider's code and message when the wrapper is missing, and stores nothing", async () => {
    prisma.connector.findUnique.mockResolvedValue({
      authConfig: encrypt(JSON.stringify(joom), encryptionKey),
    });
    // A refusal inside a 200: no data, and a stray token-like field the
    // message must not repeat.
    mockedAxios.post.mockResolvedValue({
      data: { code: 1016, message: 'Refresh token is invalid', debug: { refresh_token: 'rt-old' } },
    });

    await expect(service.renewAfterRejection(joom, 'conn-joom', Date.now())).resolves.toBeNull();

    expect(prisma.connector.update).not.toHaveBeenCalled();
    const err = service.renewalFailedError(joom, 'conn-joom');
    expect(err?.status).toBe(401);
    expect(err?.message).toContain('could not be renewed at api-merchant.joom.com');
    expect(err?.message).toContain(
      'the token answer has no object at "data" (authConfig.tokenResponsePath); the provider answered: code 1016: Refresh token is invalid',
    );
    expect(err?.message).not.toMatch(/rt-old|client-secret/);
  });

  it('fails the same way when the token fields sit at the top level but the path names a wrapper', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { access_token: accessToken, refresh_token: rotatedRefresh, expires_in: 3600 },
    });

    await expect(service.refreshToken(joom)).resolves.toBeNull();
    const err = service.renewalFailedError(joom);
    expect(err?.message).toContain('the token answer has no object at "data"');
    expect(err?.message).not.toContain(accessToken);
    expect(err?.message).not.toContain(rotatedRefresh);
  });

  it('says the wrapper carried no access_token when it is there but empty', async () => {
    mockedAxios.post.mockResolvedValue(wrapped({ expires_in: 3600 }));

    await expect(service.refreshToken(joom)).resolves.toBeNull();
    expect(service.renewalFailedError(joom)?.message).toContain('the response carried no access_token');
  });

  describe('without the field (every other OAuth2 connector)', () => {
    it('still reads the token fields at the top level', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { access_token: accessToken, refresh_token: rotatedRefresh, expires_in: 3600 },
      });
      await expect(service.refreshToken(plain)).resolves.toBe(accessToken);
    });

    it('does not look inside a data object nobody named', async () => {
      mockedAxios.post.mockResolvedValue(wrapped({ access_token: accessToken, expires_in: 3600 }));

      await expect(service.refreshToken(plain)).resolves.toBeNull();
      expect(service.renewalFailedError(plain)?.message).toContain('the response carried no access_token');
    });

    it.each([[''], ['   '], [null], [0], [false]])('treats tokenResponsePath %p as unset', async (value) => {
      mockedAxios.post.mockResolvedValue({ data: { access_token: accessToken, expires_in: 3600 } });
      await expect(
        service.refreshToken({ ...plain, tokenResponsePath: value } as Record<string, unknown>),
      ).resolves.toBe(accessToken);
    });
  });
});
