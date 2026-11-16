import axios from 'axios';
// The default import is the module object itself, so a spy on it is seen by
// the engine (a namespace import would be a copy).
import nodeCrypto from 'node:crypto';
import { RestEngine } from './rest.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import { LoginTokenService } from './login-token.service';
import { SheinTokenService } from './shein-token.service';

/**
 * The "shein" token provider through the real engine: the shop's openKeyId
 * and secretKey, stored on the connector by the authorization, sign every
 * call (SHEIN's "Signature Rules", pinned to the page's worked example), a
 * call SHEIN refuses for an ended key marks the connector through the
 * provider, and every connector without `tokenProvider: "shein"` never
 * touches the provider and signs exactly as before.
 */
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as unknown as jest.Mock;

const DOC = {
  openKeyId: 'B96C15416C9240DF96BAA0BC9B367C6D',
  secretKey: '6BEC9C4B668B4B14B17EEF106BB98AE5',
  path: '/open-api/order/purchase-order-info',
  timestamp: 1740709414000,
  randomKey: 'test1',
  signature: 'test1ZDZjYTJjNzg5ZjUzMDdkZTU2N2Y3NzcxN2ZjZjA5OGIxMTRhZWI0MTU1MzQxNjZlNjFkMGQxOTJiYTk1YWNjYQ==',
};
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const signature = {
  algorithm: 'sha256',
  encoding: 'hex-base64',
  secret: '${secretKey}${nonce}',
  nonceLength: 5,
  template: '${openKeyId}&${timestamp}&${pathname}',
  timestampFormat: 'ms',
  headerName: 'x-lt-signature',
  headerTemplate: '${nonce}${signature}',
  timestampHeader: 'x-lt-timestamp',
  extraHeaders: { 'x-lt-openKeyId': '${openKeyId}' },
};
const sheinAuth = (keys: Record<string, string> = { openKeyId: DOC.openKeyId, secretKey: DOC.secretKey }) => ({
  tokenProvider: 'shein',
  shein: {
    appId: 'APP',
    appSecret: 'APPSECRET0000000',
    authorizeUrl: 'https://openapi-sem.sheincorp.com/#/empower',
    tokenBaseUrl: 'https://openapi.sheincorp.com',
    tokenPath: '/open-api/auth/get-by-token',
  },
  signature,
  ...keys,
});
const errorWhen = [
  { path: 'code', in: ['openapi00001', 'openapi00004'], messagePath: ['code', 'msg'], status: 401 },
  { path: 'code', matches: '^(?!0$).+', messagePath: ['code', 'msg'], status: 400 },
];

const realService = (authStatus?: { mark: jest.Mock; clear: jest.Mock }) =>
  new SheinTokenService({} as never, { get: () => 'test-encryption-key-32-chars!!!!' } as never, authStatus as never);
const engineWith = (tokens?: SheinTokenService) =>
  new RestEngine({} as OAuth2TokenService, {} as LoginTokenService, undefined, undefined, undefined, undefined, tokens);

const run = (engine: RestEngine, authConfig: Record<string, unknown> = sheinAuth(), authType = 'HMAC') =>
  engine.execute(
    {
      baseUrl: 'https://openapi.sheincorp.com',
      authType,
      authConfig,
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      connectorId: 'conn-1',
      errorWhen,
    },
    { method: 'GET', path: DOC.path, queryParams: { orderNos: '$order_nos' } } as never,
    { order_nos: 'PO1' },
  );

describe('RestEngine: the "shein" token provider', () => {
  let now: jest.SpyInstance;
  let random: jest.SpyInstance;
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { code: '0', msg: 'OK', info: {} }, headers: {} });
    now = jest.spyOn(Date, 'now').mockReturnValue(DOC.timestamp);
    const picks = [...DOC.randomKey].map((c) => ALPHABET.indexOf(c));
    let n = 0;
    random = jest.spyOn(nodeCrypto, 'randomInt').mockImplementation((() => picks[n++ % picks.length]) as never);
  });
  afterEach(() => {
    now.mockRestore();
    random.mockRestore();
  });

  it("signs with the stored shop keys and reproduces SHEIN's documented signature", async () => {
    await run(engineWith(realService()));
    const cfg = mockedAxios.mock.calls[0][0];
    expect(cfg.headers).toEqual({
      'Content-Type': 'application/json;charset=UTF-8',
      'x-lt-openKeyId': DOC.openKeyId,
      'x-lt-timestamp': String(DOC.timestamp),
      'x-lt-signature': DOC.signature,
    });
    expect(cfg.params).toEqual({ orderNos: 'PO1' });
    expect(JSON.stringify(cfg)).not.toContain(DOC.secretKey);
    expect(JSON.stringify(cfg)).not.toContain('${');
  });

  it('sends nothing before the shop is authorized, and without the provider at all', async () => {
    await expect(run(engineWith(realService()), sheinAuth({}))).rejects.toMatchObject({ status: 401 });
    await expect(run(engineWith(undefined))).rejects.toThrow(/SHEIN token service/);
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('marks the connector when SHEIN says the shop key has expired, and says what to do', async () => {
    const authStatus = { mark: jest.fn(async () => undefined), clear: jest.fn(async () => undefined) };
    mockedAxios.mockResolvedValueOnce({ data: { code: 'openapi00004', msg: 'The user [1] has expired', info: null }, headers: {} });
    const err = (await run(engineWith(realService(authStatus))).catch((e) => e)) as { status?: number; hint?: string };
    expect(err.status).toBe(401);
    expect(err.hint).toMatch(/authorize the app again/);
    expect(authStatus.mark).toHaveBeenCalledWith('conn-1', expect.objectContaining({ status: 'needs_reauth', code: 'shein_key_expired' }));
    // Nothing to renew: sent once.
    expect(mockedAxios).toHaveBeenCalledTimes(1);
  });

  it('leaves every other connector alone: no provider call, the same signature as without it', async () => {
    const tokens = { signingConfig: jest.fn(), onRejected: jest.fn() } as unknown as SheinTokenService;
    const plain = {
      signature: {
        algorithm: 'sha256',
        encoding: 'hex-base64',
        secret: `${DOC.secretKey}\${nonce}`,
        nonceLength: 5,
        template: `${DOC.openKeyId}&\${timestamp}&\${pathname}`,
        timestampFormat: 'ms',
        headerName: 'x-lt-signature',
        headerTemplate: '${nonce}${signature}',
        timestampHeader: 'x-lt-timestamp',
        extraHeaders: { 'x-lt-openKeyId': DOC.openKeyId },
      },
    };
    await run(engineWith(tokens), plain);
    const withProvider = mockedAxios.mock.calls[0][0];
    mockedAxios.mockClear();
    await run(engineWith(undefined), plain);
    const without = mockedAxios.mock.calls[0][0];
    expect(withProvider.headers).toEqual(without.headers);
    expect(withProvider.headers['x-lt-signature']).toBe(DOC.signature);
    // An error on another connector does not reach the provider either.
    mockedAxios.mockResolvedValueOnce({ data: { code: 'openapi00004', msg: 'x' }, headers: {} });
    await expect(run(engineWith(tokens), plain)).rejects.toMatchObject({ status: 401 });
    // tokenProvider "shein" on another auth type is not this provider.
    await run(engineWith(tokens), { ...sheinAuth(), signature: plain.signature }, 'API_KEY').catch(() => undefined);
    expect((tokens as unknown as { signingConfig: jest.Mock }).signingConfig).not.toHaveBeenCalled();
    expect((tokens as unknown as { onRejected: jest.Mock }).onRejected).not.toHaveBeenCalled();
  });
});
