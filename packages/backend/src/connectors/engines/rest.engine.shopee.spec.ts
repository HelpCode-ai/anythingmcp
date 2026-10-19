import axios, { AxiosError } from 'axios';
import { RestEngine, usesExtendedHmac, renderExtendedHmacTemplate } from './rest.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import { LoginTokenService } from './login-token.service';
import { ShopeeTokenService } from './shopee-token.service';
import { listAdapters, getAdapter } from '../../adapters/catalog';

/**
 * Query-placed HMAC signing (opt-in, Shopee Open Platform v2) through the
 * real engine. Expected signatures are the vendor's documented base string
 * (developer guide "API calls": partner_id + api_path + timestamp +
 * access_token + shop_id) hashed independently with Python's hmac module,
 * not values read back from the engine.
 */
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as unknown as jest.Mock;

const shopee = getAdapter('shopee')!;
const KEY = 'test_partner_key_123';

/** The adapter's authConfig with its variables filled in, as the tool path resolves it. */
function shopeeAuth(): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(shopee.connector.authConfig)
      .split('{{SHOPEE_PARTNER_KEY}}')
      .join(KEY)
      .split('{{SHOPEE_PARTNER_ID}}')
      .join('2001887'),
  );
}

function fakeTokens(params = { access_token: '59777174636562737266615546704c6d', shop_id: '14701711' }) {
  return {
    getShopParams: jest.fn().mockResolvedValue(params),
    renewAfterRejection: jest.fn(),
  } as unknown as jest.Mocked<ShopeeTokenService>;
}

describe('RestEngine: query-signed HMAC (Shopee)', () => {
  let now: jest.SpyInstance;
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { error: '', message: '', response: {} }, headers: {} });
    now = jest.spyOn(Date, 'now').mockReturnValue(1655714431 * 1000);
  });
  afterEach(() => now.mockRestore());

  const run = async (
    tokens: jest.Mocked<ShopeeTokenService>,
    toolName: string,
    params: Record<string, unknown>,
  ) => {
    const tool = shopee.tools.find((t) => t.name === toolName)!;
    const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService, undefined, tokens);
    await engine.execute(
      {
        baseUrl: 'https://partner.shopeemobile.com',
        authType: shopee.connector.authType,
        authConfig: shopeeAuth(),
        headers: shopee.connector.headers,
        connectorId: 'conn-shopee',
      },
      tool.endpointMapping as never,
      params,
    );
    return mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0];
  };

  it("reproduces the signature of Shopee's documented shop call", async () => {
    const tokens = fakeTokens();
    const cfg = await run(tokens, 'shopee_get_shop_info', {});
    // Base string from the guide: 2001887/api/v2/shop/get_shop_info1655714431
    // 59777174636562737266615546704c6d14701711; hmac-sha256 with KEY, hex.
    expect(cfg.url).toBe('https://partner.shopeemobile.com/api/v2/shop/get_shop_info');
    expect(cfg.params).toEqual({
      partner_id: '2001887',
      access_token: '59777174636562737266615546704c6d',
      shop_id: '14701711',
      timestamp: '1655714431',
      sign: '5467e060121e23b60d133a13b2972253695985bf3395b5c088537806fd835e72',
    });
    // Nothing in a header: no Signature header, no key anywhere on the wire.
    expect(Object.keys(cfg.headers)).toEqual(['Accept', 'Content-Type', 'User-Agent']);
    expect(JSON.stringify(cfg)).not.toContain(KEY);
    // The query axios sends is the one signed.
    const realAxios = (jest.requireActual('axios') as { default: typeof axios }).default;
    expect(realAxios.getUri(cfg)).toBe(
      'https://partner.shopeemobile.com/api/v2/shop/get_shop_info?partner_id=2001887' +
        '&access_token=59777174636562737266615546704c6d&shop_id=14701711&timestamp=1655714431' +
        '&sign=5467e060121e23b60d133a13b2972253695985bf3395b5c088537806fd835e72',
    );
    expect(tokens.getShopParams).toHaveBeenCalledWith(expect.objectContaining({ connectorId: 'conn-shopee' }));
  });

  it('signs the path only: tool parameters and the body are not part of the string', async () => {
    const tokens = fakeTokens();
    const cfg = await run(tokens, 'shopee_list_items', { offset: 0, page_size: 20, item_status: ['NORMAL', 'UNLIST'] });
    // Independent: hmac(KEY, "2001887/api/v2/product/get_item_list1655714431<token><shop>")
    const crypto = jest.requireActual('node:crypto') as typeof import('node:crypto');
    const expected = crypto
      .createHmac('sha256', KEY)
      .update('2001887/api/v2/product/get_item_list165571443159777174636562737266615546704c6d14701711')
      .digest('hex');
    expect(cfg.params.sign).toBe(expected);
    expect(cfg.paramsSerializer(cfg.params)).toBe(
      'offset=0&page_size=20&item_status=NORMAL&item_status=UNLIST&partner_id=2001887' +
        '&access_token=59777174636562737266615546704c6d&shop_id=14701711&timestamp=1655714431&sign=' +
        expected,
    );

    mockedAxios.mockClear();
    const post = await run(tokens, 'shopee_update_stock', {
      item_id: 800000001,
      stock_list: [{ model_id: 0, seller_stock: [{ stock: 5 }] }],
    });
    expect(post.method).toBe('POST');
    expect(post.data).toEqual({ item_id: 800000001, stock_list: [{ model_id: 0, seller_stock: [{ stock: 5 }] }] });
    expect(post.params.sign).toBe(
      crypto
        .createHmac('sha256', KEY)
        .update('2001887/api/v2/product/update_stock165571443159777174636562737266615546704c6d14701711')
        .digest('hex'),
    );
  });

  it("a tool's own parameter cannot replace a credential", async () => {
    const tokens = fakeTokens();
    const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService, undefined, tokens);
    await engine.execute(
      { baseUrl: 'https://partner.shopeemobile.com', authType: 'HMAC', authConfig: shopeeAuth(), connectorId: 'c' },
      {
        method: 'GET',
        path: '/api/v2/shop/get_shop_info',
        queryParams: { shop_id: '$shop_id', partner_id: '$partner_id', sign: '$sign' },
      } as never,
      { shop_id: '1', partner_id: '2', sign: 'x' },
    );
    const cfg = mockedAxios.mock.calls[0][0];
    expect(cfg.params.shop_id).toBe('14701711');
    expect(cfg.params.partner_id).toBe('2001887');
    expect(cfg.params.sign).toBe('5467e060121e23b60d133a13b2972253695985bf3395b5c088537806fd835e72');
  });

  it('renews and signs again once when Shopee refuses the access token', async () => {
    const tokens = fakeTokens();
    tokens.renewAfterRejection.mockResolvedValue({ access_token: 'fresh-token', shop_id: '14701711' });
    const refused = new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 403,
      data: { error: 'invalid_acceess_token', message: 'Invalid access_token, please have a check.' },
    } as never);
    mockedAxios.mockRejectedValueOnce(refused).mockResolvedValueOnce({ data: { error: '', response: {} }, headers: {} });

    await run(tokens, 'shopee_get_shop_info', {});
    expect(mockedAxios).toHaveBeenCalledTimes(2);
    const retry = mockedAxios.mock.calls[1][0];
    expect(retry.params.access_token).toBe('fresh-token');
    const crypto = jest.requireActual('node:crypto') as typeof import('node:crypto');
    expect(retry.params.sign).toBe(
      crypto.createHmac('sha256', KEY).update('2001887/api/v2/shop/get_shop_info1655714431fresh-token14701711').digest('hex'),
    );
    expect(Object.keys(retry.params).filter((k) => k === 'sign')).toHaveLength(1);
    expect(tokens.renewAfterRejection).toHaveBeenCalledTimes(1);
  });

  it('a 200 answer with an error code is an error, and a token error is retried the same way', async () => {
    const tokens = fakeTokens();
    tokens.renewAfterRejection.mockResolvedValue(null);
    mockedAxios.mockResolvedValue({
      data: { error: 'invalid_acceess_token', message: 'Invalid access_token, please have a check.', request_id: 'r' },
      headers: {},
    });
    const tool = shopee.tools.find((t) => t.name === 'shopee_get_shop_info')!;
    const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService, undefined, tokens);
    await expect(
      engine.execute(
        {
          baseUrl: 'https://partner.shopeemobile.com',
          authType: 'HMAC',
          authConfig: shopeeAuth(),
          connectorId: 'c',
          errorWhen: (shopee.connector.config as { errorWhen: unknown }).errorWhen,
        },
        tool.endpointMapping as never,
        {},
      ),
    ).rejects.toMatchObject({ status: 401, message: expect.stringContaining('invalid_acceess_token') });
    expect(tokens.renewAfterRejection).toHaveBeenCalledTimes(1);
  });
});

describe('extended HMAC template', () => {
  it('substitutes in one pass, so a value is never read as another variable', () => {
    expect(
      renderExtendedHmacTemplate('${query.a}|${pathname}|${path}|${timestamp}|${query.missing}|${method}\\n', {
        method: 'GET',
        url: 'https://h/p?a=1',
        path: '/p?a=1',
        pathname: '/p',
        body: '',
        timestamp: '9',
        query: { a: '${body}${timestamp}' },
      }),
    ).toBe('${body}${timestamp}|/p|/p?a=1|9||GET\n');
  });
});

describe('opt-in: adapters signed before query signing keep the original path', () => {
  const NEW_FIELDS = ['placement', 'paramName', 'timestampParam', 'queryParams'];

  it('every catalog HMAC adapter except shopee uses none of the new fields', () => {
    const hmac = listAdapters()
      .map((m) => getAdapter(m.slug)!)
      .filter((a) => a.connector.authType === 'HMAC');
    expect(hmac.map((a) => a.slug).sort()).toEqual(['kaufland', 'shopee']);
    for (const a of hmac.filter((x) => x.slug !== 'shopee')) {
      const sig = (a.connector.authConfig as { signature: Record<string, unknown> }).signature;
      expect(NEW_FIELDS.filter((f) => f in sig)).toEqual([]);
      expect(usesExtendedHmac(sig)).toBe(false);
      expect((a.connector.authConfig as Record<string, unknown>).tokenProvider).toBeUndefined();
    }
  });

  it('kaufland never asks a token provider and gets no query parameters', async () => {
    const tokens = fakeTokens();
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {}, headers: {} });
    const kaufland = getAdapter('kaufland')!;
    const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService, undefined, tokens);
    const auth = JSON.parse(
      JSON.stringify(kaufland.connector.authConfig)
        .replace('{{KAUFLAND_SECRET_KEY}}', 's')
        .replace('{{KAUFLAND_CLIENT_KEY}}', 'c'),
    );
    await engine.execute(
      { baseUrl: 'https://sellerapi.kaufland.com/v2', authType: 'HMAC', authConfig: auth, connectorId: 'k' },
      kaufland.tools.find((t) => t.name === 'kaufland_list_warehouses')!.endpointMapping as never,
      {},
    );
    expect(tokens.getShopParams).not.toHaveBeenCalled();
    const cfg = mockedAxios.mock.calls[0][0];
    expect(cfg.params).toBeUndefined();
    expect(cfg.headers['Shop-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });
});
