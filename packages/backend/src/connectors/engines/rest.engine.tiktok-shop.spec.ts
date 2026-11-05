import axios, { AxiosError } from 'axios';
import FormData from 'form-data';
import { RestEngine } from './rest.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import { LoginTokenService } from './login-token.service';
import { TikTokShopTokenService } from './tiktok-shop-token.service';
import { getAdapter } from '../../adapters/catalog';

/**
 * TikTok Shop signing through the real engine and the catalog adapter's
 * template. Expected signatures were computed independently with Python's
 * hmac module from TikTok Shop's guide "Sign your API request" (query
 * except sign and access_token, sorted, key + value, after the path, then
 * the body, wrapped in the app secret, HMAC-SHA256, hex), not read back
 * from the engine.
 */
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
jest.mock('../../common/outbound-fetch.util', () => ({
  fetchOutbound: jest.fn(async () => ({
    body: Buffer.from('fake-png'),
    headers: { 'content-type': 'image/png' },
    finalUrl: 'https://example.org/p.png',
  })),
}));
const mockedAxios = axios as unknown as jest.Mock;

const tts = getAdapter('tiktok-shop')!;
const SECRET = 'testappsecret1234567890';
const CIPHER = 'GCP_XF90igAAAABh00qsWgtvOiGFNqyubMt3';
const TOKEN = 'TTP_access_token_1';

function ttsAuth(): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(tts.connector.authConfig)
      .split('{{TIKTOK_SHOP_APP_SECRET}}')
      .join(SECRET)
      .split('{{TIKTOK_SHOP_APP_KEY}}')
      .join('38abcd')
      .split('{{TIKTOK_SHOP_SERVICE_ID}}')
      .join('7256213'),
  );
}

function fakeTokens(creds = { accessToken: TOKEN, shopCipher: CIPHER }) {
  return {
    getShopCredentials: jest.fn().mockResolvedValue(creds),
    renewAfterRejection: jest.fn(),
  } as unknown as jest.Mocked<TikTokShopTokenService>;
}

describe('RestEngine: TikTok Shop signing', () => {
  let now: jest.SpyInstance;
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { code: 0, message: 'Success', data: {} }, headers: {} });
    now = jest.spyOn(Date, 'now').mockReturnValue(1623812664 * 1000);
  });
  afterEach(() => now.mockRestore());

  const run = async (tokens: jest.Mocked<TikTokShopTokenService>, toolName: string, params: Record<string, unknown>) => {
    const tool = tts.tools.find((t) => t.name === toolName)!;
    const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService, undefined, undefined, tokens);
    await engine.execute(
      {
        baseUrl: tts.connector.baseUrl,
        authType: tts.connector.authType,
        authConfig: ttsAuth(),
        headers: tts.connector.headers,
        connectorId: 'conn-tts',
        errorWhen: (tts.connector as { config?: { errorWhen?: unknown } }).config?.errorWhen,
      },
      tool.endpointMapping as never,
      params,
    );
    return mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0];
  };

  it('signs Get Authorized Shops without shop_cipher and sends the token in its header', async () => {
    const tokens = fakeTokens();
    const cfg = await run(tokens, 'tiktok_shop_get_authorized_shops', {});
    expect(cfg.url).toBe('https://open-api.tiktokglobalshop.com/authorization/202309/shops');
    expect(cfg.params).toEqual({
      app_key: '38abcd',
      timestamp: '1623812664',
      sign: '77c8ca20f976b6e452547ae263fcf04d72800f32da727bf78067f355b55c3e89',
    });
    expect(cfg.headers['x-tts-access-token']).toBe(TOKEN);
    expect(JSON.stringify(cfg)).not.toContain(SECRET);
  });

  it('signs a POST with the shop cipher, the tool query and the JSON body', async () => {
    const cfg = await run(fakeTokens(), 'tiktok_shop_search_orders', {
      page_size: 20,
      order_status: 'AWAITING_SHIPMENT',
      create_time_ge: 1700000000,
    });
    expect(cfg.method).toBe('POST');
    expect(cfg.data).toEqual({ order_status: 'AWAITING_SHIPMENT', create_time_ge: 1700000000 });
    expect(cfg.params).toEqual({
      page_size: 20,
      app_key: '38abcd',
      shop_cipher: CIPHER,
      timestamp: '1623812664',
      sign: 'c522cb92b116fbafbff34432d13a1ffebbbee958bb6504f8cdaffeece89583a5',
    });
  });

  it('signs a GET whose query carries comma-separated ids', async () => {
    const cfg = await run(fakeTokens(), 'tiktok_shop_get_orders', { ids: '576461413038785752,576461413038785753' });
    expect(cfg.params.sign).toBe('8e76c8eaf99a005e1ad2e3ecaf8dc83388f43342d28eb7b06f336ce356f46cb7');
    expect(cfg.params.shop_cipher).toBe(CIPHER);
  });

  it('signs an image upload without its multipart body and without shop_cipher', async () => {
    const cfg = await run(fakeTokens(), 'tiktok_shop_upload_product_image', {
      image_url: 'https://example.org/p.png',
      use_case: 'MAIN_IMAGE',
    });
    expect(cfg.data).toBeInstanceOf(FormData);
    expect(cfg.params).toEqual({
      app_key: '38abcd',
      timestamp: '1623812664',
      sign: '67285892734f91fc106a00e6e6639b4706522a61fdacda0501da5fb9ffa71d36',
    });
    // The connector's JSON Content-Type gives way to the form's, as axios merges headers.
    const { AxiosHeaders } = jest.requireActual('axios') as typeof import('axios');
    expect(String(AxiosHeaders.from(cfg.headers).get('content-type'))).toMatch(/^multipart\/form-data; boundary=/);
  });

  it('turns a non-zero code in a 200 answer into an error', async () => {
    mockedAxios.mockResolvedValueOnce({ data: { code: 106001, message: 'Invalid credentials. The sign query parameter is invalid.' }, headers: {} });
    await expect(run(fakeTokens(), 'tiktok_shop_list_warehouses', {})).rejects.toMatchObject({ status: 401 });
  });

  it('renews an expired access token once, signs again and resends', async () => {
    const tokens = fakeTokens();
    tokens.renewAfterRejection.mockResolvedValue({ accessToken: 'TTP_access_token_2', shopCipher: CIPHER });
    const expired = new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config: {} as never,
      data: { code: 105002, message: 'Expired credentials.' },
    });
    mockedAxios.mockRejectedValueOnce(expired);
    const cfg = await run(tokens, 'tiktok_shop_list_warehouses', {});
    expect(tokens.renewAfterRejection).toHaveBeenCalledTimes(1);
    expect(mockedAxios).toHaveBeenCalledTimes(2);
    expect(cfg.headers['x-tts-access-token']).toBe('TTP_access_token_2');
    expect(cfg.params.shop_cipher).toBe(CIPHER);
    expect(Object.keys(cfg.params).filter((k) => k === 'sign')).toHaveLength(1);
  });
});
