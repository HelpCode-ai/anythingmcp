import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createHmac } from 'node:crypto';
import {
  IopTokenService,
  buildIopAuthorizationUrl,
  iopAppFrom,
  iopNeedsAuthorization,
  iopSign,
  iopSignString,
  isIopAccessTokenRejected,
  isIopAuth,
  isIopRefreshRefused,
} from './iop-token.service';
import { credentialRef } from './connector-auth-status.service';
import { ResponseBodyError } from './response-error.util';
import { decrypt, encrypt } from '../../common/crypto/encryption.util';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
jest.mock('../../common/ssrf.util', () => ({
  ...jest.requireActual('../../common/ssrf.util'),
  assertSafeOutboundUrl: jest.fn().mockResolvedValue(undefined),
}));

const KEY = 'test-encryption-key-32-chars!!!!';
const SECRET = 'helloworld';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** The provider config as an adapter writes it (Lazada), resolved. */
const lazadaAuth = (appKey = '100132', secret = SECRET) => ({
  tokenProvider: 'iop',
  iop: {
    appKey,
    authorizeUrl: 'https://auth.lazada.com/oauth/authorize',
    tokenBaseUrl: 'https://auth.lazada.com/rest',
    tokenPath: '/auth/token/create',
    refreshPath: '/auth/token/refresh',
    authorizeParams: { force_auth: 'true' },
  },
  signature: {
    algorithm: 'sha256',
    encoding: 'hex-upper',
    secret,
    placement: 'query',
    paramName: 'sign',
    timestampParam: 'timestamp',
    timestampFormat: 'ms',
    queryParams: { app_key: appKey, sign_method: 'sha256' },
    template: '${apiPath}${sortedParams}',
  },
});

describe('IOP signing and config helpers', () => {
  it("reproduces AliExpress's documented system-call signature (HTTP request sample, case 2: /auth/token/create)", () => {
    // openservice.aliexpress.com docId 1385: app key 12345678, secret helloworld.
    const params = {
      app_key: '12345678',
      code: '3_500102_JxZ05Ux3cnnSSUm6dCxYg6Q26',
      sign_method: 'sha256',
      timestamp: '1517820392000',
    };
    expect(iopSignString('/auth/token/create', params)).toBe(
      '/auth/token/createapp_key12345678code3_500102_JxZ05Ux3cnnSSUm6dCxYg6Q26sign_methodsha256timestamp1517820392000',
    );
    expect(iopSign(SECRET, '/auth/token/create', params)).toBe(
      '35607762342831B6A417A0DED84B79C05FEFBF116969C48AD6DC00279A9F4D81',
    );
    // The signature parameter and empty values are not part of the string.
    expect(iopSign(SECRET, '/auth/token/create', { ...params, sign: 'X', uuid: '' })).toBe(
      '35607762342831B6A417A0DED84B79C05FEFBF116969C48AD6DC00279A9F4D81',
    );
  });

  it('reads the gateway settings from the resolved authConfig, and refuses incomplete or unsafe ones', () => {
    expect(iopAppFrom(lazadaAuth())).toEqual({
      appKey: '100132',
      appSecret: SECRET,
      authorizeUrl: 'https://auth.lazada.com/oauth/authorize',
      tokenBaseUrl: 'https://auth.lazada.com/rest',
      tokenPath: '/auth/token/create',
      refreshPath: '/auth/token/refresh',
      authorizeParams: { force_auth: 'true' },
      algorithm: 'sha256',
      systemParams: { app_key: '100132', sign_method: 'sha256' },
      signParam: 'sign',
      timestampParam: 'timestamp',
      tokenResponsePath: undefined,
    });
    // Unresolved variables, a missing secret, http or a relative token path: no app.
    expect(iopAppFrom(lazadaAuth('{{LAZADA_APP_KEY}}'))).toBeUndefined();
    expect(iopAppFrom(lazadaAuth('100132', ''))).toBeUndefined();
    const http = lazadaAuth();
    http.iop.tokenBaseUrl = 'http://auth.lazada.com/rest';
    expect(iopAppFrom(http)).toBeUndefined();
    const relative = lazadaAuth();
    relative.iop.refreshPath = 'auth/token/refresh';
    expect(iopAppFrom(relative)).toBeUndefined();
    // The app key falls back to the signed app_key.
    const noKey = lazadaAuth() as any;
    delete noKey.iop.appKey;
    expect(iopAppFrom(noKey)?.appKey).toBe('100132');
  });

  it('builds the authorize link with the static parameters, client id, callback and state', () => {
    const url = new URL(
      buildIopAuthorizationUrl(iopAppFrom(lazadaAuth())!, 'https://cloud.anythingmcp.com/api/iop-auth/callback', 'st-1'),
    );
    expect(url.origin + url.pathname).toBe('https://auth.lazada.com/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      force_auth: 'true',
      response_type: 'code',
      client_id: '100132',
      redirect_uri: 'https://cloud.anythingmcp.com/api/iop-auth/callback',
      state: 'st-1',
    });
    expect(url.toString()).not.toContain(SECRET);
    // A static parameter cannot replace the four the flow depends on.
    const sneaky = lazadaAuth() as any;
    sneaky.iop.authorizeParams = { client_id: 'other', state: 'x' };
    const u2 = new URL(buildIopAuthorizationUrl(iopAppFrom(sneaky)!, 'https://x.test/cb', 'st-2'));
    expect(u2.searchParams.get('client_id')).toBe('100132');
    expect(u2.searchParams.get('state')).toBe('st-2');
  });

  it('only an HMAC connector with tokenProvider "iop" uses the provider and needs authorization without tokens', () => {
    expect(isIopAuth('HMAC', { tokenProvider: 'iop' })).toBe(true);
    expect(isIopAuth('HMAC', { tokenProvider: 'shopee' })).toBe(false);
    expect(isIopAuth('OAUTH2', { tokenProvider: 'iop' })).toBe(false);
    expect(isIopAuth('HMAC', { signature: { secret: 's' } })).toBe(false);
    expect(iopNeedsAuthorization('HMAC', { tokenProvider: 'iop' })).toBe(true);
    expect(iopNeedsAuthorization('HMAC', { tokenProvider: 'iop', refreshToken: 'rt' })).toBe(false);
    expect(iopNeedsAuthorization('HMAC', { tokenProvider: 'iop', accessToken: '{{X}}' })).toBe(true);
    expect(iopNeedsAuthorization('HMAC', { signature: { secret: 's' } })).toBe(false);
    expect(iopNeedsAuthorization('HMAC', { tokenProvider: 'shopee' })).toBe(false);
  });

  it('tells a refused refresh token from other failures', () => {
    const err = (status: number, code: string, message = '') => ({ response: { status, data: { code, type: 'ISV', message } } });
    expect(isIopRefreshRefused(err(200, 'IllegalRefreshToken', 'The specified refresh token is invalid or expired'))).toBe(true);
    expect(isIopRefreshRefused(err(400, 'IllegalRefreshToken'))).toBe(true);
    expect(isIopRefreshRefused(err(200, 'AUTH_TYPE_UNSUPPORTED'))).toBe(true);
    expect(isIopRefreshRefused({ response: { status: 200, data: { error_response: { code: 'IllegalRefreshToken', msg: 'x' } } } })).toBe(true);
    expect(isIopRefreshRefused(err(200, 'IncompleteSignature'))).toBe(false);
    expect(isIopRefreshRefused(err(200, 'InvalidAppkey'))).toBe(false);
    expect(isIopRefreshRefused(err(500, 'IllegalRefreshToken'))).toBe(false);
    expect(isIopRefreshRefused({ response: { status: 200, data: { code: '0' } } })).toBe(false);
    expect(isIopRefreshRefused(new Error('socket hang up'))).toBe(false);
  });

  it('renews on a 401 that names the token, not on a bad signature, key or permission', () => {
    const body = (code: string) => new ResponseBodyError(`The API answered with an error: ${code}`, 401, { code, message: 'm' });
    expect(isIopAccessTokenRejected(body('IllegalAccessToken'))).toBe(true);
    expect(isIopAccessTokenRejected(body('MissingAccessToken'))).toBe(true);
    expect(isIopAccessTokenRejected({ response: { status: 401, data: 'Unauthorized' } })).toBe(true);
    expect(isIopAccessTokenRejected(body('IncompleteSignature'))).toBe(false);
    expect(isIopAccessTokenRejected(body('InvalidAppKey'))).toBe(false);
    expect(isIopAccessTokenRejected(body('IllegalTimestamp'))).toBe(false);
    expect(isIopAccessTokenRejected(new ResponseBodyError('x', 400, { code: 'IllegalAccessToken' }))).toBe(false);
    expect(isIopAccessTokenRejected(new ResponseBodyError('x', 403, { code: 'InsufficientPermission' }))).toBe(false);
  });
});

describe('IopTokenService', () => {
  let row: Record<string, any> | null;
  let prisma: any;
  let authStatus: { mark: jest.Mock; clear: jest.Mock };
  let service: IopTokenService;

  const baseAuth = lazadaAuth();
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
  const config = (authConfig: Record<string, unknown>) => ({ baseUrl: 'https://api.lazada.sg/rest', authConfig, connectorId: 'conn-1' });
  const answer = (data: Record<string, unknown>) => ({ data, status: 200 });
  /** Lazada's documented answer shape (seller authorization guide, docId 108260). */
  const tokenAnswer = (access: string, refresh: string, extra: Record<string, unknown> = {}) =>
    answer({
      access_token: access,
      refresh_token: refresh,
      expires_in: 864000,
      refresh_expires_in: 4320000,
      country: 'sg',
      account_platform: 'seller_center',
      code: '0',
      request_id: 'r',
      ...extra,
    });

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
    service = new IopTokenService(prisma, cfg, authStatus as any);
  });

  it('refuses to call before the seller authorized the app, without a request', async () => {
    setRow(baseAuth);
    await expect(service.getCredentialParams(config(baseAuth))).rejects.toMatchObject({
      status: 401,
      message: expect.stringMatching(/not authorized this connector yet.*Authorize with Provider/),
    });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('exchanges the code with a signed system call and stores the tokens encrypted, lifetimes from the answer', async () => {
    setRow(baseAuth);
    const t0 = 1767595695482;
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
    mockedAxios.post.mockResolvedValueOnce(tokenAnswer('at-new', 'rt-new'));
    try {
      await service.exchangeCode({ connectorId: 'conn-1', app: iopAppFrom(baseAuth)!, code: '0_100132_Cl3VmMr6W6YC6cx6swxFAZ0l825' });
      // Ready at once, from the cache, with the connector's template authConfig.
      expect(await service.getCredentialParams(config(baseAuth))).toEqual({ access_token: 'at-new' });
    } finally {
      now.mockRestore();
    }
    const [url, body, opts] = mockedAxios.post.mock.calls[0] as [string, any, any];
    expect(url).toBe('https://auth.lazada.com/rest/auth/token/create');
    // The code goes in the form body, never in the URL; the system parameters in the query.
    expect(body).toBe('code=0_100132_Cl3VmMr6W6YC6cx6swxFAZ0l825');
    expect(opts.headers['Content-Type']).toMatch(/^application\/x-www-form-urlencoded/);
    expect(opts.params).toEqual({
      app_key: '100132',
      sign_method: 'sha256',
      timestamp: String(t0),
      sign: iopSign(SECRET, '/auth/token/create', {
        app_key: '100132',
        sign_method: 'sha256',
        timestamp: String(t0),
        code: '0_100132_Cl3VmMr6W6YC6cx6swxFAZ0l825',
      }),
    });
    // Written out by hand: path, then name + value sorted by name.
    expect(opts.params.sign).toBe(
      createHmac('sha256', SECRET)
        .update(`/auth/token/createapp_key100132code0_100132_Cl3VmMr6W6YC6cx6swxFAZ0l825sign_methodsha256timestamp${t0}`)
        .digest('hex')
        .toUpperCase(),
    );
    expect(JSON.stringify(opts.params)).not.toContain(SECRET);

    expect(stored()).toMatchObject({
      tokenProvider: 'iop',
      accessToken: 'at-new',
      refreshToken: 'rt-new',
      expiresIn: 864000,
      expiresAt: t0 + 864000 * 1000,
      refreshExpiresIn: 4320000,
      refreshExpiresAt: t0 + 4320000 * 1000,
    });
    expect(row!.authConfig).not.toContain('rt-new');
    expect(authStatus.clear).toHaveBeenCalledWith('conn-1');
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('a refused code exchange stores nothing', async () => {
    setRow(baseAuth);
    mockedAxios.post.mockResolvedValueOnce(answer({ code: 'InvalidCode', type: 'ISV', message: 'Invalid authorization code', request_id: 'r' }));
    await expect(
      service.exchangeCode({ connectorId: 'conn-1', app: iopAppFrom(baseAuth)!, code: 'used' }),
    ).rejects.toThrow(/InvalidCode/);
    expect(prisma.connector.update).not.toHaveBeenCalled();
  });

  it('reads the token fields under authConfig.iop.tokenResponsePath, and AliExpress absolute expiry times', async () => {
    const wrapped = { ...baseAuth, iop: { ...baseAuth.iop, tokenResponsePath: 'data' } };
    setRow(wrapped);
    const t0 = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
    mockedAxios.post.mockResolvedValueOnce(
      answer({ code: '0', data: { access_token: 'at-w', refresh_token: 'rt-w', expire_time: t0 + 2 * DAY, refresh_token_valid_time: t0 + 30 * DAY } }),
    );
    try {
      await service.exchangeCode({ connectorId: 'conn-1', app: iopAppFrom(wrapped)!, code: 'c' });
    } finally {
      now.mockRestore();
    }
    expect(stored()).toMatchObject({
      accessToken: 'at-w',
      refreshToken: 'rt-w',
      expiresIn: 2 * 24 * 3600,
      refreshExpiresIn: 30 * 24 * 3600,
    });
  });

  it('uses a stored token that is still valid, without renewing', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3 * DAY, expiresIn: 864000 };
    setRow(auth);
    expect(await service.getCredentialParams(config(auth))).toEqual({ access_token: 'at-1' });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('renews before expiry with a signed refresh call and stores the new tokens', async () => {
    const t0 = Math.floor(Date.now() / 1000) * 1000;
    const auth = {
      ...baseAuth,
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: t0 + 10 * 60 * 1000, // inside the 30-minute window
      expiresIn: 864000,
      refreshExpiresAt: t0 + 40 * DAY,
      refreshExpiresIn: 4320000,
    };
    setRow(auth);
    mockedAxios.post.mockResolvedValueOnce(tokenAnswer('at-2', 'rt-2', { refresh_expires_in: 3456000 }));
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      expect(await service.getCredentialParams(config(auth))).toEqual({ access_token: 'at-2' });
    } finally {
      now.mockRestore();
    }
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [url, body, opts] = mockedAxios.post.mock.calls[0] as [string, any, any];
    expect(url).toBe('https://auth.lazada.com/rest/auth/token/refresh');
    expect(body).toBe('refresh_token=rt-1');
    expect(opts.params.sign).toBe(
      iopSign(SECRET, '/auth/token/refresh', { app_key: '100132', sign_method: 'sha256', timestamp: String(t0), refresh_token: 'rt-1' }),
    );
    expect(stored()).toMatchObject({
      accessToken: 'at-2',
      refreshToken: 'rt-2',
      expiresAt: t0 + 864000 * 1000,
      refreshExpiresIn: 3456000,
      refreshExpiresAt: t0 + 3456000 * 1000,
    });
    expect(row!.authConfig).not.toContain('rt-2');
    expect(authStatus.clear).toHaveBeenCalledWith('conn-1');
    // Cached: the next call asks nobody.
    expect(await service.getCredentialParams(config(auth))).toEqual({ access_token: 'at-2' });
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('keeps the stored refresh token when a refresh answer carries none', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-keep', expiresAt: Date.now() - 1000, expiresIn: 864000 };
    setRow(auth);
    mockedAxios.post.mockResolvedValueOnce(answer({ code: '0', access_token: 'at-2', expires_in: 864000 }));
    await service.getCredentialParams(config(auth));
    expect(stored()).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-keep' });
  });

  it('renews once for a burst of calls (single flight)', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() - 1000 };
    setRow(auth);
    let release!: () => void;
    mockedAxios.post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(tokenAnswer('at-2', 'rt-2'));
        }) as any,
    );
    const calls = Array.from({ length: 8 }, () => service.getCredentialParams(config(auth)));
    await new Promise((r) => setImmediate(r));
    release();
    const out = await Promise.all(calls);
    expect(out.every((o) => o.access_token === 'at-2')).toBe(true);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('takes a token another process renewed meanwhile instead of spending the refresh token', async () => {
    const snapshot = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() - 1000, expiresIn: 864000 };
    setRow({
      ...snapshot,
      accessToken: 'at-other',
      refreshToken: 'rt-other',
      expiresAt: Date.now() + 5 * DAY,
      lastRefreshedAt: new Date().toISOString(),
    });
    expect(await service.getCredentialParams(config(snapshot))).toEqual({ access_token: 'at-other' });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('marks the connector needs_reauth when the gateway refuses the refresh token, and stops asking', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-dead', expiresAt: Date.now() - 1000 };
    setRow(auth);
    mockedAxios.post.mockResolvedValue(
      answer({ code: 'IllegalRefreshToken', type: 'ISV', message: 'The specified refresh token is invalid or expired', request_id: 'r' }),
    );
    const first = service.getCredentialParams(config(auth));
    await expect(first).rejects.toMatchObject({ status: 401 });
    await expect(first).rejects.toThrow(/refused the refresh token \(HTTP 200: IllegalRefreshToken.*authorize the app again.*Authorize with Provider/);
    expect(authStatus.mark).toHaveBeenCalledWith('conn-1', {
      status: 'needs_reauth',
      code: 'refresh_refused',
      message: expect.stringContaining('IllegalRefreshToken'),
      ref: credentialRef('rt-dead'),
    });
    for (let i = 0; i < 5; i++) {
      await expect(service.getCredentialParams(config(auth))).rejects.toMatchObject({ status: 401 });
    }
    expect(await service.renewAfterRejection(config(auth), Date.now())).toBeNull();
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('does not even ask once the refresh token has expired by its own lifetime: needs sign-in, clear message', async () => {
    const auth = {
      ...baseAuth,
      accessToken: 'at-1',
      refreshToken: 'rt-old',
      expiresAt: Date.now() - 1000,
      refreshExpiresAt: Date.parse('2026-10-01T08:00:00Z'),
      refreshExpiresIn: 4320000,
    };
    setRow(auth);
    const err = await service.getCredentialParams(config(auth)).catch((e) => e);
    expect(err).toMatchObject({ status: 401 });
    expect(err.message).toMatch(/let the refresh token expire on 2026-10-01 08:00 UTC.*authorize the app again/);
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(authStatus.mark).toHaveBeenCalledWith('conn-1', expect.objectContaining({
      status: 'needs_reauth',
      code: 'refresh_expired',
      ref: credentialRef('rt-old'),
    }));
  });

  it('a refresh_expires_in of 0 means the token cannot be refreshed', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-0', expiresAt: Date.now() - 1000, refreshExpiresIn: 0 };
    setRow(auth);
    await expect(service.getCredentialParams(config(auth))).rejects.toThrow(/refresh_expires_in 0/);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('does not ask again after a refusal recorded by another process, until the seller authorizes again', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-dead', expiresAt: Date.now() - 1000 };
    setRow(auth, { authStatus: 'needs_reauth', authStatusRef: credentialRef('rt-dead'), authStatusMessage: 'Authorize again.' });
    await expect(service.getCredentialParams(config(auth))).rejects.toMatchObject({ status: 401, hint: 'Authorize again.' });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('a 5xx, a bad signature or a network failure does not mark the connector, and a still valid token is used', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 60_000, expiresIn: 864000 };
    setRow(auth);
    mockedAxios.post.mockRejectedValueOnce({ response: { status: 502, data: 'Bad gateway' } });
    expect(await service.getCredentialParams(config(auth))).toEqual({ access_token: 'at-1' });
    service.forget('conn-1');
    mockedAxios.post.mockResolvedValueOnce(answer({ code: 'IncompleteSignature', message: 'The request signature does not conform' }));
    expect(await service.getCredentialParams(config(auth))).toEqual({ access_token: 'at-1' });
    expect(authStatus.mark).not.toHaveBeenCalled();
  });

  it('renews after a rejection, but takes a token obtained since the call was sent', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 5 * DAY, expiresIn: 864000 };
    setRow(auth);
    expect(await service.getCredentialParams(config(auth))).toEqual({ access_token: 'at-1' });
    const sentAt = Date.now() - 10;
    mockedAxios.post.mockResolvedValueOnce(tokenAnswer('at-2', 'rt-2'));
    expect(await service.renewAfterRejection(config(auth), sentAt)).toEqual({ access_token: 'at-2' });
    // A second call refused with the old token, sent before the renewal: no second refresh.
    expect(await service.renewAfterRejection(config(auth), sentAt)).toEqual({ access_token: 'at-2' });
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(await service.renewAfterRejection({ ...config(auth), connectorId: undefined } as any, sentAt)).toBeNull();
  });

  it('stores the renewed token again outside the lock when the transaction fails after the gateway answered', async () => {
    const auth = { ...baseAuth, accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() - 1000 };
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
    mockedAxios.post.mockResolvedValueOnce(tokenAnswer('at-2', 'rt-2'));
    expect(await service.getCredentialParams(config(auth))).toEqual({ access_token: 'at-2' });
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(stored().refreshToken).toBe('rt-2');
  });

  it('a token without a known lifetime is used until the gateway refuses it', async () => {
    const auth = { ...baseAuth, accessToken: 'at-forever', refreshToken: 'rt-1' };
    setRow(auth);
    expect(await service.getCredentialParams(config(auth))).toEqual({ access_token: 'at-forever' });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});
