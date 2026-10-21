import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { BearerTokenRenewalService, withTokenRenewal } from './bearer-token-renewal.service';
import { credentialRef } from './connector-auth-status.service';
import { decrypt, encrypt } from '../../common/crypto/encryption.util';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const KEY = 'test-encryption-key-32-chars!!!!';
const DAY = 24 * 60 * 60 * 1000;
const APP_ID = '1234567890123456';
const APP_SECRET = 'abcdef0123456789abcdef0123456789';
const SHORT = 'EAAshortlivedtoken';
const LONG = 'EAAlonglivedtoken';

const spec = (extra: Record<string, unknown> = {}) => ({
  provider: 'meta',
  appIdVar: 'META_APP_ID',
  appSecretVar: 'META_APP_SECRET',
  graphVersion: 'v25.0',
  ...extra,
});
const withSecret = (token = SHORT) => ({
  token,
  tokenRenewal: { ...spec(), appId: APP_ID, appSecret: APP_SECRET },
});
const withoutSecret = (token = SHORT) => ({ token, tokenRenewal: spec() });

/** A Graph API error the way axios surfaces it. */
const graphError = (code: number, subcode?: number, status = 400) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { error: { message: 'Error validating access token', code, error_subcode: subcode } } },
    // What axios keeps on the error: the request, secrets included. Must never be logged.
    config: { params: { client_secret: APP_SECRET, fb_exchange_token: SHORT } },
  });

/** Routes the mocked axios.get by URL. */
function graph(routes: Record<string, (params: any) => any>) {
  mockedAxios.get.mockImplementation(async (url: string, opts?: any) => {
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) {
        const out = handler(opts?.params ?? {});
        if (out instanceof Error) throw out;
        return { data: out };
      }
    }
    throw new Error(`unexpected GET ${url}`);
  });
}

describe('BearerTokenRenewalService', () => {
  let cacheRow: any;
  let prisma: any;
  let authStatus: { mark: jest.Mock; clear: jest.Mock; setTokenExpiry: jest.Mock };
  let service: BearerTokenRenewalService;
  let logged: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    cacheRow = null;
    prisma = {
      connectorAuthCache: {
        findUnique: jest.fn(async () => cacheRow),
        upsert: jest.fn(async ({ create, update }: any) => {
          cacheRow = { ...(cacheRow ?? create), ...update };
          return cacheRow;
        }),
      },
    };
    authStatus = {
      mark: jest.fn(async () => undefined),
      clear: jest.fn(async () => undefined),
      setTokenExpiry: jest.fn(async () => undefined),
    };
    const config = { get: jest.fn().mockReturnValue(KEY) } as unknown as ConfigService;
    service = new BearerTokenRenewalService(prisma, config, authStatus as any);
    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('exchanges a pasted token with the right parameters and stores the long-lived one encrypted', async () => {
    graph({
      '/debug_token': () => ({ data: { expires_at: Math.floor((Date.now() + 3_600_000) / 1000), is_valid: true } }),
      '/oauth/access_token': () => ({ access_token: LONG, token_type: 'bearer', expires_in: 5_183_944 }),
    });

    expect(await service.getToken(withSecret(), 'conn-ig')).toBe(LONG);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://graph.facebook.com/v25.0/oauth/access_token',
      expect.objectContaining({
        params: {
          grant_type: 'fb_exchange_token',
          client_id: APP_ID,
          client_secret: APP_SECRET,
          fb_exchange_token: SHORT,
        },
      }),
    );
    expect(cacheRow.token).not.toContain(LONG);
    expect(decrypt(cacheRow.token, KEY)).toBe(LONG);
    expect(cacheRow.metadata).toMatchObject({ kind: 'bearer_renewal', sourceRef: credentialRef(SHORT) });
    expect(cacheRow.expiresAt.getTime()).toBeGreaterThan(Date.now() + 59 * DAY);
    expect(authStatus.setTokenExpiry).toHaveBeenCalledWith('conn-ig', expect.any(Date));

    // The next calls use the stored token without asking Meta.
    mockedAxios.get.mockClear();
    expect(await service.getToken(withSecret(), 'conn-ig')).toBe(LONG);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('renews the stored token when fewer than 10 days remain', async () => {
    cacheRow = {
      token: encrypt(LONG, KEY),
      expiresAt: new Date(Date.now() + 5 * DAY),
      metadata: { kind: 'bearer_renewal', sourceRef: credentialRef(SHORT), obtainedAt: Date.now() - 55 * DAY },
    };
    graph({ '/oauth/access_token': () => ({ access_token: 'EAArenewed', expires_in: 60 * 86400 }) });

    expect(await service.getToken(withSecret(), 'conn-renew')).toBe('EAArenewed');
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(mockedAxios.get.mock.calls[0][1]?.params).toMatchObject({ fb_exchange_token: LONG });
    expect(decrypt(cacheRow.token, KEY)).toBe('EAArenewed');
  });

  it('renews once for a burst of calls (single flight)', async () => {
    cacheRow = {
      token: encrypt(LONG, KEY),
      expiresAt: new Date(Date.now() + 2 * DAY),
      metadata: { kind: 'bearer_renewal', sourceRef: credentialRef(SHORT) },
    };
    graph({ '/oauth/access_token': () => ({ access_token: 'EAArenewed', expires_in: 60 * 86400 }) });
    const tokens = await Promise.all(Array.from({ length: 5 }, () => service.getToken(withSecret(), 'conn-burst')));
    expect(new Set(tokens)).toEqual(new Set(['EAArenewed']));
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('does not renew while more than 10 days remain', async () => {
    cacheRow = {
      token: encrypt(LONG, KEY),
      expiresAt: new Date(Date.now() + 30 * DAY),
      metadata: { kind: 'bearer_renewal', sourceRef: credentialRef(SHORT) },
    };
    expect(await service.getToken(withSecret(), 'conn-fresh')).toBe(LONG);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('keeps a token that never expires (System User, Page) as it is', async () => {
    graph({ '/debug_token': () => ({ data: { expires_at: 0, is_valid: true } }) });
    expect(await service.getToken(withSecret('EAAsystemuser'), 'conn-su')).toBe('EAAsystemuser');
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(authStatus.setTokenExpiry).toHaveBeenCalledWith('conn-su', null);
    expect(authStatus.mark).not.toHaveBeenCalled();
  });

  it('takes a Page token from the exchanged user token when the adapter names the Page', async () => {
    graph({
      '/debug_token': () => ({ data: { expires_at: Math.floor((Date.now() + 3_600_000) / 1000) } }),
      '/oauth/access_token': () => ({ access_token: LONG, expires_in: 5_183_944 }),
      '/104512345678901': (params) => (params.access_token === LONG ? { access_token: 'EAApagetoken', id: '104512345678901' } : new Error('wrong token')),
    });
    const cfg = { token: SHORT, tokenRenewal: { ...spec({ pageIdVar: 'FACEBOOK_PAGE_ID', graphVersion: 'v26.0' }), appId: APP_ID, appSecret: APP_SECRET, pageId: '104512345678901' } };
    expect(await service.getToken(cfg, 'conn-page')).toBe('EAApagetoken');
    expect(cacheRow.metadata.neverExpires).toBe(true);
  });

  it('without the app secret: reads the expiry with the token itself and warns about a short-lived token', async () => {
    graph({ '/debug_token': (params) => ({ data: { expires_at: Math.floor((Date.now() + 3_600_000) / 1000), access: params.access_token } }) });

    expect(await service.getToken(withoutSecret(), 'conn-short')).toBe(SHORT);
    expect(mockedAxios.get.mock.calls[0][1]?.params).toEqual({ input_token: SHORT, access_token: SHORT });
    expect(authStatus.mark).toHaveBeenCalledWith('conn-short', {
      status: 'expiring',
      code: 'meta_expiring',
      message: expect.stringMatching(/short-lived token.*META_APP_ID and META_APP_SECRET.*long-lived token/),
      ref: credentialRef(SHORT),
    });
    // Said once, not on every call.
    await service.getToken(withoutSecret(), 'conn-short');
    expect(authStatus.mark).toHaveBeenCalledTimes(1);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('once a short-lived token has expired, marks the connector as needing a new token instead of warning', async () => {
    const expiresAt = Date.now() + 3_600_000;
    graph({ '/debug_token': () => ({ data: { expires_at: Math.floor(expiresAt / 1000) } }) });
    expect(await service.getToken(withoutSecret(), 'conn-lapsed')).toBe(SHORT);
    expect(authStatus.mark).toHaveBeenLastCalledWith(
      'conn-lapsed',
      expect.objectContaining({ status: 'expiring', code: 'meta_expiring' }),
    );

    // Two hours later, nobody has pasted a new token.
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 2 * 3_600_000);
    // The call still goes out: Meta's answer has the last word.
    expect(await service.getToken(withoutSecret(), 'conn-lapsed')).toBe(SHORT);
    expect(authStatus.mark).toHaveBeenLastCalledWith('conn-lapsed', {
      status: 'needs_reauth',
      code: 'token_expired',
      message: expect.stringMatching(/expired on .* UTC and could not be renewed.*Paste a new token/),
      ref: credentialRef(SHORT),
    });
    await service.getToken(withoutSecret(), 'conn-lapsed');
    expect(authStatus.mark).toHaveBeenCalledTimes(2);
  });

  it('records a refused exchange as a warning and keeps using the pasted token', async () => {
    graph({
      '/debug_token': () => graphError(190, undefined, 400),
      '/oauth/access_token': () => graphError(101, undefined, 400),
    });
    expect(await service.getToken(withSecret(), 'conn-badsecret')).toBe(SHORT);
    expect(authStatus.mark).toHaveBeenCalledWith(
      'conn-badsecret',
      expect.objectContaining({ status: 'expiring', code: 'renewal_failed' }),
    );
  });

  it('on 190/467 marks the connector, then fails fast until a new token is pasted', async () => {
    const hint = await service.onRejected(withoutSecret(), 'conn-467', graphError(190, 467, 401));
    expect(hint).toMatch(/logged out.*Paste a new token/);
    expect(authStatus.mark).toHaveBeenCalledWith('conn-467', {
      status: 'needs_reauth',
      code: 'meta_logged_out',
      message: hint,
      ref: credentialRef(SHORT),
    });

    await expect(service.getToken(withoutSecret(), 'conn-467')).rejects.toMatchObject({ status: 401, hint });
    expect(mockedAxios.get).not.toHaveBeenCalled();

    // A different token: no longer blocked.
    graph({ '/debug_token': () => ({ data: { expires_at: 0 } }) });
    expect(await service.getToken(withoutSecret('EAAnewtoken'), 'conn-467')).toBe('EAAnewtoken');
    expect(authStatus.clear).toHaveBeenCalledWith('conn-467');
  });

  it('maps the other final 190 subcodes, and ignores errors that are not about the token', async () => {
    expect(await service.onRejected(withoutSecret(), 'c', graphError(190, 460))).toMatch(/password/);
    expect(authStatus.mark).toHaveBeenLastCalledWith('c', expect.objectContaining({ code: 'meta_password_changed' }));
    expect(await service.onRejected(withoutSecret(), 'c', graphError(190, 463))).toMatch(/expired/);
    expect(authStatus.mark).toHaveBeenLastCalledWith('c', expect.objectContaining({ code: 'meta_token_expired' }));
    authStatus.mark.mockClear();
    expect(await service.onRejected(withoutSecret(), 'c', graphError(4))).toBeUndefined(); // rate limit
    expect(await service.onRejected(withoutSecret(), 'c', graphError(100))).toBeUndefined();
    expect(await service.onRejected({ token: SHORT }, 'c', graphError(190, 467))).toBeUndefined(); // no renewal spec
    expect(authStatus.mark).not.toHaveBeenCalled();
  });

  it('passes the token through unchanged without a renewal spec or a saved connector', async () => {
    expect(await service.getToken({ token: 'plain' }, 'conn-x')).toBe('plain');
    expect(await service.getToken(withSecret(), undefined)).toBe(SHORT);
    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(prisma.connectorAuthCache.findUnique).not.toHaveBeenCalled();
  });

  it('never logs a token or the app secret', async () => {
    graph({
      '/debug_token': () => graphError(190, undefined),
      '/oauth/access_token': () => graphError(190, 463),
    });
    await service.getToken(withSecret(), 'conn-log');
    await service.onRejected(withSecret(), 'conn-log', graphError(190, 467));
    graph({
      '/debug_token': () => ({ data: { expires_at: Math.floor((Date.now() + 3_600_000) / 1000) } }),
      '/oauth/access_token': () => ({ access_token: LONG, expires_in: 5_183_944 }),
    });
    await service.getToken(withSecret('EAAanothershort'), 'conn-log');

    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      for (const secret of [APP_SECRET, SHORT, LONG, 'EAAanothershort']) expect(line).not.toContain(secret);
    }
  });

  it('refreshes Instagram Login tokens without an app secret', async () => {
    cacheRow = {
      token: encrypt('IGQlong', KEY),
      expiresAt: new Date(Date.now() + 3 * DAY),
      metadata: { kind: 'bearer_renewal', sourceRef: credentialRef('IGQpasted'), obtainedAt: Date.now() - 57 * DAY },
    };
    graph({ '/refresh_access_token': (params) => (params.grant_type === 'ig_refresh_token' && params.access_token === 'IGQlong' ? { access_token: 'IGQnew', expires_in: 5_184_000 } : new Error('bad')) });
    const cfg = { token: 'IGQpasted', tokenRenewal: { provider: 'instagram_login' } };
    expect(await service.getToken(cfg, 'conn-igl')).toBe('IGQnew');
    expect(mockedAxios.get).toHaveBeenCalledWith('https://graph.instagram.com/refresh_access_token', expect.anything());
  });
});

describe('withTokenRenewal', () => {
  it('takes the spec from the catalog for connectors installed before the adapter declared it', () => {
    const out = withTokenRenewal('BEARER_TOKEN', { token: SHORT }, { adapterSlug: 'instagram' }, {
      META_APP_ID: APP_ID,
      META_APP_SECRET: APP_SECRET,
    });
    expect(out?.tokenRenewal).toMatchObject({ provider: 'meta', appId: APP_ID, appSecret: APP_SECRET });
  });

  it('leaves unset or placeholder variables empty, and other auth types alone', () => {
    const out = withTokenRenewal('BEARER_TOKEN', { token: SHORT, tokenRenewal: spec() }, null, {
      META_APP_ID: '{{META_APP_ID}}',
    });
    expect(out?.tokenRenewal).toMatchObject({ appId: undefined, appSecret: undefined });
    const plain = { token: 'x' };
    expect(withTokenRenewal('BEARER_TOKEN', plain, { adapterSlug: 'github' }, {})).toBe(plain);
    const oauth = { accessToken: 'x' };
    expect(withTokenRenewal('OAUTH2', oauth, { adapterSlug: 'instagram' }, {})).toBe(oauth);
  });
});
