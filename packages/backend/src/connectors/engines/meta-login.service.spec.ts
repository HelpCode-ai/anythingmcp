import { Logger } from '@nestjs/common';
import axios from 'axios';
import { MetaLoginError, MetaLoginService } from './meta-login.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const APP = { appId: '1234567890', appSecret: 'abcdef0123456789abcdef0123456789' };
const REDIRECT = 'https://cloud.anythingmcp.com/api/meta/callback';

describe('MetaLoginService', () => {
  let service: MetaLoginService;
  let logged: string[];

  beforeEach(() => {
    jest.resetAllMocks();
    service = new MetaLoginService();
    logged = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  describe('Unified Login', () => {
    const UNIFIED = { ...APP, configId: '2539939149839675' };

    it('exchanges the code once, never for a long-lived token, and lists the shared accounts', async () => {
      const calls: Array<{ url: string; params: any }> = [];
      mockedAxios.get.mockImplementation(async (url: string, opts?: any) => {
        calls.push({ url, params: opts?.params });
        if (url === 'https://graph.facebook.com/v27.0/oauth/access_token') {
          expect(opts.params).toEqual({ client_id: APP.appId, client_secret: APP.appSecret, redirect_uri: REDIRECT, code: 'CODE' });
          return { data: { access_token: 'BISU', token_type: 'bearer' } };
        }
        if (url === 'https://graph.facebook.com/v27.0/me/assigned_instagram_accounts') {
          expect(opts.headers.Authorization).toBe('Bearer BISU');
          if (!opts.params.after) {
            return {
              data: {
                data: [{ id: '17841400000000001', username: 'shop' }],
                paging: { cursors: { after: 'CUR' }, next: 'https://graph.facebook.com/v27.0/me/assigned_instagram_accounts?access_token=X&after=CUR' },
              },
            };
          }
          return { data: { data: [{ id: '17841400000000002' }, { id: 'not-an-id' }] } };
        }
        throw new Error(`unexpected ${url}`);
      });
      const out = await service.exchangeCode({ flavour: 'facebook', app: UNIFIED, code: 'CODE#_', redirectUri: REDIRECT });
      expect(out).toEqual({
        token: 'BISU',
        expiresAt: null,
        systemUser: true,
        accounts: [{ id: '17841400000000001', username: 'shop' }, { id: '17841400000000002' }],
      });
      expect(calls.some((c) => c.params?.grant_type === 'fb_exchange_token')).toBe(false);
      expect(calls[2].params).toEqual({ fields: 'id,username', limit: '100', after: 'CUR' });
      expect(logged.join('\n')).not.toContain('BISU');
    });

    it('keeps an expiry the configuration sets, and lists accounts for a stored token', async () => {
      mockedAxios.get.mockImplementation(async (url: string) => {
        if (url.endsWith('/oauth/access_token')) return { data: { access_token: 'BISU', expires_in: 5_184_000 } };
        return { data: { data: [{ id: '17841400000000009', username: 'x' }] } };
      });
      const out = await service.exchangeCode({ flavour: 'facebook', app: UNIFIED, code: 'C', redirectUri: REDIRECT });
      expect(out.expiresAt).toBeGreaterThan(Date.now());
      expect(await service.unifiedAccounts('BISU')).toEqual([{ id: '17841400000000009', username: 'x' }]);
    });

    it('fails clearly when Meta answers without a token', async () => {
      mockedAxios.get.mockResolvedValue({ data: {} });
      await expect(
        service.exchangeCode({ flavour: 'facebook', app: UNIFIED, code: 'C', redirectUri: REDIRECT }),
      ).rejects.toThrow(/without an access token/);
    });
  });

  describe('Facebook Login', () => {
    it('exchanges the code, then for a long-lived token, and lists the linked Instagram accounts', async () => {
      mockedAxios.get.mockImplementation(async (url: string, opts?: any) => {
        if (url === 'https://graph.facebook.com/v25.0/oauth/access_token' && opts.params.code === 'CODE') {
          expect(opts.params).toEqual({ client_id: APP.appId, client_secret: APP.appSecret, redirect_uri: REDIRECT, code: 'CODE' });
          return { data: { access_token: 'EAAshort', expires_in: 5000 } };
        }
        if (url === 'https://graph.facebook.com/v25.0/oauth/access_token') {
          expect(opts.params).toMatchObject({ grant_type: 'fb_exchange_token', fb_exchange_token: 'EAAshort' });
          return { data: { access_token: 'EAAlong', expires_in: 5_184_000 } };
        }
        if (url === 'https://graph.facebook.com/v25.0/me/accounts') {
          expect(opts.headers.Authorization).toBe('Bearer EAAlong');
          return {
            data: {
              data: [
                { id: 'p1', name: 'Shop Page', instagram_business_account: { id: '17841400000000001', username: 'shop' } },
                { id: 'p2', name: 'No IG Page' },
              ],
            },
          };
        }
        throw new Error(`unexpected ${url}`);
      });
      const before = Date.now();
      const out = await service.exchangeCode({ flavour: 'facebook', app: APP, code: 'CODE', redirectUri: REDIRECT });
      expect(out.token).toBe('EAAlong');
      expect(out.expiresAt).toBeGreaterThanOrEqual(before + 5_184_000 * 1000);
      expect(out.accounts).toEqual([{ id: '17841400000000001', username: 'shop', pageName: 'Shop Page' }]);
    });

    it('follows the next page without putting the token in the address', async () => {
      const calls: Array<{ url: string; params: any }> = [];
      mockedAxios.get.mockImplementation(async (url: string, opts?: any) => {
        calls.push({ url, params: opts?.params });
        if (calls.length === 1) {
          return {
            data: {
              data: [{ name: 'A', instagram_business_account: { id: '17841400000000011' } }],
              paging: { next: 'https://graph.facebook.com/v25.0/me/accounts?access_token=SECRET&after=CUR&limit=100' },
            },
          };
        }
        return { data: { data: [{ name: 'B', instagram_business_account: { id: '17841400000000022' } }] } };
      });
      const accounts = await service.facebookAccounts('EAAlong');
      expect(accounts.map((a) => a.id)).toEqual(['17841400000000011', '17841400000000022']);
      expect(calls[1].url).toBe('https://graph.facebook.com/v25.0/me/accounts');
      expect(calls[1].params).toEqual({ after: 'CUR', limit: '100' });
    });

    it("says what Meta said, never the secret or the code", async () => {
      mockedAxios.get.mockRejectedValue(
        Object.assign(new Error('Request failed with status code 400'), {
          response: { status: 400, data: { error: { message: 'Invalid verification code format.', code: 100 } } },
          config: { params: { client_secret: APP.appSecret, code: 'CODE' } },
        }),
      );
      const err = await service
        .exchangeCode({ flavour: 'facebook', app: APP, code: 'CODE', redirectUri: REDIRECT })
        .catch((e) => e);
      expect(err).toBeInstanceOf(MetaLoginError);
      expect(err.status).toBe(400);
      expect(err.message).toBe('HTTP 400 (code 100): Invalid verification code format.');
      expect(err.message).not.toContain(APP.appSecret);
    });
  });

  describe('Instagram Login', () => {
    it('exchanges the code (form POST, #_ stripped), then ig_exchange_token, and reads the account from /me', async () => {
      mockedAxios.post.mockImplementation(async (url: string, body: any, opts?: any) => {
        expect(url).toBe('https://api.instagram.com/oauth/access_token');
        expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
        expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
          client_id: APP.appId,
          client_secret: APP.appSecret,
          grant_type: 'authorization_code',
          redirect_uri: REDIRECT,
          code: 'AQBcode',
        });
        return { data: { data: [{ access_token: 'IGshort', user_id: '1020', permissions: 'instagram_business_basic' }] } };
      });
      mockedAxios.get.mockImplementation(async (url: string, opts?: any) => {
        if (url === 'https://graph.instagram.com/access_token') {
          expect(opts.params).toEqual({ grant_type: 'ig_exchange_token', client_secret: APP.appSecret, access_token: 'IGshort' });
          return { data: { access_token: 'IGlong', token_type: 'bearer', expires_in: 5_183_944 } };
        }
        if (url === 'https://graph.instagram.com/v25.0/me') {
          expect(opts.headers.Authorization).toBe('Bearer IGlong');
          return { data: { user_id: '17841400000000099', username: 'creator' } };
        }
        throw new Error(`unexpected ${url}`);
      });
      const out = await service.exchangeCode({ flavour: 'instagram', app: APP, code: 'AQBcode#_', redirectUri: REDIRECT });
      expect(out.token).toBe('IGlong');
      expect(out.accounts).toEqual([{ id: '17841400000000099', username: 'creator' }]);
    });

    it('accepts the flat answer of the code exchange too', async () => {
      mockedAxios.post.mockResolvedValue({ data: { access_token: 'IGshort', user_id: 1020 } });
      mockedAxios.get.mockImplementation(async (url: string) =>
        url.endsWith('/access_token')
          ? { data: { access_token: 'IGlong', expires_in: 100 } }
          : { data: { user_id: '17841400000000098' } },
      );
      const out = await service.exchangeCode({ flavour: 'instagram', app: APP, code: 'c', redirectUri: REDIRECT });
      expect(out.accounts).toEqual([{ id: '17841400000000098' }]);
    });

    it("reports Instagram's own error format", async () => {
      mockedAxios.post.mockRejectedValue(
        Object.assign(new Error('400'), {
          response: {
            status: 400,
            data: { error_type: 'OAuthException', code: 400, error_message: 'Matching code was not found or was already used' },
          },
        }),
      );
      const err = await service.exchangeCode({ flavour: 'instagram', app: APP, code: 'c', redirectUri: REDIRECT }).catch((e) => e);
      expect(err.message).toBe('HTTP 400: Matching code was not found or was already used');
      for (const line of logged) expect(line).not.toContain(APP.appSecret);
    });
  });
});
