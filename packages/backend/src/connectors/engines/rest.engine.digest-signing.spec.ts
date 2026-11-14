import axios from 'axios';
// The default import is the module object itself, so a spy on it is seen by
// the engine (a namespace import would be a copy).
import nodeCrypto from 'node:crypto';
import {
  RestEngine,
  usesExtendedHmac,
  renderExtendedHmacTemplate,
  renderSignatureHeader,
  signatureNonce,
  signedBodyFields,
  sortedBodyParamsString,
} from './rest.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import { LoginTokenService } from './login-token.service';

/**
 * Plain-digest signing inside a JSON body (Temu's Partner API) and the
 * nonce / wrapped-header options (SHEIN Open Platform). All opt-in: the
 * header-placed HMAC of rest.engine.hmac-pin.spec.ts is untouched.
 *
 * Pinned vectors and where they come from:
 *  - Temu, "Signature Method for API request" (partner.temu.com
 *    documentation, Developer Guide, API Integration Guide), the page's own
 *    "Signature Example": app_secret, the parameters, the concatenated
 *    string of step 3 and the sign of step 4 (4CCF2199...).
 *  - Temu, two more digests computed with the function `api_sign_method` of
 *    the page "Temu Open API Request Example with Signature Generation in
 *    Python" (TestSign.py, copied verbatim and run on made-up values).
 *  - SHEIN, "Signature Rules" (open.sheincorp.com, /documents/system/
 *    passwdrule), the page's worked example: openKeyId, secretKey, path,
 *    timestamp, randomKey `test1`, the hex of step 4 and the final signature.
 */
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as unknown as jest.Mock;

const TEMU_DOC = {
  appSecret: 'c7e0a1a63542be4de3cb5488f9fba8149e8fc290',
  appKey: 'f9d5cc9313893a20d5aa85c654e8f503',
  accessToken: '2nifvmpyymvypwmcms5ct4uqqudrwgpmzbcnmkt1jzjkuaf3x56iixym',
  timestamp: 1711009072,
  sign: '4CCF219942D4180C6DDA3CE36C1B838F',
};

/** The signature block a Temu-style adapter declares. */
function temuSignature(secret: string, appKey: string, accessToken: string, extra: Record<string, unknown> = {}) {
  return {
    signature: {
      mode: 'digest',
      algorithm: 'md5',
      encoding: 'hex-upper',
      placement: 'body',
      paramName: 'sign',
      timestampParam: 'timestamp',
      bodyParams: { app_key: appKey, access_token: accessToken, data_type: 'JSON' },
      template: `${secret}\${sortedParams}${secret}`,
      ...extra,
    },
  };
}

describe('RestEngine: plain digest inside the JSON body (Temu)', () => {
  let engine: RestEngine;
  let now: jest.SpyInstance;

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {}, headers: {} });
    engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
    now = jest.spyOn(Date, 'now').mockReturnValue(TEMU_DOC.timestamp * 1000);
  });
  afterEach(() => now.mockRestore());

  const lastCall = () => mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0];
  const temuConfig = (extra: Record<string, unknown> = {}) => ({
    baseUrl: 'https://openapi-b-us.temu.com',
    authType: 'HMAC',
    authConfig: temuSignature(TEMU_DOC.appSecret, TEMU_DOC.appKey, TEMU_DOC.accessToken, extra),
    headers: { 'Content-Type': 'application/json' },
  });

  it("reproduces the sign of Temu's documented example, and sends it in the body", async () => {
    // Nested values in the key order of the page's step 3 string: the JSON
    // text signed for a nested value is the text sent for it.
    const sendRequestList = [
      {
        orderSendInfoList: [
          {
            quantity: 1,
            orderSn: '211-21905473070712792',
            parentOrderSn: 'PO-211-21905452099192792',
            goodsId: 601099548666279,
            skuId: 17592352673534,
          },
        ],
        carrierId: '699272611',
        trackingNumber: '270324232756',
      },
    ];
    await engine.execute(
      temuConfig(),
      {
        method: 'POST',
        path: '/openapi/router',
        bodyMapping: {
          type: 'bg.logistics.shipment.confirm',
          sendType: '$send_type',
          sendRequestList: '$send_request_list',
        },
      } as never,
      { send_type: 0, send_request_list: sendRequestList },
    );
    const cfg = lastCall();
    expect(cfg.url).toBe('https://openapi-b-us.temu.com/openapi/router');
    expect(cfg.method).toBe('POST');
    expect(cfg.data).toEqual({
      type: 'bg.logistics.shipment.confirm',
      sendType: 0,
      sendRequestList,
      app_key: TEMU_DOC.appKey,
      access_token: TEMU_DOC.accessToken,
      data_type: 'JSON',
      timestamp: 1711009072,
      sign: TEMU_DOC.sign,
    });
    // The timestamp is a JSON number, as in the page's request body.
    expect(JSON.stringify(cfg.data)).toContain('"timestamp":1711009072,');
    // Nothing signed travels in the query or a header, and the secret nowhere.
    expect(cfg.params).toEqual({});
    expect(cfg.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.stringify(cfg)).not.toContain(TEMU_DOC.appSecret);
  });

  it('builds exactly the string of step 3 of that page', () => {
    const body = {
      type: 'bg.logistics.shipment.confirm',
      sendType: 0,
      sendRequestList: [
        {
          orderSendInfoList: [
            {
              quantity: 1,
              orderSn: '211-21905473070712792',
              parentOrderSn: 'PO-211-21905452099192792',
              goodsId: 601099548666279,
              skuId: 17592352673534,
            },
          ],
          carrierId: '699272611',
          trackingNumber: '270324232756',
        },
      ],
      app_key: TEMU_DOC.appKey,
      access_token: TEMU_DOC.accessToken,
      data_type: 'JSON',
      timestamp: 1711009072,
      sign: 'left out',
    };
    expect(sortedBodyParamsString(body, 'sign')).toBe(
      'access_token2nifvmpyymvypwmcms5ct4uqqudrwgpmzbcnmkt1jzjkuaf3x56iixym' +
        'app_keyf9d5cc9313893a20d5aa85c654e8f503' +
        'data_typeJSON' +
        'sendRequestList[{"orderSendInfoList":[{"quantity":1,"orderSn":"211-21905473070712792",' +
        '"parentOrderSn":"PO-211-21905452099192792","goodsId":601099548666279,"skuId":17592352673534}],' +
        '"carrierId":"699272611","trackingNumber":"270324232756"}]' +
        'sendType0' +
        'timestamp1711009072' +
        'typebg.logistics.shipment.confirm',
    );
  });

  describe("digests computed with Temu's Python sample (api_sign_method)", () => {
    const config = {
      baseUrl: 'https://openapi-b-global.temu.com',
      authType: 'HMAC',
      authConfig: temuSignature('pin-app-secret', 'pin-app-key', 'pin-access-token'),
    };
    beforeEach(() => now.mockReturnValue(1_760_000_000_000));

    it('the sample request of that page: bg.local.goods.cats.get with parentCatId 0', async () => {
      await engine.execute(
        config,
        { method: 'POST', path: '/openapi/router', bodyMapping: { type: 'bg.local.goods.cats.get', version: 'V1', parentCatId: '$parent_cat_id' } } as never,
        { parent_cat_id: 0 },
      );
      expect(lastCall().data).toEqual({
        type: 'bg.local.goods.cats.get',
        version: 'V1',
        parentCatId: 0,
        app_key: 'pin-app-key',
        access_token: 'pin-access-token',
        data_type: 'JSON',
        timestamp: 1760000000,
        sign: '3873A2F54F8570B2F622BE52482EAE58',
      });
    });

    it('every JSON type, at the top level and nested', async () => {
      const fields = {
        name: 'Größe M 鞋',
        empty: '',
        flag: true,
        off: false,
        nothing: null,
        price: 19.9,
        count: 0,
        big: 601099548666279,
        ids: [3, 1, 2],
        tags: ['b', 'a'],
        nested: { z: 1, a: { k: 'v w', n: null }, list: [{ y: true, x: 'é' }] },
      };
      await engine.execute(
        config,
        { method: 'POST', path: '/openapi/router', bodyTemplate: JSON.stringify({ type: 'pin.types', ...fields }) } as never,
        {},
      );
      expect(lastCall().data).toEqual({
        type: 'pin.types',
        ...fields,
        app_key: 'pin-app-key',
        access_token: 'pin-access-token',
        data_type: 'JSON',
        timestamp: 1760000000,
        sign: '8FB754F106E08461C485B2E9EE0278A5',
      });
    });
  });

  it('serialises each kind of value as documented', () => {
    expect(
      sortedBodyParamsString({
        b: 'text as it is',
        a: 1,
        d: true,
        c: null,
        e: '',
        f: [1, 'x'],
        g: { k: 'v', n: 1.5 },
        h: undefined,
      }),
    ).toBe('a1btext as it iscnulldtrueef[1,"x"]g{"k":"v","n":1.5}');
    // Code unit order: capitals before lower case, as an ASCII sort has them.
    expect(sortedBodyParamsString({ b: 1, B: 2, a: 3, _x: 4 })).toBe('B2_x4a3b1');
    // A top-level string is signed raw, not as JSON text.
    expect(sortedBodyParamsString({ q: 'say "hi"\\now' })).toBe('qsay "hi"\\now');
    expect(sortedBodyParamsString({})).toBe('');
  });

  it('lets the static fields and the timestamp win over a tool field of the same name', async () => {
    await engine.execute(
      temuConfig(),
      { method: 'POST', path: '/openapi/router', bodyMapping: { type: 'x', app_key: '$app_key', timestamp: '$timestamp', sign: '$sign' } } as never,
      { app_key: 'from-the-caller', timestamp: 1, sign: 'from-the-caller' },
    );
    const data = lastCall().data;
    expect(data.app_key).toBe(TEMU_DOC.appKey);
    expect(data.timestamp).toBe(1711009072);
    expect(data.sign).toMatch(/^[0-9A-F]{32}$/);
    expect(data.sign).not.toBe('from-the-caller');
  });

  it('signs a call without fields of its own, and signs again from scratch on a retry', async () => {
    await engine.execute(temuConfig(), { method: 'POST', path: '/openapi/router' } as never, {});
    const first = lastCall().data;
    expect(Object.keys(first).sort()).toEqual(['access_token', 'app_key', 'data_type', 'sign', 'timestamp']);

    // The same fields with a stale signature and timestamp give the same result.
    const again = signedBodyFields({ ...first, sign: 'STALE', timestamp: 5 }, temuConfig().authConfig.signature, '1711009072', 'POST');
    expect(again).toEqual({ ...first, sign: undefined, timestamp: 1711009072 });
    expect('sign' in again).toBe(false);
  });

  it('writes an ISO timestamp as text and a millisecond one as a number', () => {
    expect(signedBodyFields({}, { timestampParam: 't', timestampFormat: 'iso' }, '2026-11-06T07:00:00+00:00', 'POST')).toEqual({
      t: '2026-11-06T07:00:00+00:00',
    });
    expect(signedBodyFields({}, { timestampParam: 't', timestampFormat: 'ms' }, '1711009072123', 'POST')).toEqual({ t: 1711009072123 });
    expect(signedBodyFields({ a: 1 }, { bodyParams: { k: 'v', skip: null } }, '1', 'POST')).toEqual({ a: 1, k: 'v' });
  });

  it('refuses a body it cannot sign: a GET, a form, a list, text', async () => {
    await expect(engine.execute(temuConfig(), { method: 'GET', path: '/openapi/router' } as never, {})).rejects.toThrow(/GET request does not have/);
    await expect(
      engine.execute(
        temuConfig(),
        { method: 'POST', path: '/openapi/router', bodyEncoding: 'form-urlencoded', bodyMapping: { type: 'x' } } as never,
        {},
      ),
    ).rejects.toThrow(/must send a JSON object/);
    expect(() => signedBodyFields([1, 2], {}, '1', 'POST')).toThrow(/must send a JSON object/);
    expect(() => signedBodyFields('text', {}, '1', 'POST')).toThrow(/must send a JSON object/);
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('refuses an unknown mode instead of falling back to an HMAC', async () => {
    await expect(
      engine.execute(temuConfig({ mode: 'plain' }), { method: 'POST', path: '/openapi/router', bodyMapping: { type: 'x' } } as never, {}),
    ).rejects.toThrow(/signature\.mode must be "hmac" or "digest"/);
  });

  it('can place a plain digest in a header or the query too', async () => {
    await engine.execute(
      {
        baseUrl: 'https://api.test',
        authType: 'HMAC',
        authConfig: { signature: { mode: 'digest', algorithm: 'sha1', template: 'k${method}${pathname}k', headerName: 'X-Sign' } },
      },
      { method: 'GET', path: '/a' } as never,
      {},
    );
    expect(lastCall().headers).toEqual({
      'X-Sign': nodeCrypto.createHash('sha1').update('kGET/ak', 'utf8').digest('hex'),
    });

    await engine.execute(
      {
        baseUrl: 'https://api.test',
        authType: 'HMAC',
        authConfig: { signature: { mode: 'digest', algorithm: 'md5', placement: 'query', template: 'k${sortedParams}k' } },
      },
      { method: 'GET', path: '/a', queryParams: { b: '$b' } } as never,
      { b: '2' },
    );
    expect(lastCall().params).toEqual({ b: '2', sign: nodeCrypto.createHash('md5').update('kb2k', 'utf8').digest('hex') });
  });

  it('keeps an explicit mode "hmac" an HMAC', async () => {
    await engine.execute(
      { baseUrl: 'https://api.test', authType: 'HMAC', authConfig: { signature: { mode: 'hmac', secret: 'k', template: '${method}' } } },
      { method: 'GET', path: '/a' } as never,
      {},
    );
    expect(lastCall().headers).toEqual({
      Signature: nodeCrypto.createHmac('sha256', 'k').update('GET', 'utf8').digest('hex'),
    });
  });
});

describe('RestEngine: nonce in the key and a wrapped header value (SHEIN)', () => {
  const SHEIN_DOC = {
    openKeyId: 'B96C15416C9240DF96BAA0BC9B367C6D',
    secretKey: '6BEC9C4B668B4B14B17EEF106BB98AE5',
    path: '/open-api/order/purchase-order-info',
    timestamp: 1740709414000,
    randomKey: 'test1',
    hex: 'd6ca2c789f5307de567f77717fcf098b114aeb415534166e61d0d192ba95acca',
    signature: 'test1ZDZjYTJjNzg5ZjUzMDdkZTU2N2Y3NzcxN2ZjZjA5OGIxMTRhZWI0MTU1MzQxNjZlNjFkMGQxOTJiYTk1YWNjYQ==',
  };
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let engine: RestEngine;
  let now: jest.SpyInstance;
  let random: jest.SpyInstance;

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {}, headers: {} });
    engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
    now = jest.spyOn(Date, 'now').mockReturnValue(SHEIN_DOC.timestamp);
    // The documented example fixes its random key to "test1".
    const picks = [...SHEIN_DOC.randomKey].map((c) => ALPHABET.indexOf(c));
    let i = 0;
    random = jest.spyOn(nodeCrypto, 'randomInt').mockImplementation((() => picks[i++ % picks.length]) as never);
  });
  afterEach(() => {
    now.mockRestore();
    random.mockRestore();
  });

  const sheinSignature = {
    signature: {
      algorithm: 'sha256',
      encoding: 'hex-base64',
      secret: `${SHEIN_DOC.secretKey}\${nonce}`,
      nonceLength: 5,
      template: `${SHEIN_DOC.openKeyId}&\${timestamp}&\${pathname}`,
      timestampFormat: 'ms',
      headerName: 'x-lt-signature',
      headerTemplate: '${nonce}${signature}',
      timestampHeader: 'x-lt-timestamp',
      extraHeaders: { 'x-lt-openKeyId': SHEIN_DOC.openKeyId },
    },
  };

  it("reproduces the signature of SHEIN's documented example", async () => {
    await engine.execute(
      { baseUrl: 'https://openapi.sheincorp.com', authType: 'HMAC', authConfig: sheinSignature },
      { method: 'GET', path: SHEIN_DOC.path, queryParams: { orderNos: '$order_nos' } } as never,
      { order_nos: 'PO1,PO2' },
    );
    const cfg = mockedAxios.mock.calls[0][0];
    expect(cfg.headers).toEqual({
      'x-lt-openKeyId': SHEIN_DOC.openKeyId,
      'x-lt-timestamp': '1740709414000',
      'x-lt-signature': SHEIN_DOC.signature,
    });
    // The query is sent but not signed (the path only), and nothing joins it.
    expect(cfg.params).toEqual({ orderNos: 'PO1,PO2' });
    expect(JSON.stringify(cfg)).not.toContain(SHEIN_DOC.secretKey);
  });

  it('follows the documented steps: HMAC-SHA256 hex with key secret + nonce, Base64 of the hex text, nonce in front', () => {
    const hex = nodeCrypto
      .createHmac('sha256', SHEIN_DOC.secretKey + SHEIN_DOC.randomKey)
      .update(`${SHEIN_DOC.openKeyId}&${SHEIN_DOC.timestamp}&${SHEIN_DOC.path}`, 'utf8')
      .digest('hex');
    expect(hex).toBe(SHEIN_DOC.hex);
    expect(renderSignatureHeader('${nonce}${signature}', Buffer.from(hex, 'utf8').toString('base64'), SHEIN_DOC.randomKey)).toBe(
      SHEIN_DOC.signature,
    );
  });

  it('draws a new nonce of the asked length for every signature', () => {
    random.mockRestore();
    const a = signatureNonce(5);
    expect(a).toMatch(/^[A-Za-z0-9]{5}$/);
    expect(signatureNonce(64)).toMatch(/^[A-Za-z0-9]{64}$/);
    const many = new Set(Array.from({ length: 50 }, () => signatureNonce(8)));
    expect(many.size).toBeGreaterThan(45);
    for (const bad of [0, 65, 2.5, 'x', null]) expect(() => signatureNonce(bad)).toThrow(/nonceLength/);
  });

  it('renders the header template in one pass', () => {
    expect(renderSignatureHeader('v1 ${signature}', 'abc', undefined)).toBe('v1 abc');
    expect(renderSignatureHeader('${nonce}.${signature}', '${nonce}', 'N')).toBe('N.${nonce}');
    expect(renderSignatureHeader('${nonce}${signature}', 'abc', undefined)).toBe('abc');
  });
});

describe('the new signature options are opt-in', () => {
  it('switch the extended path on only when one of them is set', () => {
    // A signature written before them: still the original code path.
    expect(usesExtendedHmac({ secret: 'k', template: '${method}\n${url}\n${body}\n${timestamp}', encoding: 'base64' })).toBe(false);
    // A header template without ${signature} is not one of ours (the JWT one has ${jwt}).
    expect(usesExtendedHmac({ secret: 'k', headerTemplate: 'Bearer ${jwt}' })).toBe(false);
    expect(usesExtendedHmac({ mode: 'digest' })).toBe(true);
    expect(usesExtendedHmac({ mode: 'hmac' })).toBe(true);
    expect(usesExtendedHmac({ bodyParams: {} })).toBe(true);
    expect(usesExtendedHmac({ placement: 'body' })).toBe(true);
    expect(usesExtendedHmac({ nonceLength: 5 })).toBe(true);
    expect(usesExtendedHmac({ headerTemplate: '${nonce}${signature}' })).toBe(true);
    expect(usesExtendedHmac({ encoding: 'hex-base64' })).toBe(true);
  });

  it('leave ${nonce} in a template alone without nonceLength', () => {
    const vars = { method: 'GET', url: 'u', path: 'p', pathname: 'p', body: '', timestamp: '1', query: {} };
    expect(renderExtendedHmacTemplate('${method}:${nonce}', vars)).toBe('GET:${nonce}');
    expect(renderExtendedHmacTemplate('${method}:${nonce}', { ...vars, nonce: 'abc12' })).toBe('GET:abc12');
  });
});
