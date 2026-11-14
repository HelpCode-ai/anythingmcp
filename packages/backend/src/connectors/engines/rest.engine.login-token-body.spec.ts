import axios, { AxiosError } from 'axios';
import { ConfigService } from '@nestjs/config';
import { RestEngine, bodyReports401, renderXmlBodyTemplate } from './rest.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import { LoginTokenService } from './login-token.service';
import { PrismaService } from '../../common/prisma.service';
import { ResponseBodyError } from './response-error.util';
import { hasXmlTemplateBlocks, renderXmlTemplateBlocks } from './xml-body-template.util';

/**
 * LOGIN_TOKEN for APIs that carry the token in the request body (Fnac Darty:
 * `token="…"` on the root element of every XML request) and report an expired
 * token in the body instead of with HTTP 401:
 *
 *  - `authConfig.tokenPlacement: "body"` and `${loginToken}` in a bodyTemplate
 *  - `authConfig.refreshOnBody401` with `connector.config.errorWhen`
 *  - optional and repeated blocks in an XML bodyTemplate
 *
 * Each is opt-in: the last tests of every group pin what happens without it.
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

const BASE = 'https://api.example.test/api.php';
const XML = { 'content-type': 'text/xml; charset=UTF-8' };
const TEMPLATE =
  '<offers_query partner_id="P1" shop_id="S1" token="${loginToken}"><offer_seller_id>${sku}</offer_seller_id></offers_query>';
const ERROR_WHEN = [
  { path: 'offers_query_response.error.code', in: ['ERR_098', 'ERR_102'], messagePath: 'offers_query_response.error.#text', status: 401 },
  { path: 'offers_query_response.error.code', matches: '.+', messagePath: 'offers_query_response.error.#text', status: 400 },
];
const expired =
  '<offers_query_response status="FATAL"><error severity="FATAL" code="ERR_098">Authentication Failure: token session time is expired, please authenticate.</error></offers_query_response>';
const refusedRequest =
  '<offers_query_response status="FATAL"><error severity="FATAL" code="ERR_096">Validation failed: XML.</error></offers_query_response>';
const offers = '<offers_query_response status="OK"><page>1</page><offer><offer_seller_id>SKU-1</offer_seller_id></offer></offers_query_response>';

const loginStub = (tokens = ['tok-1', 'tok-2']) => {
  const service = {
    getToken: jest.fn().mockResolvedValue({ token: tokens[0], aud: 'S1', expiresAt: Date.now() + 600_000 }),
    forceRelogin: jest.fn().mockResolvedValue({ token: tokens[1], aud: 'S1', expiresAt: Date.now() + 600_000 }),
  };
  return service as unknown as LoginTokenService & typeof service;
};
const httpError = (status: number, data: unknown, headers: Record<string, string> = XML) => {
  const response = { status, data, headers, statusText: '', config: {} as never };
  return new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', undefined, undefined, response as never);
};
const authConfig = (extra: Record<string, unknown> = {}) => ({
  loginUrl: `${BASE}/auth`,
  username: 'P1',
  password: 'key',
  tokenJsonPath: 'auth_response.token',
  tokenPlacement: 'body',
  ...extra,
});
const mapping = (extra: Record<string, unknown> = {}) => ({
  method: 'POST',
  path: '/offers_query',
  bodyEncoding: 'xml',
  bodyTemplate: TEMPLATE,
  ...extra,
});
// The error a call fails with; a call that succeeds fails the test.
const caught = (call: Promise<unknown>): Promise<any> =>
  call.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (error) => error,
  );
const sentAt = (index: number) => mockedAxios.mock.calls[index][0];
const headerNames = (request: { headers?: Record<string, unknown> }) => Object.keys(request.headers ?? {}).map((h) => h.toLowerCase());

describe('RestEngine: LOGIN_TOKEN with the token in the request body', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('renders ${loginToken} into an XML bodyTemplate, escaped, and sends no token header', async () => {
    const login = loginStub(['tok&<1>', 'tok-2']);
    mockedAxios.mockResolvedValueOnce({ status: 200, data: offers, headers: XML });
    const out = await new RestEngine({} as OAuth2TokenService, login).execute(
      { baseUrl: BASE, authType: 'LOGIN_TOKEN', authConfig: authConfig() },
      mapping(),
      // A caller cannot supply the token itself: the engine's value wins.
      { sku: 'A & B', loginToken: 'spoofed' },
    );
    const request = sentAt(0);
    expect(request.url).toBe(`${BASE}/offers_query`);
    expect(request.data).toBe(
      '<offers_query partner_id="P1" shop_id="S1" token="tok&amp;&lt;1&gt;"><offer_seller_id>A &amp; B</offer_seller_id></offers_query>',
    );
    expect(headerNames(request)).toEqual(['content-type']);
    expect(request.headers['Content-Type']).toBe('application/xml; charset=utf-8');
    // The XML answer reaches the caller parsed.
    expect(out).toEqual({ offers_query_response: { status: 'OK', page: '1', offer: { offer_seller_id: 'SKU-1' } } });
  });

  it('renders ${loginToken} into a JSON bodyTemplate as a JSON string', async () => {
    const login = loginStub(['tok"1', 'tok-2']);
    mockedAxios.mockResolvedValueOnce({ status: 200, data: { ok: true }, headers: {} });
    await new RestEngine({} as OAuth2TokenService, login).execute(
      { baseUrl: BASE, authType: 'LOGIN_TOKEN', authConfig: authConfig() },
      { method: 'POST', path: '/q', bodyTemplate: '{"auth":{"token":"${loginToken}"},"sku":"${sku}"}' },
      { sku: 'A' },
    );
    expect(sentAt(0).data).toEqual({ auth: { token: 'tok"1' }, sku: 'A' });
    expect(headerNames(sentAt(0))).not.toContain('authorization');
  });

  it('keeps extraHeaders with tokenPlacement body', async () => {
    mockedAxios.mockResolvedValueOnce({ status: 200, data: offers, headers: XML });
    await new RestEngine({} as OAuth2TokenService, loginStub()).execute(
      { baseUrl: BASE, authType: 'LOGIN_TOKEN', authConfig: authConfig({ extraHeaders: { 'X-Shop': '${aud}' } }) },
      mapping(),
      { sku: 'A' },
    );
    expect(sentAt(0).headers['X-Shop']).toBe('S1');
    expect(headerNames(sentAt(0))).not.toContain('authorization');
  });

  it('without tokenPlacement the token goes in the header and ${loginToken} is an ordinary, missing parameter', async () => {
    mockedAxios.mockResolvedValueOnce({ status: 200, data: offers, headers: XML });
    await new RestEngine({} as OAuth2TokenService, loginStub()).execute(
      { baseUrl: BASE, authType: 'LOGIN_TOKEN', authConfig: authConfig({ tokenPlacement: undefined }) },
      mapping(),
      { sku: 'A' },
    );
    expect(sentAt(0).headers.Authorization).toBe('Bearer tok-1');
    expect(sentAt(0).data).toBe('<offers_query partner_id="P1" shop_id="S1" token=""><offer_seller_id>A</offer_seller_id></offers_query>');
  });
});

describe('RestEngine: re-login when the body reports a refused token (refreshOnBody401)', () => {
  beforeEach(() => mockedAxios.mockReset());
  const config = (auth: Record<string, unknown> = {}, errorWhen: unknown = ERROR_WHEN) => ({
    baseUrl: BASE,
    authType: 'LOGIN_TOKEN',
    authConfig: authConfig({ refreshOnBody401: true, ...auth }),
    errorWhen,
    connectorId: 'conn-1',
  });

  it('signs in again and repeats the call with the new token when a 200 answer carries the expired-token error', async () => {
    const login = loginStub();
    mockedAxios
      .mockResolvedValueOnce({ status: 200, data: expired, headers: XML })
      .mockResolvedValueOnce({ status: 200, data: offers, headers: XML });
    const out = await new RestEngine({} as OAuth2TokenService, login).execute(config(), mapping(), { sku: 'A' });
    expect(login.forceRelogin).toHaveBeenCalledTimes(1);
    expect(login.forceRelogin).toHaveBeenCalledWith(expect.objectContaining({ tokenPlacement: 'body' }), 'conn-1', { proxyUrl: undefined });
    expect(mockedAxios).toHaveBeenCalledTimes(2);
    expect(sentAt(0).data).toContain('token="tok-1"');
    expect(sentAt(1).data).toBe('<offers_query partner_id="P1" shop_id="S1" token="tok-2"><offer_seller_id>A</offer_seller_id></offers_query>');
    expect(headerNames(sentAt(1))).not.toContain('authorization');
    expect(out).toMatchObject({ offers_query_response: { status: 'OK' } });
  });

  it('does the same when the expired-token error arrives with HTTP 400', async () => {
    const login = loginStub();
    mockedAxios
      .mockRejectedValueOnce(httpError(400, expired))
      .mockResolvedValueOnce({ status: 200, data: offers, headers: XML });
    const out = await new RestEngine({} as OAuth2TokenService, login).execute(config(), mapping(), { sku: 'A' });
    expect(login.forceRelogin).toHaveBeenCalledTimes(1);
    expect(sentAt(1).data).toContain('token="tok-2"');
    expect(out).toMatchObject({ offers_query_response: { status: 'OK' } });
  });

  it('retries once only: a second refusal is reported, not looped on', async () => {
    const login = loginStub();
    mockedAxios
      .mockResolvedValueOnce({ status: 200, data: expired, headers: XML })
      .mockResolvedValueOnce({ status: 200, data: expired, headers: XML });
    const failure = await caught(new RestEngine({} as OAuth2TokenService, login).execute(config(), mapping(), { sku: 'A' }));
    expect(failure).toBeInstanceOf(ResponseBodyError);
    expect(failure.status).toBe(401);
    expect(failure.message).toContain('token session time is expired');
    expect(login.forceRelogin).toHaveBeenCalledTimes(1);
    expect(mockedAxios).toHaveBeenCalledTimes(2);
  });

  it('does not sign in again for an error that is not about the token', async () => {
    const login = loginStub();
    mockedAxios.mockResolvedValueOnce({ status: 200, data: refusedRequest, headers: XML });
    const inBody = await caught(new RestEngine({} as OAuth2TokenService, login).execute(config(), mapping(), { sku: 'A' }));
    expect(inBody).toBeInstanceOf(ResponseBodyError);
    expect(inBody.status).toBe(400);

    mockedAxios.mockRejectedValueOnce(httpError(400, refusedRequest));
    const asHttp = await caught(new RestEngine({} as OAuth2TokenService, login).execute(config(), mapping(), { sku: 'A' }));
    expect(asHttp).toBeInstanceOf(AxiosError);
    expect(asHttp.response.status).toBe(400);
    expect(login.forceRelogin).not.toHaveBeenCalled();
    expect(mockedAxios).toHaveBeenCalledTimes(2);
  });

  it('puts the new token in the header when the connector sends it there', async () => {
    const login = loginStub();
    mockedAxios
      .mockResolvedValueOnce({ status: 200, data: expired, headers: XML })
      .mockResolvedValueOnce({ status: 200, data: offers, headers: XML });
    await new RestEngine({} as OAuth2TokenService, login).execute(
      config({ tokenPlacement: undefined }),
      mapping({ bodyTemplate: '<offers_query><offer_seller_id>${sku}</offer_seller_id></offers_query>' }),
      { sku: 'A' },
    );
    expect(sentAt(0).headers.Authorization).toBe('Bearer tok-1');
    expect(sentAt(1).headers.Authorization).toBe('Bearer tok-2');
  });

  it('without refreshOnBody401 a mapped 401 is reported and nothing is retried, as before', async () => {
    const login = loginStub();
    mockedAxios.mockResolvedValueOnce({ status: 200, data: expired, headers: XML });
    const inBody = await caught(
      new RestEngine({} as OAuth2TokenService, login).execute(config({ refreshOnBody401: undefined }), mapping(), { sku: 'A' }),
    );
    expect(inBody).toBeInstanceOf(ResponseBodyError);
    expect(inBody.status).toBe(401);

    mockedAxios.mockRejectedValueOnce(httpError(400, expired));
    const asHttp = await caught(
      new RestEngine({} as OAuth2TokenService, login).execute(config({ refreshOnBody401: false }), mapping(), { sku: 'A' }),
    );
    expect(asHttp).toBeInstanceOf(AxiosError);
    expect(login.forceRelogin).not.toHaveBeenCalled();
    expect(mockedAxios).toHaveBeenCalledTimes(2);
  });

  it('an HTTP 401 still triggers the existing re-login, and renders the new token into the body', async () => {
    const login = loginStub();
    mockedAxios
      .mockRejectedValueOnce(httpError(401, 'Unauthorized', { 'content-type': 'text/plain' }))
      .mockResolvedValueOnce({ status: 200, data: offers, headers: XML });
    await new RestEngine({} as OAuth2TokenService, login).execute(config({ refreshOnBody401: undefined }), mapping(), { sku: 'A' });
    expect(login.forceRelogin).toHaveBeenCalledTimes(1);
    expect(sentAt(1).data).toContain('token="tok-2"');
  });

  it('bodyReports401 reads a ResponseBodyError, an XML or JSON error body, and nothing else', () => {
    expect(bodyReports401(new ResponseBodyError('expired', 401, {}), ERROR_WHEN)).toBe(true);
    expect(bodyReports401(new ResponseBodyError('other', 400, {}), ERROR_WHEN)).toBe(false);
    expect(bodyReports401(httpError(400, expired), ERROR_WHEN)).toBe(true);
    expect(bodyReports401(httpError(500, expired), ERROR_WHEN)).toBe(true);
    expect(bodyReports401(httpError(400, refusedRequest), ERROR_WHEN)).toBe(false);
    // An XML body that is not declared as XML is not parsed, as for a 2xx answer.
    expect(bodyReports401(httpError(400, expired, { 'content-type': 'text/plain' }), ERROR_WHEN)).toBe(false);
    expect(bodyReports401(httpError(400, { code: 'TOKEN_EXPIRED' }, {}), [{ path: 'code', equals: 'TOKEN_EXPIRED', status: 401 }])).toBe(true);
    expect(bodyReports401(httpError(400, expired), undefined)).toBe(false);
    expect(bodyReports401(new Error('network'), ERROR_WHEN)).toBe(false);
    expect(bodyReports401(new AxiosError('timeout'), ERROR_WHEN)).toBe(false);
  });
});

describe('RestEngine with the real LoginTokenService: XML login, token in the body, re-login', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('logs in with an XML document, reads the XML answer, and logs in again when the token has expired', async () => {
    const auth = {
      loginUrl: `${BASE}/auth`,
      loginMethod: 'POST',
      loginBodyFormat: 'xml',
      loginBody: '<auth><partner_id>${username}</partner_id><shop_id>${aud}</shop_id><key>${password}</key></auth>',
      loginHeaders: { 'Content-Type': 'text/xml; charset=utf-8' },
      username: 'P1',
      password: 'k&y',
      aud: 'S1',
      loginResponseFormat: 'xml',
      tokenJsonPath: 'auth_response.token',
      expiryJsonPath: 'auth_response.validity',
      tokenPlacement: 'body',
      refreshOnBody401: true,
    };
    const authAnswer = (token: string) => ({
      status: 200,
      data: `<auth_response status="OK"><token>${token}</token><validity>${new Date(Date.now() + 3_600_000).toISOString()}</validity></auth_response>`,
      headers: XML,
    });
    mockedAxios
      .mockResolvedValueOnce(authAnswer('tok-1'))
      .mockResolvedValueOnce({ status: 200, data: expired, headers: XML })
      .mockResolvedValueOnce(authAnswer('tok-2'))
      .mockResolvedValueOnce({ status: 200, data: offers, headers: XML });
    const login = new LoginTokenService(
      { connectorAuthCache: { findUnique: async () => null, upsert: async () => ({}) } } as unknown as PrismaService,
      { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService,
    );
    const out = await new RestEngine({} as OAuth2TokenService, login).execute(
      { baseUrl: BASE, authType: 'LOGIN_TOKEN', authConfig: auth, errorWhen: ERROR_WHEN, connectorId: 'conn-xml' },
      mapping(),
      { sku: 'A' },
    );
    const [login1, call1, login2, call2] = [0, 1, 2, 3].map(sentAt);
    for (const request of [login1, login2]) {
      expect(request.url).toBe(`${BASE}/auth`);
      expect(request.data).toBe('<auth><partner_id>P1</partner_id><shop_id>S1</shop_id><key>k&amp;y</key></auth>');
      expect(request.headers['Content-Type']).toBe('text/xml; charset=utf-8');
    }
    expect(call1.data).toContain('token="tok-1"');
    expect(call2.data).toContain('token="tok-2"');
    expect(out).toMatchObject({ offers_query_response: { status: 'OK' } });
    expect(mockedAxios).toHaveBeenCalledTimes(4);
  });
});

describe('XML bodyTemplate: optional and repeated blocks', () => {
  it('keeps a block only when its parameter has a value; 0 and false are values', () => {
    const template = '<q${?n} n="${n}"${/n}>${?page}<paging>${page}</paging>${/page}${?flag}<flag>${flag}</flag>${/flag}</q>';
    expect(renderXmlBodyTemplate(template, {})).toBe('<q></q>');
    expect(renderXmlBodyTemplate(template, { n: 5, page: 0, flag: false })).toBe('<q n="5"><paging>0</paging><flag>false</flag></q>');
    expect(renderXmlBodyTemplate(template, { n: '', page: null, flag: [] })).toBe('<q></q>');
  });

  it('keeps a block named after several parameters when any of them has a value, and nests', () => {
    const template =
      '<q>${?min|max}<date type="${type}">${?min}<min>${min}</min>${/min}${?max}<max>${max}</max>${/max}</date>${/min|max}</q>';
    expect(renderXmlBodyTemplate(template, { type: 'Created' })).toBe('<q></q>');
    expect(renderXmlBodyTemplate(template, { type: 'Created', max: '2026-11-14' })).toBe(
      '<q><date type="Created"><max>2026-11-14</max></date></q>',
    );
    expect(renderXmlBodyTemplate(template, { type: 'Created', min: 'a', max: 'b' })).toBe(
      '<q><date type="Created"><min>a</min><max>b</max></date></q>',
    );
  });

  it('repeats a block for every item: ${.} for a scalar, the fields for an object', () => {
    expect(renderXmlBodyTemplate('<q>${*ids}<id>${.}</id>${/ids}</q>', { ids: ['a&b', 2] })).toBe('<q><id>a&amp;b</id><id>2</id></q>');
    expect(renderXmlBodyTemplate('<q>${*ids}<id>${.}</id>${/ids}</q>', { ids: 'one' })).toBe('<q><id>one</id></q>');
    expect(renderXmlBodyTemplate('<q>${*ids}<id>${.}</id>${/ids}</q>', {})).toBe('<q></q>');
    const lines = '<o id="${order}">${*lines}<l><n>${n}</n>${?track}<t>${track}</t>${/track}<o>${order}</o></l>${/lines}</o>';
    expect(renderXmlBodyTemplate(lines, { order: 'X1', lines: [{ n: 1, track: '<T>' }, { n: 2 }] })).toBe(
      '<o id="X1"><l><n>1</n><t>&lt;T&gt;</t><o>X1</o></l><l><n>2</n><o>X1</o></l></o>',
    );
  });

  it('nests an optional and a repeated block of the same name, so the wrapper goes with the list', () => {
    const template = '<q>${?states}<states>${*states}<state>${.}</state>${/states}</states>${/states}<end/></q>';
    expect(renderXmlBodyTemplate(template, {})).toBe('<q><end/></q>');
    expect(renderXmlBodyTemplate(template, { states: ['Created', 'ToShip'] })).toBe(
      '<q><states><state>Created</state><state>ToShip</state></states><end/></q>',
    );
  });

  it('lets an engine value win over the call and over an item of a repeated block', () => {
    const template = '<q t="${loginToken}">${*rows}<r t="${loginToken}">${v}</r>${/rows}</q>';
    expect(
      renderXmlBodyTemplate(template, { loginToken: 'spoof', rows: [{ v: 1, loginToken: 'spoof-2' }] }, { loginToken: 'real' }),
    ).toBe('<q t="real"><r t="real">1</r></q>');
  });

  it('never reads a parameter from the prototype chain', () => {
    expect(renderXmlBodyTemplate('<q>${?constructor}<c>${constructor}</c>${/constructor}${*toString}<t/>${/toString}</q>', {})).toBe('<q></q>');
  });

  it('stops on a block that is not closed or not named, before anything is sent', () => {
    expect(() => renderXmlBodyTemplate('<q>${?page}<paging>${page}</paging></q>', { page: 1 })).toThrow(/\$\{\?page\} is never closed/);
    expect(() => renderXmlBodyTemplate('<q>${*rows}<r/>${/row}</q>', {})).toThrow(/never closed/);
    expect(() => renderXmlBodyTemplate('<q>${?}<r/>${/}</q>', {})).toThrow(/must be followed by a parameter name/);
    expect(() => renderXmlBodyTemplate('<q>${*a|b}<r/>${/a|b}</q>', {})).toThrow(/must be followed by a parameter name/);
  });

  it('leaves a template without blocks to the renderer that existed before them', () => {
    expect(hasXmlTemplateBlocks('<A>${a}</A>')).toBe(false);
    expect(hasXmlTemplateBlocks('<A>${?a}x${/a}</A>')).toBe(true);
    // Without a block, "${/a}" and "${.}" are not placeholders and stay as written.
    expect(renderXmlBodyTemplate('<A>${a}${/a}${.}</A><B>${missing}</B>', { a: 'T&J' })).toBe('<A>T&amp;J${/a}${.}</A><B></B>');
    expect(renderXmlTemplateBlocks('<A>${a}</A>', { a: 'x' })).toBe('<A>x</A>');
  });
});
