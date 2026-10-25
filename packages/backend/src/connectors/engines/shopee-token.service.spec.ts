import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  ShopeeTokenService,
  buildShopeeAuthorizationUrl,
  isShopeeAccessTokenRejected,
  isShopeeRefreshRefused,
  shopeeBaseString,
  shopeeNeedsAuthorization,
  shopeeSign,
} from './shopee-token.service';
import { credentialRef } from './connector-auth-status.service';
import { decrypt, encrypt } from '../../common/crypto/encryption.util';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
jest.mock('../../common/ssrf.util', () => ({
  ...jest.requireActual('../../common/ssrf.util'),
  assertSafeOutboundUrl: jest.fn().mockResolvedValue(undefined),
}));

const KEY = 'test-encryption-key-32-chars!!!!';
const PARTNER_KEY = 'test_partner_key_123';
const HOST = 'https://partner.shopeemobile.com';
const HOUR = 60 * 60 * 1000;

/**
 * Expected signatures were computed independently (Python hmac/hashlib) from
 * the base strings in Shopee's developer guide ("API calls", "Authorization
 * and Authentication"), with a test partner key: the guide prints its example
 * signature without the key that produced it.
 */
describe('Shopee signing helpers', () => {
  it("builds the guide's shop base string and signs it", () => {
    const base = shopeeBaseString({
      partnerId: 2001887,
      path: '/api/v2/shop/get_shop_info',
      timestamp: 1655714431,
      accessToken: '59777174636562737266615546704c6d',
      shopId: 14701711,
    });
    expect(base).toBe('2001887/api/v2/shop/get_shop_info165571443159777174636562737266615546704c6d14701711');
    expect(shopeeSign(PARTNER_KEY, base)).toBe('5467e060121e23b60d133a13b2972253695985bf3395b5c088537806fd835e72');
  });

  it('signs public calls over partner_id + path + timestamp', () => {
    const base = shopeeBaseString({ partnerId: '2001887', path: '/api/v2/auth/token/get', timestamp: 1655714431 });
    expect(base).toBe('2001887/api/v2/auth/token/get1655714431');
    expect(shopeeSign(PARTNER_KEY, base)).toBe('19b2b86451df7a176d9a9fd09771e390ef255a61660572a2f62b35a7f6dde0fe');
  });

  it('builds the signed shop authorization link', () => {
    const url = new URL(
      buildShopeeAuthorizationUrl(
        { host: HOST, partnerId: '2001887', partnerKey: PARTNER_KEY },
        'https://cloud.anythingmcp.com/api/shopee/callback/abc',
        1655714431 * 1000,
      ),
    );
    expect(url.origin + url.pathname).toBe(`${HOST}/api/v2/shop/auth_partner`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      partner_id: '2001887',
      timestamp: '1655714431',
      sign: '46fae32b9b7e3c436ee4a1a05b5e583665b4de68f3d4749431c016d845e78171',
      redirect: 'https://cloud.anythingmcp.com/api/shopee/callback/abc',
    });
    expect(url.toString()).not.toContain(PARTNER_KEY);
  });

  it('tells a refused refresh token from other failures', () => {
    const err = (status: number, error: string, message = '') => ({ response: { status, data: { error, message } } });
    for (const code of ['error_shop_refresh_token', 'refresh_token_expired', 'shop_access_expired', 'shop_no_linked']) {
      expect(isShopeeRefreshRefused(err(403, code))).toBe(true);
      expect(isShopeeRefreshRefused(err(200, code))).toBe(true);
    }
    expect(isShopeeRefreshRefused(err(403, 'error_auth', 'Invalid refresh_token.'))).toBe(true);
    expect(isShopeeRefreshRefused(err(403, 'error_sign', 'Wrong sign.'))).toBe(false);
    expect(isShopeeRefreshRefused(err(403, 'invalid_partner_id'))).toBe(false);
    expect(isShopeeRefreshRefused(err(429, 'error_rate_limit'))).toBe(false);
    expect(isShopeeRefreshRefused(err(500, 'refresh_token_expired'))).toBe(false);
    expect(isShopeeRefreshRefused(new Error('socket hang up'))).toBe(false);

    expect(isShopeeAccessTokenRejected(err(403, 'invalid_acceess_token'))).toBe(true);
    expect(isShopeeAccessTokenRejected(err(403, 'invalid_access_token'))).toBe(true);
    expect(isShopeeAccessTokenRejected(err(403, 'error_auth', 'Invalid access_token.'))).toBe(true);
    expect(isShopeeAccessTokenRejected(err(403, 'error_param', 'Invalid timestamp.'))).toBe(false);
    expect(isShopeeAccessTokenRejected({ status: 401, responseBody: { error: 'invalid_acceess_token' } })).toBe(true);
  });

  it('only a Shopee HMAC connector without tokens needs authorization', () => {
    expect(shopeeNeedsAuthorization('HMAC', { tokenProvider: 'shopee' })).toBe(true);
    expect(shopeeNeedsAuthorization('HMAC', { tokenProvider: 'shopee', refreshToken: 'rt' })).toBe(false);
    expect(shopeeNeedsAuthorization('HMAC', { tokenProvider: 'shopee', refreshToken: '{{X}}' })).toBe(true);
    expect(shopeeNeedsAuthorization('HMAC', { signature: { secret: 's' } })).toBe(false);
    expect(shopeeNeedsAuthorization('OAUTH2', { tokenProvider: 'shopee' })).toBe(false);
  });
});

describe('ShopeeTokenService', () => {
  let row: Record<string, any> | null;
  let prisma: any;
  let authStatus: { mark: jest.Mock; clear: jest.Mock };
  let service: ShopeeTokenService;

  const baseAuth = {
    tokenProvider: 'shopee',
    partnerId: '2001887',
    signature: { secret: PARTNER_KEY, queryParams: { partner_id: '2001887' } },
  };
  const setRow = (authConfig: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    row = {
      authConfig: encrypt(JSON.stringify(authConfig), KEY),
      envVars: {},
      authStatus: null,
      authStatusRef: null,
      authStatusMessage: null,
      ...extra,
    };
  };
  const stored = () => JSON.parse(decrypt(row!.authConfig, KEY));
  const config = (authConfig: Record<string, unknown>) => ({ baseUrl: HOST, authConfig, connectorId: 'conn-1' });
  const answer = (data: Record<string, unknown>) => ({ data, status: 200 });

  beforeEach(() => {
    jest.clearAllMocks();
    row = null;
    prisma = {
      connector: {
        findUnique: jest.fn(async () => row),
        update: jest.fn(async ({ data }: any) => {
          row = { ...row, ...data };
          return row;
        }),
      },
    };
    authStatus = { mark: jest.fn(async () => undefined), clear: jest.fn(async () => undefined) };
    const cfg = { get: jest.fn().mockReturnValue(KEY) } as unknown as ConfigService;
    service = new ShopeeTokenService(prisma, cfg, authStatus as any);
  });

  it('refuses to call before the shop is authorized, without a request', async () => {
    setRow(baseAuth);
    await expect(service.getShopParams(config(baseAuth))).rejects.toMatchObject({
      status: 401,
      message: expect.stringMatching(/not been authorized yet.*Authorize with Provider/),
    });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('uses a stored token that is still valid, without renewing', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-1', shopId: '14701711', expiresAt: Date.now() + 3 * HOUR, expiresIn: 14400 };
    setRow(auth);
    expect(await service.getShopParams(config(auth))).toEqual({ access_token: 'at-1', shop_id: '14701711' });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('renews before expiry, signs the public call, and stores the rotated refresh token encrypted', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-1', shopId: '14701711', expiresAt: Date.now() + 60_000, expiresIn: 14400 };
    setRow(auth);
    mockedAxios.post.mockResolvedValueOnce(
      answer({ error: '', message: '', access_token: 'at-2', refresh_token: 'rt-2', expire_in: 14400, shop_id: 14701711 }),
    );
    const t0 = Math.floor(Date.now() / 1000) * 1000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
    auth.expiresAt = t0 + 60_000;
    setRow(auth);
    try {
      expect(await service.getShopParams(config(auth))).toEqual({ access_token: 'at-2', shop_id: '14701711' });
    } finally {
      now.mockRestore();
    }

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [url, body, opts] = mockedAxios.post.mock.calls[0] as [string, any, any];
    expect(url).toBe(`${HOST}/api/v2/auth/access_token/get`);
    expect(body).toEqual({ refresh_token: 'rt-1', shop_id: 14701711, partner_id: 2001887 });
    expect(opts.params).toEqual({
      partner_id: '2001887',
      timestamp: t0 / 1000,
      sign: shopeeSign(PARTNER_KEY, `2001887/api/v2/auth/access_token/get${t0 / 1000}`),
    });

    // Rotation: the new refresh token replaced the spent one, encrypted at rest.
    expect(stored()).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2', expiresIn: 14400, shopId: '14701711' });
    expect(row!.authConfig).not.toContain('rt-2');
    expect(authStatus.clear).toHaveBeenCalledWith('conn-1');

    // Cached: the next call asks nobody.
    expect(await service.getShopParams(config(auth))).toEqual({ access_token: 'at-2', shop_id: '14701711' });
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('spends each refresh token once: the next renewal reads the rotated one from the database', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-1', shopId: '1', expiresAt: Date.now() - 1000, expiresIn: 14400 };
    setRow(auth);
    mockedAxios.post
      .mockResolvedValueOnce(answer({ error: '', access_token: 'at-2', refresh_token: 'rt-2', expire_in: 14400 }))
      .mockResolvedValueOnce(answer({ error: '', access_token: 'at-3', refresh_token: 'rt-3', expire_in: 14400 }));
    await service.getShopParams(config(auth));

    // Four hours later, with the registry's stale snapshot (still rt-1).
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * HOUR);
    try {
      expect(await service.getShopParams(config(auth))).toEqual({ access_token: 'at-3', shop_id: '1' });
    } finally {
      now.mockRestore();
    }
    expect((mockedAxios.post.mock.calls[1][1] as any).refresh_token).toBe('rt-2');
    expect(stored().refreshToken).toBe('rt-3');
  });

  it('renews once for a burst of calls (single flight)', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-1', shopId: '1', expiresAt: Date.now() - 1000 };
    setRow(auth);
    let release!: () => void;
    mockedAxios.post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(answer({ error: '', access_token: 'at-2', refresh_token: 'rt-2', expire_in: 14400 }));
        }) as any,
    );
    const calls = Array.from({ length: 8 }, () => service.getShopParams(config(auth)));
    await new Promise((r) => setImmediate(r));
    release();
    const out = await Promise.all(calls);
    expect(out.every((o) => o.access_token === 'at-2')).toBe(true);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('takes a token another process renewed meanwhile instead of spending the refresh token', async () => {
    const snapshot = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-1', shopId: '1', expiresAt: Date.now() - 1000, expiresIn: 14400 };
    setRow({
      ...snapshot,
      accessToken: 'at-other',
      refreshToken: 'rt-other',
      expiresAt: Date.now() + 4 * HOUR,
      lastRefreshedAt: new Date().toISOString(),
    });
    expect(await service.getShopParams(config(snapshot))).toEqual({ access_token: 'at-other', shop_id: '1' });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('marks the connector needs_reauth when Shopee refuses the refresh token, and stops asking', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-dead', shopId: '1', expiresAt: Date.now() - 1000 };
    setRow(auth);
    mockedAxios.post.mockRejectedValue({
      response: { status: 403, data: { error: 'refresh_token_expired', message: 'Refresh token is expired.' } },
    });
    const first = service.getShopParams(config(auth));
    await expect(first).rejects.toMatchObject({ status: 401 });
    await expect(first).rejects.toThrow(/refused the shop's refresh token.*Authorize with Provider again/);
    expect(authStatus.mark).toHaveBeenCalledWith('conn-1', {
      status: 'needs_reauth',
      code: 'refresh_refused',
      message: expect.stringContaining('refresh_token_expired'),
      ref: credentialRef('rt-dead'),
    });
    for (let i = 0; i < 5; i++) {
      await expect(service.getShopParams(config(auth))).rejects.toMatchObject({ status: 401 });
    }
    expect(await service.renewAfterRejection(config(auth), Date.now())).toBeNull();
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('a refusal answered with HTTP 200 and an error code counts the same', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-x', shopId: '1', expiresAt: Date.now() - 1000 };
    setRow(auth);
    mockedAxios.post.mockResolvedValueOnce(answer({ error: 'error_shop_refresh_token', message: 'Your refresh token is error' }));
    await expect(service.getShopParams(config(auth))).rejects.toMatchObject({ status: 401 });
    expect(authStatus.mark).toHaveBeenCalledWith('conn-1', expect.objectContaining({ status: 'needs_reauth', ref: credentialRef('rt-x') }));
  });

  it('does not ask again after a refusal recorded by another process, until the shop is authorized again', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-dead', shopId: '1', expiresAt: Date.now() - 1000 };
    setRow(auth, { authStatus: 'needs_reauth', authStatusRef: credentialRef('rt-dead'), authStatusMessage: 'Authorize again.' });
    await expect(service.getShopParams(config(auth))).rejects.toMatchObject({ status: 401, hint: 'Authorize again.' });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('a 5xx or network failure does not mark the connector, and a still valid token is used', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-1', shopId: '1', expiresAt: Date.now() + 60_000, expiresIn: 14400 };
    setRow(auth);
    mockedAxios.post.mockRejectedValue({ response: { status: 502, data: 'Bad gateway' } });
    expect(await service.getShopParams(config(auth))).toEqual({ access_token: 'at-1', shop_id: '1' });
    expect(authStatus.mark).not.toHaveBeenCalled();
  });

  it('stores the rotated token again outside the lock when the transaction fails after Shopee answered', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-1', shopId: '1', expiresAt: Date.now() - 1000 };
    setRow(auth);
    const tx = {
      $executeRaw: jest.fn(async () => 1),
      connector: {
        findUnique: prisma.connector.findUnique,
        update: jest.fn(async () => {
          throw new Error('could not serialize access');
        }),
      },
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(tx));
    mockedAxios.post.mockResolvedValueOnce(answer({ error: '', access_token: 'at-2', refresh_token: 'rt-2', expire_in: 14400 }));
    expect(await service.getShopParams(config(auth))).toEqual({ access_token: 'at-2', shop_id: '1' });
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(stored().refreshToken).toBe('rt-2');
  });

  it('exchanges the authorization code and stores the shop tokens', async () => {
    setRow(baseAuth);
    mockedAxios.post.mockResolvedValueOnce(
      answer({ error: '', message: '', access_token: 'at-new', refresh_token: 'rt-new', expire_in: 14400, request_id: 'r' }),
    );
    await service.exchangeCode({
      connectorId: 'conn-1',
      app: { host: HOST, partnerId: '2001887', partnerKey: PARTNER_KEY },
      code: 'code-1',
      shopId: '14701711',
    });
    const [url, body, opts] = mockedAxios.post.mock.calls[0] as [string, any, any];
    expect(url).toBe(`${HOST}/api/v2/auth/token/get`);
    expect(body).toEqual({ code: 'code-1', shop_id: 14701711, partner_id: 2001887 });
    expect(opts.params.sign).toBe(shopeeSign(PARTNER_KEY, `2001887/api/v2/auth/token/get${opts.params.timestamp}`));
    expect(stored()).toMatchObject({
      tokenProvider: 'shopee',
      accessToken: 'at-new',
      refreshToken: 'rt-new',
      shopId: '14701711',
      expiresIn: 14400,
    });
    expect(authStatus.clear).toHaveBeenCalledWith('conn-1');
    // Ready at once, from the cache.
    expect(await service.getShopParams(config(baseAuth))).toEqual({ access_token: 'at-new', shop_id: '14701711' });
  });

  it('a refused code exchange stores nothing', async () => {
    setRow(baseAuth);
    mockedAxios.post.mockResolvedValueOnce(answer({ error: 'invalid_code', message: 'Invalid code.' }));
    await expect(
      service.exchangeCode({
        connectorId: 'conn-1',
        app: { host: HOST, partnerId: '2001887', partnerKey: PARTNER_KEY },
        code: 'used',
        shopId: '1',
      }),
    ).rejects.toThrow(/invalid_code/);
    expect(prisma.connector.update).not.toHaveBeenCalled();
  });
});
