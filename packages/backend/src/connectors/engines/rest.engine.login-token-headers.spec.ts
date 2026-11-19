import axios, { AxiosError } from 'axios';
import { Logger } from '@nestjs/common';
import {
  RestEngine,
  injectLoginTokenHeaders,
  loginTokenHeaderCollision,
  withLoginHeaderCollisionHint,
} from './rest.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import { LoginTokenService, labelLoginRequestError } from './login-token.service';

/**
 * Login → Token and the connector's own headers:
 *
 *  - connector headers are not sent with the login (only loginHeaders are);
 *    their names go to the login so a failed login can say so;
 *  - the token header replaces a connector header of the same name, as it
 *    always did, now with a warning (once) and a hint on a refused call;
 *  - a failed login reaches the caller labelled, and no tool call is sent.
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return {
    __esModule: true,
    default: jest.fn(),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock;

const BASE = 'https://api.example.test';

const loginStub = () => {
  const service = {
    getToken: jest.fn().mockResolvedValue({ token: 'tok-1', expiresAt: Date.now() + 600_000 }),
    forceRelogin: jest.fn().mockResolvedValue({ token: 'tok-2', expiresAt: Date.now() + 600_000 }),
  };
  return service as unknown as LoginTokenService & typeof service;
};
const httpError = (status: number, data: unknown = {}) => {
  const response = { status, data, headers: {}, statusText: '', config: {} as never };
  return new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', undefined, undefined, response as never);
};
const config = (headers: Record<string, string>, authConfig: Record<string, unknown> = {}) => ({
  baseUrl: BASE,
  authType: 'LOGIN_TOKEN',
  authConfig: { loginUrl: `${BASE}/login`, loginBody: {}, tokenJsonPath: '', ...authConfig },
  headers,
  connectorId: 'conn-1',
});
const mapping = { method: 'GET', path: '/items' };
const sentAt = (index: number) => mockedAxios.mock.calls[index][0];
const caught = (call: Promise<unknown>): Promise<any> =>
  call.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (error) => error,
  );

let warn: jest.SpyInstance;
beforeEach(() => {
  mockedAxios.mockReset();
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('RestEngine: Login → Token and connector headers', () => {
  it('tells the login the connector header names, and sends the token on the call', async () => {
    const login = loginStub();
    mockedAxios.mockResolvedValue({ status: 200, data: '{"ok":true}', headers: { 'content-type': 'application/json' } });
    await new RestEngine({} as OAuth2TokenService, login).execute(config({ 'X-Tenant': 't1' }), mapping, {});
    expect(login.getToken).toHaveBeenCalledWith(expect.anything(), 'conn-1', {
      proxyUrl: undefined,
      connectorHeaders: ['X-Tenant'],
    });
    expect(sentAt(0).headers.Authorization).toBe('Bearer tok-1');
    expect(sentAt(0).headers['X-Tenant']).toBe('t1');
  });

  it('replaces a connector header with the token header and warns once per connector', async () => {
    const login = loginStub();
    mockedAxios.mockResolvedValue({ status: 200, data: '{}', headers: { 'content-type': 'application/json' } });
    const engine = new RestEngine({} as OAuth2TokenService, login);
    await engine.execute(config({ authorization: 'Basic abc' }), mapping, {});
    await engine.execute(config({ authorization: 'Basic abc' }), mapping, {});
    expect(sentAt(0).headers.Authorization).toBe('Bearer tok-1');
    expect(sentAt(0).headers.authorization).toBeUndefined();
    const collisions = warn.mock.calls.filter(([m]) => String(m).includes('which the login token header replaces'));
    expect(collisions).toHaveLength(1);
    expect(String(collisions[0][0])).toContain('"authorization"');
  });

  it('does not warn when the token travels in another header', async () => {
    const login = loginStub();
    mockedAxios.mockResolvedValue({ status: 200, data: '{}', headers: { 'content-type': 'application/json' } });
    await new RestEngine({} as OAuth2TokenService, login).execute(
      config({ Authorization: 'Basic abc' }, { headerName: 'X-Session', headerTemplate: '${token}' }),
      mapping,
      {},
    );
    expect(sentAt(0).headers.Authorization).toBe('Basic abc');
    expect(sentAt(0).headers['X-Session']).toBe('tok-1');
    expect(warn.mock.calls.some(([m]) => String(m).includes('login token header replaces'))).toBe(false);
  });

  it('adds a hint to a refused call when the token header replaced a connector header', async () => {
    const login = loginStub();
    mockedAxios.mockRejectedValue(httpError(401, { message: 'missing api key' }));
    const err = await caught(
      new RestEngine({} as OAuth2TokenService, login).execute(
        config({ Authorization: 'Basic abc' }, { refreshOn401: false }),
        mapping,
        {},
      ),
    );
    expect(err.response.status).toBe(401);
    expect(err.hint).toContain('The connector sets a "Authorization" header, and the Login → Token header');
  });

  it('adds no hint without a collision', async () => {
    const login = loginStub();
    mockedAxios.mockRejectedValue(httpError(401));
    const err = await caught(
      new RestEngine({} as OAuth2TokenService, login).execute(config({ 'X-Tenant': 't1' }, { refreshOn401: false }), mapping, {}),
    );
    expect(err.hint).toBeUndefined();
  });

  it('passes a failed login on, labelled, without sending the tool call', async () => {
    const login = loginStub();
    const failure = labelLoginRequestError(httpError(403, 'forbidden'), { connectorHeaders: ['X-Tenant'] });
    login.getToken.mockRejectedValue(failure);
    const err = await caught(new RestEngine({} as OAuth2TokenService, login).execute(config({ 'X-Tenant': 't1' }), mapping, {}));
    expect(err.message).toBe('LOGIN_TOKEN: login request failed (HTTP 403): forbidden');
    expect(err.hint).toContain('Connector headers (X-Tenant) are not sent with the login request');
    expect(mockedAxios).not.toHaveBeenCalled();
  });
});

describe('injectLoginTokenHeaders and the collision helpers', () => {
  it('reports the replaced header, in any spelling, and none with tokenPlacement body', () => {
    const request = { headers: { AUTHORIZATION: 'x', Accept: 'application/json' } };
    expect(injectLoginTokenHeaders(request, { loginUrl: 'u' }, 't')).toBe('AUTHORIZATION');
    expect(request.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer t' });
    expect(loginTokenHeaderCollision({ Authorization: 'x' }, { loginUrl: 'u', tokenPlacement: 'body' })).toBeUndefined();
    expect(loginTokenHeaderCollision({ 'X-Key': 'x' }, { loginUrl: 'u' })).toBeUndefined();
  });

  it('keeps an existing hint and adds the collision note only to 401/403', () => {
    const refused = Object.assign(httpError(403), { hint: 'Own hint.' });
    expect((withLoginHeaderCollisionHint(refused, 'Authorization') as any).hint).toMatch(/^Own hint\. The connector sets/);
    const notFound = httpError(404);
    expect((withLoginHeaderCollisionHint(notFound, 'Authorization') as any).hint).toBeUndefined();
  });
});
