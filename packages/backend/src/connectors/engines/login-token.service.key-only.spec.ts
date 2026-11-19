import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import {
  LoginTokenService,
  LoginTokenAuthConfig,
  isLoginRequestError,
  isWholeBodyPath,
  labelLoginRequestError,
  loginBodyExcerpt,
  loginCredentialNeeds,
  readTokenAt,
  tokenJsonPaths,
} from './login-token.service';

/**
 * Login → Token for key-only token exchanges that answer with a plain-text
 * token (an API key in a login header, the token as the whole body):
 *
 *  - an empty, absent or "." tokenJsonPath reads the whole body, trimmed;
 *  - username and password are needed only when the login uses them;
 *  - loginHeaders take the login placeholders;
 *  - a failed login says it was the login, with the status and an excerpt
 *    of the answer, and never the credentials.
 */

jest.mock('axios');
const mockedAxios = axios as unknown as jest.Mock;

const KEY = ['k', 'e', 'y', '-'].join('') + 'x'.repeat(12);

const keyOnly: LoginTokenAuthConfig = {
  loginUrl: 'https://api.example.com/oauth/token',
  loginMethod: 'POST',
  loginHeaders: { 'X-Api-Key': KEY },
  loginBody: {},
  tokenJsonPath: '',
  tokenTTLSeconds: 3600,
};

function newService() {
  const prisma = {
    connectorAuthCache: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const config = { get: jest.fn().mockReturnValue('test-encryption-key-32-chars-ok!') } as unknown as ConfigService;
  return { service: new LoginTokenService(prisma as never, config), prisma };
}

const sent = (i = 0) => mockedAxios.mock.calls[i][0];

beforeEach(() => {
  mockedAxios.mockReset();
});

describe('tokenJsonPath: the whole response body', () => {
  it.each([[undefined], [null], [''], ['   '], ['.'], [[]], [['']]])('reads %p as the whole body', (value) => {
    expect(tokenJsonPaths(value)).toEqual(['.']);
  });

  it('keeps an explicit path, trimmed, and a list in order', () => {
    expect(tokenJsonPaths(' token ')).toEqual(['token']);
    expect(tokenJsonPaths(['data.token', ''])).toEqual(['data.token', '.']);
  });

  it('refuses a non-string entry', () => {
    expect(() => tokenJsonPaths(['token', 5])).toThrow(/must be a path, or a list of paths/);
  });

  it('knows whole-body paths', () => {
    expect(isWholeBodyPath('')).toBe(true);
    expect(isWholeBodyPath('.')).toBe(true);
    expect(isWholeBodyPath('token')).toBe(false);
  });

  it('trims a plain-text body, unwraps a JSON string, and refuses an object', () => {
    expect(readTokenAt('  abc.def\n', ['.'])).toBe('abc.def');
    expect(readTokenAt('"abc"', ['.'])).toBe('abc');
    expect(readTokenAt(12345, ['.'])).toBe('12345');
    expect(readTokenAt({ token: 'x' }, ['.'])).toBeUndefined();
    expect(readTokenAt('   ', ['.'])).toBeUndefined();
  });

  it('logs in and keeps a plain-text answer as the token with an empty path', async () => {
    const { service } = newService();
    mockedAxios.mockResolvedValue({ status: 200, data: '  plain-token-1\r\n', headers: { 'content-type': 'text/plain' } });
    const bundle = await service.getToken(keyOnly, 'conn-plain');
    expect(bundle.token).toBe('plain-token-1');
  });

  it('does the same with "." and with a JSON string answer', async () => {
    const { service } = newService();
    mockedAxios.mockResolvedValue({ status: 200, data: '"quoted-token"', headers: {} });
    const bundle = await service.getToken({ ...keyOnly, tokenJsonPath: '.' }, 'conn-dot');
    expect(bundle.token).toBe('quoted-token');
  });

  it('keeps "token" when it is set explicitly', async () => {
    const { service } = newService();
    mockedAxios.mockResolvedValue({ status: 200, data: { token: 'json-token' }, headers: {} });
    const bundle = await service.getToken({ ...keyOnly, tokenJsonPath: 'token' }, 'conn-json');
    expect(bundle.token).toBe('json-token');
  });

  it('says the body is a JSON object when an empty path meets one', async () => {
    const { service } = newService();
    mockedAxios.mockResolvedValue({ status: 200, data: { access: 'x' }, headers: {} });
    await expect(service.getToken(keyOnly, 'conn-obj')).rejects.toThrow(
      /the login response body is a JSON object, not a plain-text token\. Set tokenJsonPath/,
    );
  });
});

describe('key-only token exchange: username and password are optional', () => {
  it('logs in without username and password when nothing uses them', async () => {
    const { service } = newService();
    mockedAxios.mockResolvedValue({ status: 200, data: 'tok', headers: {} });
    await service.getToken(keyOnly, 'conn-key');
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    expect(sent().headers['X-Api-Key']).toBe(KEY);
    expect(sent().data).toEqual({});
  });

  it('sends the login headers on the login request, with the login placeholders filled in', async () => {
    const { service } = newService();
    mockedAxios.mockResolvedValue({ status: 200, data: 'tok', headers: {} });
    await service.getToken(
      {
        ...keyOnly,
        password: KEY,
        loginHeaders: { Authorization: 'Key ${password}', 'X-Request-Id': '${uuid}', 'X-Other': '${unknown}' },
      },
      'conn-hdr',
    );
    expect(sent().headers.Authorization).toBe(`Key ${KEY}`);
    expect(sent().headers['X-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
    // An unknown placeholder stays as written.
    expect(sent().headers['X-Other']).toBe('${unknown}');
  });

  it('asks for the password when a login header uses it and none is set', async () => {
    const { service } = newService();
    await expect(
      service.getToken({ ...keyOnly, loginHeaders: { Authorization: 'Key ${password}' } }, 'conn-nopw'),
    ).rejects.toThrow('LOGIN_TOKEN: authConfig.password is required');
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('asks for the username when the body uses it', async () => {
    const { service } = newService();
    await expect(
      service.getToken({ ...keyOnly, loginBody: { user: '${username}' } }, 'conn-nouser'),
    ).rejects.toThrow('LOGIN_TOKEN: authConfig.username is required');
  });

  it('still asks for both without a login body (the default body is the credentials)', async () => {
    const { service } = newService();
    const { loginBody: _b, ...noBody } = keyOnly;
    await expect(service.getToken(noBody, 'conn-nobody')).rejects.toThrow('LOGIN_TOKEN: authConfig.username is required');
  });

  it('fetches no salt when the login does not use the password', async () => {
    const { service } = newService();
    mockedAxios.mockResolvedValue({ status: 200, data: 'tok', headers: {} });
    await service.getToken(
      {
        ...keyOnly,
        passwordHashing: { scheme: 'bcrypt', saltSource: { type: 'fetch', url: 'https://api.example.com/salt/${username}' } },
      },
      'conn-nosalt',
    );
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    expect(sent().url).toBe(keyOnly.loginUrl);
  });

  it('works out which credentials a login uses', () => {
    expect(loginCredentialNeeds(keyOnly)).toEqual({ username: false, password: false });
    expect(loginCredentialNeeds({ ...keyOnly, loginBodyTemplate: '{"p":"${passwordHashed}"}', loginBody: undefined })).toEqual({
      username: false,
      password: true,
    });
    expect(
      loginCredentialNeeds({
        ...keyOnly,
        loginBody: { p: '${hashed}' },
        passwordHashing: { scheme: 'bcrypt', outputParam: 'hashed', saltSource: { type: 'fetch', url: 'https://x/${username}' } },
      }),
    ).toEqual({ username: true, password: true });
    expect(loginCredentialNeeds({ ...keyOnly, loginBasicAuth: true })).toEqual({ username: true, password: true });
    expect(loginCredentialNeeds({ ...keyOnly, signedJwt: { privateKey: 'k' } })).toEqual({ username: false, password: false });
  });
});

describe('a failed login request is labelled as the login', () => {
  const httpFailure = (status: number, statusText: string, data: unknown) =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
      isAxiosError: true,
      code: 'ERR_BAD_REQUEST',
      response: { status, statusText, data, headers: {} },
    });

  it('names the login, the status and an excerpt of the answer, without the key', async () => {
    const { service } = newService();
    mockedAxios.mockRejectedValue(httpFailure(401, 'Unauthorized', { error: 'invalid key', echo: KEY }));
    const err: any = await service.getToken(keyOnly, 'conn-401', { connectorHeaders: ['Authorization', 'X-Api-Key'] }).catch((e) => e);
    expect(err.message).toBe(
      'LOGIN_TOKEN: login request failed (HTTP 401 Unauthorized): {"error":"invalid key","echo":"[redacted]"}',
    );
    expect(err.message).not.toContain(KEY);
    // Still the axios error: callers classify by its status.
    expect(err.response.status).toBe(401);
    expect(isLoginRequestError(err)).toBe(true);
    expect(err.hint).toMatch(/the tool itself was not called/);
    expect(err.hint).toMatch(/refused the login \(HTTP 401\)/);
    // X-Api-Key is a login header, so only Authorization is named as not sent.
    expect(err.hint).toContain('Connector headers (Authorization) are not sent with the login request');
  });

  it('labels a network failure with its code and keeps the original text', async () => {
    const { service } = newService();
    mockedAxios.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), { code: 'ENOTFOUND', isAxiosError: true }));
    const err: any = await service.getToken(keyOnly, 'conn-dns').catch((e) => e);
    expect(err.message).toBe('LOGIN_TOKEN: login request failed (ENOTFOUND): getaddrinfo ENOTFOUND api.example.com');
    expect(err.hint).toMatch(/could not be reached/);
  });

  it('labels an error once', () => {
    const err = httpFailure(404, 'Not Found', '<html><body><h1>Not found</h1></body></html>');
    labelLoginRequestError(err);
    labelLoginRequestError(err);
    expect(err.message).toBe('LOGIN_TOKEN: login request failed (HTTP 404 Not Found): Not found');
  });

  it('cuts a long excerpt and redacts the value behind a Bearer prefix', () => {
    expect(loginBodyExcerpt('x'.repeat(400)).length).toBe(301);
    expect(loginBodyExcerpt(`got ${KEY} back`, [`Bearer ${KEY}`])).toBe('got [redacted] back');
  });
});

describe('forget', () => {
  it('drops the cached token so the next call logs in again', async () => {
    const { service, prisma } = newService();
    mockedAxios.mockResolvedValue({ status: 200, data: 'tok-1', headers: {} });
    await service.getToken(keyOnly, 'conn-forget');
    await service.forget('conn-forget');
    expect(prisma.connectorAuthCache.deleteMany).toHaveBeenCalledWith({ where: { connectorId: 'conn-forget' } });
    mockedAxios.mockResolvedValue({ status: 200, data: 'tok-2', headers: {} });
    expect((await service.getToken(keyOnly, 'conn-forget')).token).toBe('tok-2');
  });
});
