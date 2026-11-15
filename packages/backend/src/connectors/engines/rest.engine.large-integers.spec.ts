import axios from 'axios';
import { RestEngine } from './rest.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import { LoginTokenService } from './login-token.service';
import { ResponseBodyError } from './response-error.util';

/**
 * The two 64-bit integer opt-ins through the real engine:
 * `config.largeIntegers: "string"` on the answer side and
 * `endpointMapping.bodyIntegers` on the request side. Without them a
 * connector parses and sends exactly as before.
 */
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as unknown as jest.Mock;

const BIG = '5230236437987443003';
const JSON_HEADERS = { 'content-type': 'application/json;charset=UTF-8' };

/** Answers through the engine's own transformResponse, as axios would. */
function answer(text: string, status = 200) {
  mockedAxios.mockImplementation(async (cfg: { transformResponse: Array<(d: unknown, h: unknown) => unknown> }) => {
    const data = cfg.transformResponse.reduce((d, fn) => fn(d, JSON_HEADERS), Buffer.from(text, 'utf8') as unknown);
    if (status >= 400) {
      const { AxiosError } = jest.requireActual('axios');
      const err = new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_RESPONSE', cfg as never, {}, {
        status,
        data,
        headers: JSON_HEADERS,
        statusText: 'x',
        config: cfg,
      } as never);
      throw err;
    }
    return { status, data, headers: JSON_HEADERS };
  });
}

const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
const base = { baseUrl: 'https://api.test', authType: 'NONE', headers: { 'Content-Type': 'application/json' } };
const sent = () => mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0];

describe('RestEngine: config.largeIntegers', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('"string" keeps unsafe integers of the answer exact, everything else as JSON.parse reads it', async () => {
    answer(`{"code":"0","info":{"goodsId":${BIG},"qty":2,"price":19.99,"note":"${BIG}"}}`);
    const out = await engine().execute({ ...base, largeIntegers: 'string' }, { method: 'GET', path: '/o' }, {});
    expect(out).toEqual({ code: '0', info: { goodsId: BIG, qty: 2, price: 19.99, note: BIG } });
  });

  it('without the option an answer is parsed exactly as before (rounded)', async () => {
    const text = `{"info":{"goodsId":${BIG}}}`;
    answer(text);
    const out = (await engine().execute(base, { method: 'GET', path: '/o' }, {})) as { info: { goodsId: unknown } };
    expect(out).toEqual(JSON.parse(text));
    expect(typeof out.info.goodsId).toBe('number');
    // Any other value is not the opt-in either.
    answer(text);
    expect(await engine().execute({ ...base, largeIntegers: 'yes' }, { method: 'GET', path: '/o' }, {})).toEqual(JSON.parse(text));
  });

  it('the errorWhen rules and an HTTP error body see the exact digits too', async () => {
    const errorWhen = [{ path: 'code', matches: '^(?!0$).+', messagePath: ['code', 'msg'], status: 400 }];
    answer(`{"code":"9999400","msg":"bad","info":{"goodsId":${BIG}}}`);
    const err = await engine()
      .execute({ ...base, largeIntegers: 'string', errorWhen }, { method: 'GET', path: '/o' }, {})
      .catch((e) => e);
    expect(err).toBeInstanceOf(ResponseBodyError);
    expect((err as ResponseBodyError).responseBody).toEqual({ code: '9999400', msg: 'bad', info: { goodsId: BIG } });

    answer(`{"code":"x","goodsId":${BIG}}`, 422);
    const httpErr = (await engine()
      .execute({ ...base, largeIntegers: 'string' }, { method: 'GET', path: '/o' }, {})
      .catch((e) => e)) as { response: { data: unknown } };
    expect(httpErr.response.data).toEqual({ code: 'x', goodsId: BIG });
  });

  it('text that is not JSON is handed back as text, as before', async () => {
    answer('upstream says no 12345678901234567890');
    expect(await engine().execute({ ...base, largeIntegers: 'string' }, { method: 'GET', path: '/o' }, {})).toBe(
      'upstream says no 12345678901234567890',
    );
  });
});

describe('RestEngine: endpointMapping.bodyIntegers', () => {
  beforeEach(() => {
    mockedAxios.mockReset();
    answer('{"code":"0"}');
  });

  const mapping = {
    method: 'POST',
    path: '/upload',
    bodyMapping: { orderNo: '$order_no', infoList: '$items', goodsIdList: '$ids' },
    bodyIntegers: ['infoList[].goodsId', 'goodsIdList[]'],
  };

  it('writes the digit strings as number literals with the same digits', async () => {
    await engine().execute(base, mapping, {
      order_no: 'GSON1',
      items: [{ goodsId: BIG, expressCode: '1Z999AA10123456784', status: 2 }],
      ids: [BIG, '42'],
    });
    const cfg = sent();
    expect(typeof cfg.data).toBe('string');
    expect(cfg.data).toBe(
      `{"orderNo":"GSON1","infoList":[{"goodsId":${BIG},"expressCode":"1Z999AA10123456784","status":2}],"goodsIdList":[${BIG},42]}`,
    );
    expect(cfg.headers['Content-Type']).toBe('application/json');
  });

  it('refuses a value that is not a whole number, before sending', async () => {
    await expect(engine().execute(base, mapping, { order_no: 'G', items: [{ goodsId: '12x' }] })).rejects.toThrow(
      /infoList\[\]\.goodsId must be a whole number/,
    );
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('without bodyIntegers the body stays the object axios serializes, as before', async () => {
    const { bodyIntegers: _b, ...plain } = mapping;
    await engine().execute(base, plain, { order_no: 'G', items: [{ goodsId: BIG }] });
    expect(sent().data).toEqual({ orderNo: 'G', infoList: [{ goodsId: BIG }] });
  });
});
