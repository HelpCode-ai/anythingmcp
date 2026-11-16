import axios, { AxiosError } from 'axios';
import { RestEngine } from './rest.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import { LoginTokenService } from './login-token.service';
import { IopTokenService } from './iop-token.service';

/**
 * The "iop" token provider through the real engine (Lazada, Miravia,
 * AliExpress seller): the seller's access token joins the signed query, a
 * call refused with 401 for its token is renewed once and resent once, and
 * every connector without `tokenProvider: "iop"` never touches the provider.
 *
 * The expected signature is the worked example of Miravia's "Call API with
 * HTTP request" page (docId 216; the same recipe as Lazada's): app key
 * 123456, secret helloworld, token test, timestamp 1517820392000, /order/get
 * with order_id 1234.
 */
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as unknown as jest.Mock;

const DOC_TIMESTAMP = 1517820392000;
const DOC_SIGNATURE = '4190D32361CFB9581350222F345CB77F3B19F0E31D162316848A2C1FFD5FAB4A';

const signature = {
  algorithm: 'sha256',
  encoding: 'hex-upper',
  secret: 'helloworld',
  placement: 'query',
  paramName: 'sign',
  timestampParam: 'timestamp',
  timestampFormat: 'ms',
  queryParams: { app_key: '123456', sign_method: 'sha256' },
  template: '${apiPath}${sortedParams}',
};
const iopAuth = {
  tokenProvider: 'iop',
  iop: {
    appKey: '123456',
    authorizeUrl: 'https://auth.miravia.com/apps/oauth/authorize',
    tokenBaseUrl: 'https://api.miravia.es/rest',
    tokenPath: '/auth/token/create',
    refreshPath: '/auth/token/refresh',
  },
  signature,
};
// The adapter's rules: an IOP error code in a 200 answer.
const errorWhen = [
  { path: 'code', matches: 'AccessToken|RefreshToken|AppKey|Signature|IllegalTimestamp', messagePath: ['code', 'message'], status: 401 },
  { path: 'code', matches: '^(?!0$).+', messagePath: ['code', 'message'], status: 400 },
];

function fakeTokens(token = 'test') {
  return {
    getCredentialParams: jest.fn().mockResolvedValue({ access_token: token }),
    renewAfterRejection: jest.fn(),
  } as unknown as jest.Mocked<IopTokenService>;
}

const engineWith = (tokens?: IopTokenService) =>
  new RestEngine({} as OAuth2TokenService, {} as LoginTokenService, undefined, undefined, undefined, tokens);

const run = (engine: RestEngine, authConfig: Record<string, unknown> = iopAuth) =>
  engine.execute(
    {
      baseUrl: 'https://api.miravia.es/rest',
      authType: 'HMAC',
      authConfig,
      headers: { Accept: 'application/json' },
      connectorId: 'conn-1',
      errorWhen,
    },
    { method: 'GET', path: '/order/get', queryParams: { order_id: '$order_id' } },
    { order_id: '1234' },
  );

describe('RestEngine: the "iop" token provider', () => {
  let now: jest.SpyInstance;
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { code: '0', data: { order_id: 1234 } }, headers: {} });
    now = jest.spyOn(Date, 'now').mockReturnValue(DOC_TIMESTAMP);
  });
  afterEach(() => now.mockRestore());

  it("signs the seller's access token into the query (Miravia's documented example)", async () => {
    const tokens = fakeTokens();
    expect(await run(engineWith(tokens))).toEqual({ code: '0', data: { order_id: 1234 } });
    expect(tokens.getCredentialParams).toHaveBeenCalledWith(expect.objectContaining({ connectorId: 'conn-1', authConfig: iopAuth }));
    const cfg = mockedAxios.mock.calls[0][0];
    expect(cfg.url).toBe('https://api.miravia.es/rest/order/get');
    expect(cfg.params).toEqual({
      order_id: '1234',
      app_key: '123456',
      sign_method: 'sha256',
      access_token: 'test',
      timestamp: String(DOC_TIMESTAMP),
      sign: DOC_SIGNATURE,
    });
    expect(JSON.stringify(cfg)).not.toContain('helloworld');
  });

  it('a call refused for its token (errorWhen 401) is renewed once, signed again and resent once', async () => {
    const tokens = fakeTokens('expired');
    tokens.renewAfterRejection.mockResolvedValueOnce({ access_token: 'test' });
    mockedAxios
      .mockResolvedValueOnce({ data: { code: 'IllegalAccessToken', type: 'ISV', message: 'The specified access token is invalid or expired' }, headers: {} })
      .mockResolvedValueOnce({ data: { code: '0', data: { ok: true } }, headers: {} });
    expect(await run(engineWith(tokens))).toEqual({ code: '0', data: { ok: true } });
    expect(tokens.renewAfterRejection).toHaveBeenCalledTimes(1);
    expect(tokens.renewAfterRejection).toHaveBeenCalledWith(expect.objectContaining({ connectorId: 'conn-1' }), DOC_TIMESTAMP);
    expect(mockedAxios).toHaveBeenCalledTimes(2);
    expect(mockedAxios.mock.calls[0][0].params.access_token).toBe('expired');
    // The resent call carries the new token and the signature over it.
    expect(mockedAxios.mock.calls[1][0].params).toEqual({
      order_id: '1234',
      app_key: '123456',
      sign_method: 'sha256',
      access_token: 'test',
      timestamp: String(DOC_TIMESTAMP),
      sign: DOC_SIGNATURE,
    });
  });

  it('resends only once: a second refusal is reported', async () => {
    const tokens = fakeTokens('a');
    tokens.renewAfterRejection.mockResolvedValue({ access_token: 'b' });
    mockedAxios.mockResolvedValue({ data: { code: 'IllegalAccessToken', message: 'invalid' }, headers: {} });
    await expect(run(engineWith(tokens))).rejects.toMatchObject({ status: 401 });
    expect(tokens.renewAfterRejection).toHaveBeenCalledTimes(1);
    expect(mockedAxios).toHaveBeenCalledTimes(2);
  });

  it('reports the refusal when no new token can be had', async () => {
    const tokens = fakeTokens();
    tokens.renewAfterRejection.mockResolvedValueOnce(null);
    mockedAxios.mockResolvedValueOnce({ data: { code: 'IllegalAccessToken', message: 'invalid' }, headers: {} });
    await expect(run(engineWith(tokens))).rejects.toThrow(/IllegalAccessToken/);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
  });

  it('also renews on an HTTP 401', async () => {
    const tokens = fakeTokens();
    tokens.renewAfterRejection.mockResolvedValueOnce({ access_token: 'test' });
    const unauthorized = new AxiosError('Request failed with status code 401', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 401,
      data: 'Unauthorized',
      headers: {},
      statusText: 'Unauthorized',
      config: {} as never,
    });
    mockedAxios.mockRejectedValueOnce(unauthorized).mockResolvedValueOnce({ data: { code: '0' }, headers: {} });
    expect(await run(engineWith(tokens))).toEqual({ code: '0' });
    expect(tokens.renewAfterRejection).toHaveBeenCalledTimes(1);
  });

  it('does not spend a renewal on a bad signature, app key or timestamp', async () => {
    const tokens = fakeTokens();
    mockedAxios.mockResolvedValueOnce({ data: { code: 'IncompleteSignature', message: 'The request signature does not conform' }, headers: {} });
    await expect(run(engineWith(tokens))).rejects.toMatchObject({ status: 401 });
    expect(tokens.renewAfterRejection).not.toHaveBeenCalled();
    expect(mockedAxios).toHaveBeenCalledTimes(1);
  });

  it('refuses plainly when the provider is not available', async () => {
    await expect(run(engineWith(undefined))).rejects.toThrow(/need the IOP token service/);
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('a connector without tokenProvider "iop" never asks the provider and signs as before', async () => {
    const tokens = fakeTokens();
    // The existing AliExpress adapters: a pasted token as a static signed parameter.
    const pasted = { signature: { ...signature, queryParams: { ...signature.queryParams, access_token: 'test' } } };
    await run(engineWith(tokens), pasted);
    expect(tokens.getCredentialParams).not.toHaveBeenCalled();
    const withProvider = mockedAxios.mock.calls[0][0].params;
    expect(withProvider).toEqual({
      order_id: '1234',
      app_key: '123456',
      sign_method: 'sha256',
      access_token: 'test',
      timestamp: String(DOC_TIMESTAMP),
      sign: DOC_SIGNATURE,
    });
    // The same call through an engine built without the provider: byte for byte the same request.
    mockedAxios.mockClear();
    await run(engineWith(undefined), pasted);
    expect(mockedAxios.mock.calls[0][0].params).toEqual(withProvider);

    // A refusal on such a connector is not retried through the provider.
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValueOnce({ data: { code: 'IllegalAccessToken', message: 'expired' }, headers: {} });
    await expect(run(engineWith(tokens), pasted)).rejects.toMatchObject({ status: 401 });
    expect(tokens.renewAfterRejection).not.toHaveBeenCalled();
    expect(mockedAxios).toHaveBeenCalledTimes(1);

    // Other token providers are not routed here either.
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { code: '0' }, headers: {} });
    const shopeeTokens = { getShopParams: jest.fn().mockResolvedValue({ access_token: 'x', shop_id: '1' }), renewAfterRejection: jest.fn() };
    await new RestEngine({} as OAuth2TokenService, {} as LoginTokenService, undefined, shopeeTokens as never, undefined, tokens).execute(
      { baseUrl: 'https://partner.shopeemobile.com', authType: 'HMAC', authConfig: { tokenProvider: 'shopee', signature }, connectorId: 'c' },
      { method: 'GET', path: '/api/v2/shop/get_shop_info' },
      {},
    );
    expect(shopeeTokens.getShopParams).toHaveBeenCalledTimes(1);
    expect(tokens.getCredentialParams).not.toHaveBeenCalled();
  });
});
