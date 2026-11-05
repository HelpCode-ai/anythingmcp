import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  TikTokShopTokenService,
  buildTikTokShopAuthorizationUrl,
  isTikTokShopAccessTokenRejected,
  isTikTokShopRefreshRefused,
  pickShop,
  shopCipherApplies,
  tiktokShopAppFrom,
  tiktokShopNeedsAuthorization,
  tiktokShopSign,
  tokensFrom,
} from './tiktok-shop-token.service';
import { credentialRef } from './connector-auth-status.service';
import { decrypt, encrypt } from '../../common/crypto/encryption.util';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
jest.mock('../../common/ssrf.util', () => ({
  ...jest.requireActual('../../common/ssrf.util'),
  assertSafeOutboundUrl: jest.fn().mockResolvedValue(undefined),
}));

const KEY = 'test-encryption-key-32-chars!!!!';
const SECRET = 'testappsecret1234567890';
const API = 'https://open-api.tiktokglobalshop.com';
const DAY = 24 * 60 * 60 * 1000;
const CIPHER = 'GCP_XF90igAAAABh00qsWgtvOiGFNqyubMt3';

/**
 * Expected signatures were computed independently (Python hmac/hashlib)
 * from the algorithm in TikTok Shop's guide "Sign your API request": the
 * query parameters except sign and access_token, sorted, as key + value,
 * after the path, then the body, wrapped in the app secret, HMAC-SHA256
 * keyed with the secret, hex. The app key and timestamp are the guide's
 * samples; the secret is a test value.
 */
describe('TikTok Shop signing helpers', () => {
  it('signs Get Authorized Shops like the guide', () => {
    expect(
      tiktokShopSign({
        secret: SECRET,
        path: '/authorization/202309/shops',
        query: { timestamp: '1623812664', app_key: '38abcd', sign: 'ignored', access_token: 'ignored' },
      }),
    ).toBe('77c8ca20f976b6e452547ae263fcf04d72800f32da727bf78067f355b55c3e89');
  });

  it('signs a POST with its JSON body and the shop cipher', () => {
    expect(
      tiktokShopSign({
        secret: SECRET,
        path: '/order/202309/orders/search',
        query: { app_key: '38abcd', timestamp: '1623812664', shop_cipher: CIPHER, page_size: '20' },
        body: '{"order_status":"AWAITING_SHIPMENT","create_time_ge":1700000000}',
      }),
    ).toBe('c522cb92b116fbafbff34432d13a1ffebbbee958bb6504f8cdaffeece89583a5');
  });

  it('builds the seller authorization link on the right domain', () => {
    expect(buildTikTokShopAuthorizationUrl('7256213', 'st-1')).toBe(
      'https://services.tiktokshop.com/open/authorize?service_id=7256213&state=st-1',
    );
    expect(buildTikTokShopAuthorizationUrl('7256213', 'st-1', 'us')).toBe(
      'https://services.us.tiktokshop.com/open/authorize?service_id=7256213&state=st-1',
    );
  });

  it('leaves shop_cipher out where TikTok refuses it', () => {
    expect(shopCipherApplies('/order/202309/orders/search', 'POST')).toBe(true);
    expect(shopCipherApplies('/product/202309/categories')).toBe(true);
    expect(shopCipherApplies('/product/202309/brands', 'GET')).toBe(true);
    expect(shopCipherApplies('/product/202309/brands', 'POST')).toBe(false);
    expect(shopCipherApplies('/authorization/202309/shops')).toBe(false);
    expect(shopCipherApplies('/seller/202309/shops')).toBe(false);
    expect(shopCipherApplies('/product/202309/images/upload', 'POST')).toBe(false);
    expect(shopCipherApplies('/product/202309/global_products/123')).toBe(false);
  });

  it('reads the app from the resolved authConfig', () => {
    const auth = { appKey: '38abcd', serviceId: '7256213', signature: { secret: SECRET } };
    expect(tiktokShopAppFrom(auth, `${API}/`)).toEqual({ appKey: '38abcd', appSecret: SECRET, serviceId: '7256213', apiHost: API });
    expect(tiktokShopAppFrom({ ...auth, serviceId: '{{TIKTOK_SHOP_SERVICE_ID}}' }, API)).toEqual({
      appKey: '38abcd',
      appSecret: SECRET,
      apiHost: API,
    });
    expect(tiktokShopAppFrom({ ...auth, appKey: '{{TIKTOK_SHOP_APP_KEY}}' }, API)).toBeUndefined();
  });

  it('classifies refusals', () => {
    const err = (status: number, code: number, message = '') => ({ response: { status, data: { code, message } } });
    expect(isTikTokShopAccessTokenRejected(err(401, 105002, 'Expired credentials.'))).toBe(true);
    expect(isTikTokShopAccessTokenRejected(err(401, 36009004, 'Invalid credentials. The x-tts-access-token header is invalid.'))).toBe(true);
    expect(isTikTokShopAccessTokenRejected(err(401, 36009004, 'Invalid timestamp.'))).toBe(false);
    expect(isTikTokShopAccessTokenRejected(err(401, 106001, 'Invalid credentials. The sign query parameter is invalid.'))).toBe(false);
    expect(isTikTokShopAccessTokenRejected({ status: 401, responseBody: { code: 105002 } })).toBe(true);

    expect(isTikTokShopRefreshRefused(err(200, 36004004, 'invalid refresh token'))).toBe(true);
    expect(isTikTokShopRefreshRefused(err(200, 36009002, 'Too many requests'))).toBe(false);
    expect(isTikTokShopRefreshRefused(err(500, 36004004))).toBe(false);
    expect(isTikTokShopRefreshRefused(err(200, 36009004, 'Invalid app_key'))).toBe(false);
    expect(isTikTokShopRefreshRefused(new Error('socket hang up'))).toBe(false);
  });

  it('reads expiry timestamps from the token answer', () => {
    const now = 1_700_000_000_000;
    const t = tokensFrom(
      {
        code: 0,
        data: {
          access_token: 'at',
          refresh_token: 'rt',
          access_token_expire_in: 1_700_000_000 + 604_800,
          refresh_token_expire_in: 1_731_536_000,
          seller_name: 'Test Seller',
          granted_scopes: ['seller.order.info'],
        },
      },
      now,
    );
    expect(t).toMatchObject({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: (1_700_000_000 + 604_800) * 1000,
      expiresIn: 604_800,
      refreshTokenExpiresAt: 1_731_536_000_000,
      sellerName: 'Test Seller',
      grantedScopes: ['seller.order.info'],
    });
    expect(() => tokensFrom({ code: 36004004, message: 'Invalid auth code.' })).toThrow(/refused/);
  });

  it('picks the preferred shop by id, code or name, else the first', () => {
    const shops = [
      { id: '1', name: 'UK Shop', code: 'GBAAA', cipher: 'c1' },
      { id: '2', name: 'DE Shop', code: 'DEBBB', cipher: 'c2' },
    ];
    expect(pickShop(shops)?.cipher).toBe('c1');
    expect(pickShop(shops, '2')?.cipher).toBe('c2');
    expect(pickShop(shops, 'debbb')?.cipher).toBe('c2');
    expect(pickShop(shops, 'de shop')?.cipher).toBe('c2');
    expect(pickShop(shops, 'nope')?.cipher).toBe('c1');
    expect(pickShop(shops, '{{TIKTOK_SHOP_SHOP_ID}}')?.cipher).toBe('c1');
  });

  it('only a TikTok Shop HMAC connector without tokens needs authorization', () => {
    expect(tiktokShopNeedsAuthorization('HMAC', { tokenProvider: 'tiktok-shop' })).toBe(true);
    expect(tiktokShopNeedsAuthorization('HMAC', { tokenProvider: 'tiktok-shop', refreshToken: 'rt' })).toBe(false);
    expect(tiktokShopNeedsAuthorization('HMAC', { tokenProvider: 'shopee' })).toBe(false);
    expect(tiktokShopNeedsAuthorization('OAUTH2', { tokenProvider: 'tiktok-shop' })).toBe(false);
  });
});

describe('TikTokShopTokenService', () => {
  let row: Record<string, any> | null;
  let prisma: any;
  let authStatus: { mark: jest.Mock; clear: jest.Mock };
  let service: TikTokShopTokenService;

  const baseAuth = {
    tokenProvider: 'tiktok-shop',
    appKey: '38abcd',
    serviceId: '7256213',
    signature: { secret: SECRET, queryParams: { app_key: '38abcd' } },
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
  const config = (authConfig: Record<string, unknown>) => ({ baseUrl: API, authConfig, connectorId: 'conn-1' });
  const tokenAnswer = (at: string, rt: string, now = Date.now()) => ({
    status: 200,
    data: {
      code: 0,
      message: 'success',
      data: {
        access_token: at,
        refresh_token: rt,
        access_token_expire_in: Math.floor(now / 1000) + 7 * 86400,
        refresh_token_expire_in: Math.floor(now / 1000) + 365 * 86400,
        seller_name: 'Test Seller',
        seller_base_region: 'GB',
      },
    },
  });
  const shopsAnswer = {
    status: 200,
    data: { code: 0, data: { shops: [{ id: '700', name: 'Maomao', region: 'GB', seller_type: 'LOCAL', cipher: CIPHER, code: 'GBX' }] } },
  };

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
    service = new TikTokShopTokenService(prisma, cfg, authStatus as any);
  });

  it('refuses to call before the shop is authorized, without a request', async () => {
    setRow(baseAuth);
    await expect(service.getShopCredentials(config(baseAuth))).rejects.toMatchObject({
      status: 401,
      message: expect.stringMatching(/not been authorized yet.*Authorize with Provider/),
    });
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('exchanges the code with a GET, reads the shops, and stores everything encrypted', async () => {
    setRow(baseAuth);
    const t0 = 1_700_000_000_000;
    mockedAxios.get.mockResolvedValueOnce(tokenAnswer('at-1', 'rt-1', t0)).mockResolvedValueOnce(shopsAnswer as never);
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      const out = await service.exchangeCode({
        connectorId: 'conn-1',
        app: { appKey: '38abcd', appSecret: SECRET, apiHost: API },
        code: 'TTP_code',
      });
      expect(out).toEqual({ shopName: 'Maomao', shopCount: 1 });
    } finally {
      now.mockRestore();
    }
    const [tokenUrl, tokenOpts] = mockedAxios.get.mock.calls[0] as [string, any];
    expect(tokenUrl).toBe('https://auth.tiktok-shops.com/api/v2/token/get');
    expect(tokenOpts.params).toEqual({ app_key: '38abcd', app_secret: SECRET, auth_code: 'TTP_code', grant_type: 'authorized_code' });

    const [shopsUrl, shopsOpts] = mockedAxios.get.mock.calls[1] as [string, any];
    expect(shopsUrl).toBe(`${API}/authorization/202309/shops`);
    expect(shopsOpts.headers['x-tts-access-token']).toBe('at-1');
    expect(shopsOpts.params).toEqual({
      app_key: '38abcd',
      timestamp: '1700000000',
      sign: tiktokShopSign({ secret: SECRET, path: '/authorization/202309/shops', query: { app_key: '38abcd', timestamp: '1700000000' } }),
    });
    expect(JSON.stringify(shopsOpts.params)).not.toContain(SECRET);

    expect(stored()).toMatchObject({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: t0 + 7 * DAY,
      shopCipher: CIPHER,
      shopId: '700',
      shopName: 'Maomao',
      shopRegion: 'GB',
      sellerName: 'Test Seller',
    });
    expect(row!.authConfig).not.toContain('rt-1');
    expect(authStatus.clear).toHaveBeenCalledWith('conn-1');
    // Cached: the next call (a day later) asks nobody.
    const later = jest.spyOn(Date, 'now').mockReturnValue(t0 + DAY);
    try {
      expect(await service.getShopCredentials(config(stored()))).toEqual({ accessToken: 'at-1', shopCipher: CIPHER });
    } finally {
      later.mockRestore();
    }
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it('uses a stored token that is still valid, without renewing', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-1', shopCipher: CIPHER, expiresAt: Date.now() + 5 * DAY, expiresIn: 604800 };
    setRow(auth);
    expect(await service.getShopCredentials(config(auth))).toEqual({ accessToken: 'at-1', shopCipher: CIPHER });
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('renews within a day of expiry and stores the new refresh token', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-1', shopCipher: CIPHER, expiresAt: Date.now() + 2 * 60 * 60 * 1000, expiresIn: 604800 };
    setRow(auth);
    mockedAxios.get.mockResolvedValueOnce(tokenAnswer('at-2', 'rt-2'));
    expect(await service.getShopCredentials(config(auth))).toEqual({ accessToken: 'at-2', shopCipher: CIPHER });
    const [url, opts] = mockedAxios.get.mock.calls[0] as [string, any];
    expect(url).toBe('https://auth.tiktok-shops.com/api/v2/token/refresh');
    expect(opts.params).toEqual({ app_key: '38abcd', app_secret: SECRET, refresh_token: 'rt-1', grant_type: 'refresh_token' });
    expect(stored()).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2', shopCipher: CIPHER });
    expect(stored().lastRefreshedAt).toEqual(expect.any(String));
  });

  it('marks the connector needs_reauth once when TikTok refuses the refresh token', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-1', shopCipher: CIPHER, expiresAt: Date.now() - 1000, expiresIn: 604800 };
    setRow(auth);
    mockedAxios.get.mockResolvedValueOnce({ status: 200, data: { code: 36004004, message: 'refresh_token is invalid' } } as never);
    await expect(service.getShopCredentials(config(auth))).rejects.toMatchObject({
      status: 401,
      message: expect.stringMatching(/Authorize with Provider again/),
    });
    expect(authStatus.mark).toHaveBeenCalledWith('conn-1', expect.objectContaining({ status: 'needs_reauth', ref: credentialRef('rt-1') }));
    // Refused a moment ago: the next call fails at once, without a request.
    await expect(service.getShopCredentials(config(auth))).rejects.toMatchObject({ status: 401 });
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('does not mark needs_reauth on a rate limit', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() - 1000, expiresIn: 604800 };
    setRow(auth);
    mockedAxios.get.mockResolvedValueOnce({ status: 200, data: { code: 36009002, message: 'Too many requests' } } as never);
    await expect(service.getShopCredentials(config(auth))).rejects.toMatchObject({
      status: 401,
      message: expect.stringMatching(/Try again in a few minutes/),
    });
    expect(authStatus.mark).not.toHaveBeenCalled();
  });

  it('stops at once when the authorization period has ended', async () => {
    const auth = {
      ...baseAuth,
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: Date.now() - 1000,
      expiresIn: 604800,
      refreshTokenExpiresAt: Date.now() - 1000,
    };
    setRow(auth);
    await expect(service.getShopCredentials(config(auth))).rejects.toMatchObject({ status: 401 });
    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(authStatus.mark).toHaveBeenCalledWith('conn-1', expect.objectContaining({ status: 'needs_reauth' }));
  });

  it('reads the shop cipher on the first call when the authorization stored none', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 5 * DAY, expiresIn: 604800 };
    setRow(auth);
    mockedAxios.get.mockResolvedValueOnce(shopsAnswer as never);
    expect(await service.getShopCredentials(config(auth))).toEqual({ accessToken: 'at-1', shopCipher: CIPHER });
    expect(stored()).toMatchObject({ shopCipher: CIPHER, shopId: '700' });
  });

  it('renews after a rejection, once for a burst', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-1', shopCipher: CIPHER, expiresAt: Date.now() + 5 * DAY, expiresIn: 604800 };
    setRow(auth);
    mockedAxios.get.mockResolvedValueOnce(tokenAnswer('at-2', 'rt-2'));
    const sentAt = Date.now() - 10;
    const [a, b] = await Promise.all([
      service.renewAfterRejection(config(auth), sentAt),
      service.renewAfterRejection(config(auth), sentAt),
    ]);
    expect(a).toEqual({ accessToken: 'at-2', shopCipher: CIPHER });
    expect(b).toEqual({ accessToken: 'at-2', shopCipher: CIPHER });
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });
});
