import axios from 'axios';
import { createHmac } from 'node:crypto';
import {
  RestEngine,
  usesExtendedHmac,
  renderExtendedHmacTemplate,
  sortedParamsString,
  serializeRepeatedParams,
} from './rest.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import { LoginTokenService } from './login-token.service';

/**
 * Sorted-parameter HMAC signing (opt-in), as the Alibaba IOP gateways
 * (AliExpress Open Platform, Alibaba.com, Lazada) define it: every parameter
 * except `sign`, sorted by name, concatenated as key + value, optionally
 * prefixed with the API path, HMAC-SHA256 with the app secret, upper-case
 * hex, timestamp in milliseconds.
 *
 * The two pinned digests are the worked examples of the AliExpress Open
 * Platform documentation, "HTTP request sample" (docId 1385): secret
 * "helloworld", case 1 a business interface on /sync, case 2 the system
 * interface /auth/token/create on /rest. They were recomputed independently
 * with Python's hmac module and match the documented values.
 */
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as unknown as jest.Mock;

const DOC_TIMESTAMP = 1517820392000;

/** The signature block an IOP adapter declares. */
function iopSignature(extra: Record<string, unknown> = {}, template = '${sortedParams}') {
  return {
    signature: {
      algorithm: 'sha256',
      encoding: 'hex-upper',
      secret: 'helloworld',
      placement: 'query',
      paramName: 'sign',
      timestampParam: 'timestamp',
      timestampFormat: 'ms',
      template,
      ...extra,
    },
  };
}

describe('RestEngine: sorted-parameter HMAC signing (Alibaba IOP)', () => {
  let engine: RestEngine;
  let now: jest.SpyInstance;

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {}, headers: {} });
    engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
    now = jest.spyOn(Date, 'now').mockReturnValue(DOC_TIMESTAMP);
  });
  afterEach(() => now.mockRestore());

  const lastCall = () => mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0];
  const realAxios = () => (jest.requireActual('axios') as { default: typeof axios }).default;

  it('reproduces the documented business-interface signature (docs case 1, /sync)', async () => {
    // The documented string signs the method aliexpress.logistics.redefining.
    // getonlinelogisticsinfo (the page's step 3); the digest is the page's.
    await engine.execute(
      {
        baseUrl: 'https://api-sg.aliexpress.com',
        authType: 'HMAC',
        authConfig: iopSignature({
          queryParams: { app_key: '123456', sign_method: 'sha256', access_token: 'test' },
        }),
      },
      {
        method: 'GET',
        path: '/sync',
        queryParams: {
          method: 'aliexpress.logistics.redefining.getonlinelogisticsinfo',
          aliexpress_category_id: '$category',
        },
      } as never,
      { category: '200135143' },
    );
    const cfg = lastCall();
    expect(cfg.params).toEqual({
      method: 'aliexpress.logistics.redefining.getonlinelogisticsinfo',
      aliexpress_category_id: '200135143',
      app_key: '123456',
      sign_method: 'sha256',
      access_token: 'test',
      timestamp: '1517820392000',
      sign: 'F7F7926B67316C9D1E8E15F7E66940ED3059B1638C497D77973F30046EFB5BBB',
    });
    expect(realAxios().getUri(cfg)).toBe(
      'https://api-sg.aliexpress.com/sync?method=aliexpress.logistics.redefining.getonlinelogisticsinfo' +
        '&aliexpress_category_id=200135143&app_key=123456&sign_method=sha256&access_token=test' +
        '&timestamp=1517820392000&sign=F7F7926B67316C9D1E8E15F7E66940ED3059B1638C497D77973F30046EFB5BBB',
    );
    // Nothing in a header, the secret nowhere on the wire.
    expect(cfg.headers ?? {}).toEqual({});
    expect(JSON.stringify(cfg)).not.toContain('helloworld');
  });

  it('reproduces the documented system-interface signature (docs case 2, /rest + API path)', async () => {
    await engine.execute(
      {
        baseUrl: 'https://api-sg.aliexpress.com/rest',
        authType: 'HMAC',
        authConfig: iopSignature(
          { queryParams: { app_key: '12345678', sign_method: 'sha256' } },
          '${apiPath}${sortedParams}',
        ),
      },
      { method: 'GET', path: '/auth/token/create', queryParams: { code: '$code' } } as never,
      { code: '3_500102_JxZ05Ux3cnnSSUm6dCxYg6Q26' },
    );
    const cfg = lastCall();
    expect(cfg.url).toBe('https://api-sg.aliexpress.com/rest/auth/token/create');
    expect(cfg.params.sign).toBe('35607762342831B6A417A0DED84B79C05FEFBF116969C48AD6DC00279A9F4D81');
    expect(cfg.params.timestamp).toBe('1517820392000');
  });

  it('signs the fields of a form-urlencoded body with the query, sorted together', async () => {
    await engine.execute(
      {
        baseUrl: 'https://api-sg.aliexpress.com',
        authType: 'HMAC',
        authConfig: iopSignature({
          queryParams: { app_key: '123456', sign_method: 'sha256', access_token: 'tok' },
        }),
      },
      {
        method: 'POST',
        path: '/sync',
        queryParams: { method: 'aliexpress.ds.freight.query' },
        bodyEncoding: 'form-urlencoded',
        bodyMapping: {
          queryDeliveryReq: { __json: { productId: '$product_id', quantity: '$quantity' } },
          note: '$note',
        },
      } as never,
      { product_id: '1005001', quantity: 2, note: 'a b&c' },
    );
    const cfg = lastCall();
    expect(cfg.method).toBe('POST');
    expect(cfg.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(cfg.data).toBe(
      'queryDeliveryReq=%7B%22productId%22%3A%221005001%22%2C%22quantity%22%3A2%7D&note=a+b%26c',
    );
    // Written out by hand: body and query decoded, sorted by name.
    const expected = createHmac('sha256', 'helloworld')
      .update(
        'access_tokentok' +
          'app_key123456' +
          'methodaliexpress.ds.freight.query' +
          'notea b&c' +
          'queryDeliveryReq{"productId":"1005001","quantity":2}' +
          'sign_methodsha256' +
          'timestamp1517820392000',
        'utf8',
      )
      .digest('hex')
      .toUpperCase();
    expect(cfg.params.sign).toBe(expected);
    // The signature goes into the query, not into the body.
    expect(cfg.data).not.toContain('sign=');
  });

  it('signs again on a resend, without the previous signature', async () => {
    const authConfig = iopSignature({ queryParams: { app_key: 'k' } });
    const mapping = { method: 'GET', path: '/sync', queryParams: { method: 'x.y' } } as never;
    await engine.execute({ baseUrl: 'https://gw.test', authType: 'HMAC', authConfig }, mapping, {});
    const first = lastCall().params.sign;
    await engine.execute({ baseUrl: 'https://gw.test', authType: 'HMAC', authConfig }, mapping, {});
    expect(lastCall().params.sign).toBe(first);
  });

  it('sends the millisecond timestamp in a timestamp header too', async () => {
    await engine.execute(
      {
        baseUrl: 'https://gw.test',
        authType: 'HMAC',
        authConfig: {
          signature: { secret: 's', template: '${timestamp}', timestampFormat: 'ms', timestampHeader: 'X-Ts' },
        },
      },
      { method: 'GET', path: '/x' } as never,
      {},
    );
    const cfg = lastCall();
    expect(cfg.headers['X-Ts']).toBe('1517820392000');
    expect(cfg.headers.Signature).toBe(createHmac('sha256', 's').update('1517820392000').digest('hex'));
  });

  it('upper-case hex works with header placement as well', async () => {
    await engine.execute(
      {
        baseUrl: 'https://gw.test',
        authType: 'HMAC',
        authConfig: { signature: { secret: 's', template: '${method}', encoding: 'hex-upper' } },
      },
      { method: 'GET', path: '/x' } as never,
      {},
    );
    expect(lastCall().headers.Signature).toBe(
      createHmac('sha256', 's').update('GET').digest('hex').toUpperCase(),
    );
  });
});

describe('sortedParamsString', () => {
  it('follows the documented example: bar2foo1foo_bar3foobar4', () => {
    expect(sortedParamsString({ foo: 1, bar: 2, foo_bar: 3, foobar: 4 })).toBe('bar2foo1foo_bar3foobar4');
  });

  it('sorts by code unit (ASCII), so upper case comes before lower case and _ between them', () => {
    expect(sortedParamsString({ b: 1, B: 2, a_: 3, aZ: 4, a: 5 })).toBe('B2a5aZ4a_3b1');
  });

  it('leaves out the signature parameter, empty values and null/undefined', () => {
    expect(sortedParamsString({ sign: 'OLD', a: '', b: null, c: undefined, d: 0, e: false }, [], 'sign')).toBe(
      'd0efalse',
    );
  });

  it('uses the pairs the serializer sends for arrays and objects', () => {
    const params = { ids: ['3', '1'], page: { size: 20, no: 1 } };
    expect(serializeRepeatedParams(params)).toBe('ids=3&ids=1&page%5Bsize%5D=20&page%5Bno%5D=1');
    // Repeated keys keep their order; bracketed keys sort as written.
    expect(sortedParamsString(params)).toBe('ids3ids1page[no]1page[size]20');
  });

  it('merges form fields with the query', () => {
    expect(sortedParamsString({ z: 'q' }, [['a', 'f'], ['m', '']])).toBe('afzq');
  });
});

describe('renderExtendedHmacTemplate with the new variables', () => {
  const base = { method: 'GET', url: 'u', path: 'p', pathname: '/rest/a', body: 'B', timestamp: '1', query: {} };

  it('renders ${sortedParams} and ${apiPath} in one pass: a value cannot inject a variable', () => {
    expect(
      renderExtendedHmacTemplate('${apiPath}${sortedParams}${body}', {
        ...base,
        apiPath: '/a',
        sortedParams: () => 'x${body}y',
      }),
    ).toBe('/ax${body}yB');
  });

  it('computes ${sortedParams} only when the template uses it', () => {
    const sorted = jest.fn(() => 's');
    renderExtendedHmacTemplate('${pathname}', { ...base, sortedParams: sorted });
    expect(sorted).not.toHaveBeenCalled();
  });

  it('falls back to the pathname for ${apiPath} without a base URL', () => {
    expect(renderExtendedHmacTemplate('${apiPath}', base)).toBe('/rest/a');
  });
});

describe('opt-in: signatures without the new options keep their code path', () => {
  it('usesExtendedHmac is false for a header signature without the new options', () => {
    expect(usesExtendedHmac({ secret: 's', template: '${method}\n${url}', encoding: 'hex' })).toBe(false);
    expect(usesExtendedHmac({ secret: 's', encoding: 'base64' })).toBe(false);
  });

  it('usesExtendedHmac is true for each new option on its own', () => {
    expect(usesExtendedHmac({ encoding: 'hex-upper' })).toBe(true);
    expect(usesExtendedHmac({ timestampFormat: 'ms' })).toBe(true);
    expect(usesExtendedHmac({ template: '${sortedParams}' })).toBe(true);
    expect(usesExtendedHmac({ template: '${apiPath}' })).toBe(true);
  });

  it('every catalog HMAC adapter except the IOP ones signs exactly as before', () => {
    // Kaufland (header) and Shopee (query) are pinned byte for byte in
    // rest.engine.hmac-pin.spec.ts and rest.engine.shopee.spec.ts; here we
    // only check that neither declares one of the new options.
    const kaufland = require('../../adapters/de/kaufland.json');
    const shopee = require('../../adapters/intl/shopee.json');
    for (const adapter of [kaufland, shopee]) {
      const sig = adapter.connector.authConfig.signature;
      expect(sig.timestampFormat).toBeUndefined();
      expect(sig.encoding === 'hex-upper').toBe(false);
      expect(String(sig.template ?? '')).not.toMatch(/\$\{(sortedParams|apiPath)\}/);
    }
  });
});
