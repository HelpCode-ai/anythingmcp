import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import {
  LoginTokenAuthConfig,
  LoginTokenService,
  extractResponseHeader,
} from './login-token.service';
import { injectLoginTokenHeaders } from './rest.engine';

jest.mock('axios');
const mockedAxios = axios as unknown as jest.Mock;
const { AxiosHeaders } = jest.requireActual('axios');

describe('extractResponseHeader helper', () => {
  it('reads a header by name', () => {
    expect(extractResponseHeader({ access_token: 'tok-1', expires_in: '900' }, 'access_token')).toBe('tok-1');
  });

  it('matches the name without regard to case, on either side', () => {
    expect(extractResponseHeader({ access_token: 'tok-1' }, 'Access_Token')).toBe('tok-1');
    expect(extractResponseHeader({ 'X-Auth-Token': 'tok-2' }, 'x-auth-token')).toBe('tok-2');
    expect(extractResponseHeader({ 'x-auth-token': 'tok-3' }, ' X-AUTH-TOKEN ')).toBe('tok-3');
  });

  it('reads the headers axios hands over', () => {
    const headers = new AxiosHeaders({ Access_Token: 'tok-4', 'Content-Length': '0' });
    expect(extractResponseHeader(headers, 'access_token')).toBe('tok-4');
  });

  it('drops surrounding white space and takes the first non-empty value of a repeated header', () => {
    expect(extractResponseHeader({ access_token: '  tok-5 ' }, 'access_token')).toBe('tok-5');
    expect(extractResponseHeader({ access_token: ['', ' tok-6', 'tok-7'] }, 'access_token')).toBe('tok-6');
  });

  it('returns null when the header is absent, empty or not text', () => {
    expect(extractResponseHeader({ expires_in: '900' }, 'access_token')).toBeNull();
    expect(extractResponseHeader({ access_token: '' }, 'access_token')).toBeNull();
    expect(extractResponseHeader({ access_token: '   ' }, 'access_token')).toBeNull();
    expect(extractResponseHeader({ access_token: 42 }, 'access_token')).toBeNull();
    expect(extractResponseHeader({ access_token: [] }, 'access_token')).toBeNull();
    expect(extractResponseHeader({}, 'access_token')).toBeNull();
    expect(extractResponseHeader(undefined, 'access_token')).toBeNull();
    expect(extractResponseHeader({ '': 'tok' }, '  ')).toBeNull();
  });
});

/**
 * tokenSource "header": the login answers the token in a response header.
 * Ceneo's GetToken does (headers access_token, expires_in, token_type; the
 * body is empty), with the API key sent as `Authorization: Basic <key>`.
 */
describe('LoginTokenService — tokenSource=header (Ceneo pattern)', () => {
  let service: LoginTokenService;
  const encryptionKey = 'test-encryption-key-32-chars!!!!';
  // Built at runtime so no literal looks like a real credential.
  const apiKey = ['F7869662', 'F334', '427C', '94B9', '0'.repeat(12)].join('-');
  const token = ['hdr', 't'.repeat(40)].join('-');

  const headerAuth: LoginTokenAuthConfig = {
    loginUrl: "https://developers.ceneo.pl/AuthorizationService.svc/GetToken?grantType='client_credentials'",
    loginMethod: 'GET',
    loginHeaders: { Authorization: `Basic ${apiKey}` },
    loginBody: {},
    username: apiKey,
    password: apiKey,
    tokenSource: 'header',
    tokenHeaderName: 'access_token',
    tokenTTLSeconds: 900,
    proactiveRefreshSeconds: 120,
  };

  beforeEach(() => {
    const prisma = {
      connectorAuthCache: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
    } as any;
    const config = { get: jest.fn().mockReturnValue(encryptionKey) } as unknown as ConfigService;
    service = new LoginTokenService(prisma, config);
    mockedAxios.mockReset();
  });

  it('takes the token from the response header and sends it as Bearer afterwards', async () => {
    mockedAxios.mockResolvedValue({
      status: 200,
      data: '',
      headers: { access_token: token, expires_in: '900', token_type: 'bearer' },
    });

    const bundle = await service.getToken(headerAuth, 'conn-ceneo');

    expect(bundle.token).toBe(token);
    expect(bundle.expiresAt).toBeGreaterThan(Date.now() + 890_000);
    expect(bundle.expiresAt).toBeLessThanOrEqual(Date.now() + 900_000);

    // The login itself: a GET with the key in the header and nothing else.
    const login = mockedAxios.mock.calls[0][0];
    expect(login.method).toBe('GET');
    expect(login.url).toBe(headerAuth.loginUrl);
    expect(login.headers.Authorization).toBe(`Basic ${apiKey}`);
    expect(login.params).toEqual({});
    expect(login.data).toBeUndefined();

    const request = { headers: {} as Record<string, string> };
    injectLoginTokenHeaders(request, headerAuth, bundle.token);
    expect(request.headers.Authorization).toBe(`Bearer ${token}`);

    // Cached: the next call does not log in again.
    await service.getToken(headerAuth, 'conn-ceneo');
    expect(mockedAxios).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Access_Token', { access_token: token }],
    ['access_token', { 'Access_Token': token }],
    ['ACCESS_TOKEN', new AxiosHeaders({ access_token: token })],
  ])('finds the header whatever the case (configured %s)', async (tokenHeaderName, headers) => {
    mockedAxios.mockResolvedValue({ status: 200, data: '', headers });
    const bundle = await service.getToken({ ...headerAuth, tokenHeaderName }, 'conn-case');
    expect(bundle.token).toBe(token);
  });

  it('needs no tokenJsonPath and ignores a token in the body', async () => {
    expect(headerAuth.tokenJsonPath).toBeUndefined();
    mockedAxios.mockResolvedValue({
      status: 200,
      data: { access_token: 'body-token' },
      headers: { access_token: token },
    });
    expect((await service.getToken(headerAuth, 'conn-body')).token).toBe(token);
  });

  it('fails when the header is missing, naming it and nothing of the answer', async () => {
    mockedAxios.mockResolvedValue({
      status: 200,
      data: { access_token: 'body-token' },
      headers: { expires_in: '900', 'set-cookie': 'session=cookie-value' },
    });

    const err = await service.getToken(headerAuth, 'conn-missing').catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('LOGIN_TOKEN: header "access_token" not found in the login response headers');
    expect(err.message).not.toMatch(/body-token|cookie-value/);
    expect(err.message).not.toContain(apiKey);
  });

  it('fails when the header is there but empty', async () => {
    mockedAxios.mockResolvedValue({ status: 200, data: '', headers: { access_token: '  ' } });
    await expect(service.getToken(headerAuth, 'conn-empty')).rejects.toThrow(
      'LOGIN_TOKEN: header "access_token" not found in the login response headers',
    );
  });

  it.each([[undefined], [''], ['   ']])('refuses tokenHeaderName %p before any request', async (tokenHeaderName) => {
    await expect(
      service.getToken({ ...headerAuth, tokenHeaderName } as LoginTokenAuthConfig, 'conn-unset'),
    ).rejects.toThrow('LOGIN_TOKEN: tokenSource=header requires "tokenHeaderName" to be set');
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  describe('the other token sources are untouched', () => {
    const bodyAuth: LoginTokenAuthConfig = {
      loginUrl: 'https://api.example.com/login',
      username: 'user',
      password: 'pass',
      tokenJsonPath: 'token',
      tokenTTLSeconds: 600,
    };

    it.each([[undefined], ['body' as const]])('tokenSource %p reads the body, not a header', async (tokenSource) => {
      mockedAxios.mockResolvedValue({
        data: { token: 'body-token' },
        headers: { access_token: token },
      });
      const bundle = await service.getToken(
        { ...bodyAuth, tokenSource, tokenHeaderName: 'access_token' } as LoginTokenAuthConfig,
        `conn-${tokenSource}`,
      );
      expect(bundle.token).toBe('body-token');
    });

    it('still names tokenJsonPath when the body holds no token, whatever the headers carry', async () => {
      mockedAxios.mockResolvedValue({ data: {}, headers: { access_token: token } });
      await expect(
        service.getToken({ ...bodyAuth, tokenHeaderName: 'access_token' } as LoginTokenAuthConfig, 'conn-default'),
      ).rejects.toThrow('LOGIN_TOKEN: token not found at "token" in login response');
    });

    it('still requires tokenJsonPath without a tokenSource', async () => {
      await expect(
        service.getToken({ ...bodyAuth, tokenJsonPath: undefined } as unknown as LoginTokenAuthConfig, 'conn-nopath'),
      ).rejects.toThrow('LOGIN_TOKEN: authConfig.tokenJsonPath is required');
      expect(mockedAxios).not.toHaveBeenCalled();
    });

    it('tokenSource cookie still reads Set-Cookie', async () => {
      mockedAxios.mockResolvedValue({
        data: {},
        headers: { 'set-cookie': 'B1SESSION=cookie-abc; Path=/', access_token: token },
      });
      const bundle = await service.getToken(
        { ...bodyAuth, tokenSource: 'cookie', cookieName: 'B1SESSION', tokenHeaderName: 'access_token' } as LoginTokenAuthConfig,
        'conn-cookie',
      );
      expect(bundle.token).toBe('cookie-abc');
    });
  });
});
