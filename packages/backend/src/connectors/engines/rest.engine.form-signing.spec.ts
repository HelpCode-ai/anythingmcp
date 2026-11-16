import axios from 'axios';
import { createHmac } from 'node:crypto';
import {
  RestEngine,
  renderExtendedHmacTemplate,
  signedFormFields,
  timestampOffsetMs,
  usesExtendedHmac,
} from './rest.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import { LoginTokenService } from './login-token.service';

/**
 * HMAC signature inside a form-urlencoded body, with an expiry time in the
 * future instead of the signing time (Apaczka.pl API v2). Opt-in: the
 * header-placed HMAC of rest.engine.hmac-pin.spec.ts and the query and body
 * placements of the other signing specs are untouched.
 *
 * Apaczka's documented scheme (api-docs.apaczka.pl, "Request signing
 * (HMAC)"): every call is a POST to https://www.apaczka.pl/api/v2/<route>
 * with the form fields app_id, request (the call's JSON as text), expires
 * (Unix seconds, at most 15 minutes ahead) and signature = lower-case hex
 * HMAC-SHA256 of `app_id:route:request:expires` keyed with the app secret,
 * where route is the method path with its path parameters and trailing
 * slash and no leading slash (`orders/`, `waybill/123456/`).
 *
 * The pinned digests were computed outside this code base, with PHP 8 and
 * the formula of the official SDK (AlsendoOne\SDK\Auth\SignatureGenerator::
 * generate: `hash_hmac('sha256', sprintf('%s:%s:%s:%s', $appId, $route,
 * $jsonRequest, $expires), $appSecret)`, the request being
 * `json_encode((object) $params)` in AlsendoClient::request):
 *
 *   $id = '62f10ea5-a532-4a30-bb5c-9b6bd0e29d31'; $sec = 'test-app-secret';
 *   sig($id, $sec, 'orders/', json_encode((object)['page'=>1,'limit'=>10]), 1752995400)
 *     = 835cb65245fb67c067d3b84b100e55f29a1f548ea022ca62bfcebfc8a5231a51
 *   sig($id, $sec, 'waybill/467840212/', json_encode((object)[]), 1752995400)
 *     = cd8709477db08a4a512314d92934eecd7b82a14a54b3d1e98919ff4f8d4e0e86
 *   sig($id, $sec, 'order_valuation/', '{"order":{"content":"Łódź / A&B + C=D"}}', 1752995400)
 *     = efb6036bc555122ee0b4e6ad46f940f7d708aa2adce43cad75188470d4556819
 *
 * The third one signs the request text exactly as this engine sends it
 * (JSON.stringify keeps `Ł` and `/`; PHP's json_encode would escape them).
 * The server verifies the signature against the request field it receives,
 * so what matters is that the text signed is the text sent.
 *
 * The clock is fixed at 1752994800 (the docs' example) and the adapter adds
 * 600 seconds, so expires is 1752995400.
 */
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    ...actual,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
  };
});
jest.mock('../../common/ssrf.util', () => ({
  ...jest.requireActual('../../common/ssrf.util'),
  assertSafeOutboundUrl: jest.fn().mockResolvedValue(undefined),
}));
const mockedAxios = axios as unknown as jest.Mock;

const APP_ID = '62f10ea5-a532-4a30-bb5c-9b6bd0e29d31';
const APP_SECRET = 'test-app-secret';
const NOW_S = 1752994800;
const EXPIRES = String(NOW_S + 600);

const apaczkaSignature = (extra: Record<string, unknown> = {}) => ({
  algorithm: 'sha256',
  encoding: 'hex',
  secret: APP_SECRET,
  placement: 'form',
  paramName: 'signature',
  bodyParams: { app_id: APP_ID },
  timestampParam: 'expires',
  timestampOffsetSeconds: 600,
  template: '${form.app_id}:${apiPathNoSlash}:${form.request}:${timestamp}',
  ...extra,
});

const apaczkaConfig = (extra: Record<string, unknown> = {}) => ({
  baseUrl: 'https://www.apaczka.pl/api/v2',
  authType: 'HMAC',
  authConfig: { signature: apaczkaSignature(extra) },
});

describe('RestEngine: HMAC signature in a form body (Apaczka)', () => {
  let engine: RestEngine;
  let now: jest.SpyInstance;

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { status: 200, message: '', response: {} }, headers: {} });
    engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
    now = jest.spyOn(Date, 'now').mockReturnValue(NOW_S * 1000);
  });
  afterEach(() => now.mockRestore());

  const lastCall = () => mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0];

  it('sends app_id, request, expires and the SDK signature as form fields', async () => {
    await engine.execute(
      apaczkaConfig(),
      {
        method: 'POST',
        path: '/orders/',
        bodyEncoding: 'form-urlencoded',
        bodyMapping: { request: { __json: { page: '$page', limit: '$limit' } } },
      } as never,
      { page: 1, limit: 10 },
    );
    const cfg = lastCall();
    expect(cfg.method).toBe('POST');
    expect(cfg.url).toBe('https://www.apaczka.pl/api/v2/orders/');
    expect(cfg.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(cfg.data);
    expect([...form.keys()]).toEqual(['request', 'app_id', 'expires', 'signature']);
    expect(form.get('request')).toBe('{"page":1,"limit":10}');
    expect(form.get('app_id')).toBe(APP_ID);
    expect(form.get('expires')).toBe(EXPIRES);
    expect(form.get('signature')).toBe('835cb65245fb67c067d3b84b100e55f29a1f548ea022ca62bfcebfc8a5231a51');
    // Nothing goes into the query.
    expect(Object.keys(cfg.params ?? {})).toEqual([]);
    expect(cfg.url).not.toContain('?');
  });

  it('signs the path parameters and the trailing slash as part of the route', async () => {
    await engine.execute(
      apaczkaConfig(),
      {
        method: 'POST',
        path: '/waybill/{order_id}/',
        bodyEncoding: 'form-urlencoded',
        bodyMapping: { request: { __json: {} } },
      } as never,
      { order_id: 467840212 },
    );
    const cfg = lastCall();
    expect(cfg.url).toBe('https://www.apaczka.pl/api/v2/waybill/467840212/');
    const form = new URLSearchParams(cfg.data);
    expect(form.get('request')).toBe('{}');
    expect(form.get('signature')).toBe('cd8709477db08a4a512314d92934eecd7b82a14a54b3d1e98919ff4f8d4e0e86');
  });

  it('signs the request text exactly as sent, non-ASCII and form specials included', async () => {
    await engine.execute(
      apaczkaConfig(),
      {
        method: 'POST',
        path: '/order_valuation/',
        bodyEncoding: 'form-urlencoded',
        bodyMapping: { request: { __json: { order: { content: '$content' } } } },
      } as never,
      { content: 'Łódź / A&B + C=D' },
    );
    const cfg = lastCall();
    // Percent-encoded on the wire, decoded back to the signed text.
    expect(cfg.data).toContain('request=%7B%22order%22');
    const form = new URLSearchParams(cfg.data);
    expect(form.get('request')).toBe('{"order":{"content":"Łódź / A&B + C=D"}}');
    expect(form.get('signature')).toBe('efb6036bc555122ee0b4e6ad46f940f7d708aa2adce43cad75188470d4556819');
  });

  it('keeps app_id, expires and the signature out of the caller\'s reach', async () => {
    await engine.execute(
      apaczkaConfig(),
      {
        method: 'POST',
        path: '/orders/',
        bodyEncoding: 'form-urlencoded',
        bodyMapping: {
          request: { __json: { page: '$page', limit: '$limit' } },
          app_id: '$app_id',
          expires: '$expires',
          signature: '$signature',
        },
      } as never,
      { page: 1, limit: 10, app_id: 'someone-else', expires: '9999999999', signature: 'f'.repeat(64) },
    );
    const form = new URLSearchParams(lastCall().data);
    expect(form.getAll('app_id')).toEqual([APP_ID]);
    expect(form.getAll('expires')).toEqual([EXPIRES]);
    expect(form.getAll('signature')).toEqual(['835cb65245fb67c067d3b84b100e55f29a1f548ea022ca62bfcebfc8a5231a51']);
  });

  it('signs a tool without a body of its own: only the static fields and the timestamp', async () => {
    await engine.execute(
      apaczkaConfig({ template: '${form.app_id}:${apiPathNoSlash}:${form.request}:${timestamp}' }),
      { method: 'POST', path: '/service_structure/' } as never,
      {},
    );
    const cfg = lastCall();
    const form = new URLSearchParams(cfg.data);
    expect([...form.keys()]).toEqual(['app_id', 'expires', 'signature']);
    expect(cfg.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    // `${form.request}` is empty when there is no such field.
    const expected = createHmac('sha256', APP_SECRET)
      .update(`${APP_ID}:service_structure/::${EXPIRES}`)
      .digest('hex');
    expect(form.get('signature')).toBe(expected);
  });

  it('refuses a GET and a JSON body, which cannot carry the form', async () => {
    await expect(
      engine.execute(apaczkaConfig(), { method: 'GET', path: '/orders/' } as never, {}),
    ).rejects.toThrow(/signature.placement "form".*GET request/);
    await expect(
      engine.execute(apaczkaConfig(), { method: 'POST', path: '/orders/', bodyMapping: { page: '$page' } } as never, {
        page: 1,
      }),
    ).rejects.toThrow(/application\/x-www-form-urlencoded body/);
    expect(mockedAxios).not.toHaveBeenCalled();
  });
});

describe('form signing helpers', () => {
  it('builds the form fields in order and drops a previous signature', () => {
    const fields = signedFormFields(
      {
        method: 'POST',
        data: 'request=%7B%7D&signature=old&app_id=x',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      },
      apaczkaSignature(),
      '1752995400',
      'POST',
    );
    expect(fields.toString()).toBe(`request=%7B%7D&app_id=${APP_ID}&expires=1752995400`);
  });

  it('accepts only whole-number offsets within a day', () => {
    expect(timestampOffsetMs(600)).toBe(600000);
    expect(timestampOffsetMs(-30)).toBe(-30000);
    for (const bad of [1.5, '600', 86401, -86401, null, NaN]) {
      expect(() => timestampOffsetMs(bad)).toThrow(/timestampOffsetSeconds/);
    }
  });

  it('switches to the extended path only for the new fields', () => {
    expect(usesExtendedHmac({ template: '${method}', secret: 'k' })).toBe(false);
    expect(usesExtendedHmac({ template: '${apiPathNoSlash}' })).toBe(true);
    expect(usesExtendedHmac({ template: '${form.request}' })).toBe(true);
    expect(usesExtendedHmac({ template: '${method}', timestampOffsetSeconds: 0 })).toBe(true);
    expect(usesExtendedHmac({ placement: 'form' })).toBe(true);
  });

  it('renders ${form.NAME} only for the form placement, and ${apiPathNoSlash} without the slash', () => {
    const base = {
      method: 'POST',
      url: 'https://www.apaczka.pl/api/v2/points/INPOST/',
      path: '/api/v2/points/INPOST/',
      pathname: '/api/v2/points/INPOST/',
      apiPath: '/points/INPOST/',
      body: '',
      timestamp: '1',
      query: {},
    };
    expect(renderExtendedHmacTemplate('${apiPathNoSlash}|${apiPath}|${form.app_id}', base)).toBe(
      'points/INPOST/|/points/INPOST/|${form.app_id}',
    );
    expect(
      renderExtendedHmacTemplate('${form.app_id}:${form.missing}:', { ...base, form: new URLSearchParams('app_id=a%3Ab') }),
    ).toBe('a:b::');
  });

  it('adds the offset to a header-placed timestamp too', async () => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {}, headers: {} });
    const now = jest.spyOn(Date, 'now').mockReturnValue(NOW_S * 1000);
    try {
      await new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
        {
          baseUrl: 'https://api.example.com',
          authType: 'HMAC',
          authConfig: {
            signature: {
              secret: 'k',
              template: '${timestamp}',
              headerName: 'X-Sign',
              timestampHeader: 'X-Expires',
              timestampOffsetSeconds: 300,
            },
          },
        },
        { method: 'GET', path: '/x' } as never,
        {},
      );
      const cfg = mockedAxios.mock.calls[0][0];
      expect(cfg.headers['X-Expires']).toBe(String(NOW_S + 300));
      expect(cfg.headers['X-Sign']).toBe(
        createHmac('sha256', 'k').update(String(NOW_S + 300)).digest('hex'),
      );
    } finally {
      now.mockRestore();
    }
  });
});
