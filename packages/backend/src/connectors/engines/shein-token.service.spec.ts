import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createCipheriv, createHmac } from 'node:crypto';
import {
  SheinTokenService,
  buildSheinAuthorizationUrl,
  describeSheinError,
  isSheinAuth,
  isSheinKeyExpired,
  isSheinSignatureRefused,
  sheinAppFrom,
  sheinNeedsAuthorization,
  sheinNonce,
  sheinSignature,
  withSheinKeys,
} from './shein-token.service';
import { credentialRef } from './connector-auth-status.service';
import { ResponseBodyError } from './response-error.util';
import { decrypt, encrypt } from '../../common/crypto/encryption.util';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
jest.mock('../../common/ssrf.util', () => ({
  ...jest.requireActual('../../common/ssrf.util'),
  assertSafeOutboundUrl: jest.fn().mockResolvedValue(undefined),
}));

const KEY = 'test-encryption-key-32-chars!!!!';

/**
 * Values from SHEIN's own documentation:
 *  - "Signature Rules" (/documents/system/passwdrule): the worked example
 *    (openKeyId, secretKey, path, timestamp, random key "test1", signature).
 *  - "Store Authorization Application Manual" (page 2169474d-…), section
 *    "Secret Key Decryption": the C# example's app secret, encrypted
 *    secretKey and plaintext; the authorization link example; the
 *    get-by-token answer example (appid 10AF15E7DD802804E7140BE2D326D,
 *    openKeyId 5C83782096BA46008D66C424CB39803F, supplierId 21840925).
 */
const SIGN_DOC = {
  openKeyId: 'B96C15416C9240DF96BAA0BC9B367C6D',
  secretKey: '6BEC9C4B668B4B14B17EEF106BB98AE5',
  path: '/open-api/order/purchase-order-info',
  timestamp: '1740709414000',
  randomKey: 'test1',
  signature: 'test1ZDZjYTJjNzg5ZjUzMDdkZTU2N2Y3NzcxN2ZjZjA5OGIxMTRhZWI0MTU1MzQxNjZlNjFkMGQxOTJiYTk1YWNjYQ==',
};
const DECRYPT_DOC = {
  appSecret: '698E4F20DFBA4B85B2291C2BCB7381C5',
  encrypted: 'Um6W8uVjabRyt5zJI3hw/38ke8dvUq1o6Vkk1f/Gzjt+sWGeUpYBIFTk7/xVHhJy',
  plain: 'E547DCB619824189AD3A532546AE37F9',
};
const APP_ID = '10AF15E7DD802804E7140BE2D326D';

/** The provider block as the adapter writes it, resolved. */
const sheinAuth = (extra: Record<string, unknown> = {}) => ({
  tokenProvider: 'shein',
  shein: {
    appId: APP_ID,
    appSecret: DECRYPT_DOC.appSecret,
    authorizeUrl: 'https://openapi-sem.sheincorp.com/#/empower',
    tokenBaseUrl: 'https://openapi.sheincorp.com',
    tokenPath: '/open-api/auth/get-by-token',
  },
  signature: {
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
  },
  ...extra,
});

describe('SHEIN signing and config helpers', () => {
  it("reproduces the worked example of SHEIN's Signature Rules page", () => {
    expect(sheinSignature(SIGN_DOC.openKeyId, SIGN_DOC.secretKey, SIGN_DOC.path, SIGN_DOC.timestamp, SIGN_DOC.randomKey)).toBe(
      SIGN_DOC.signature,
    );
  });

  it('draws five characters of A-Z a-z 0-9 for every signature', () => {
    expect(sheinNonce()).toMatch(/^[A-Za-z0-9]{5}$/);
    expect(new Set(Array.from({ length: 50 }, () => sheinNonce())).size).toBeGreaterThan(45);
  });

  it('opts in only on HMAC with tokenProvider "shein", and needs both keys to count as authorized', () => {
    expect(isSheinAuth('HMAC', sheinAuth())).toBe(true);
    expect(isSheinAuth('API_KEY', sheinAuth())).toBe(false);
    expect(isSheinAuth('HMAC', { ...sheinAuth(), tokenProvider: 'iop' })).toBe(false);
    expect(isSheinAuth('HMAC', undefined)).toBe(false);
    expect(sheinNeedsAuthorization('HMAC', sheinAuth())).toBe(true);
    expect(sheinNeedsAuthorization('HMAC', sheinAuth({ openKeyId: 'K' }))).toBe(true);
    expect(sheinNeedsAuthorization('HMAC', sheinAuth({ openKeyId: 'K', secretKey: '{{X}}' }))).toBe(true);
    expect(sheinNeedsAuthorization('HMAC', sheinAuth({ openKeyId: 'K', secretKey: 'S' }))).toBe(false);
    // Not a SHEIN connector: never "needs authorization" because of this provider.
    expect(sheinNeedsAuthorization('HMAC', { signature: {} })).toBe(false);
  });

  it('reads the app settings, refusing unresolved variables, plain http and a token path that is not a path', () => {
    expect(sheinAppFrom(sheinAuth())).toEqual({
      appId: APP_ID,
      appSecret: DECRYPT_DOC.appSecret,
      authorizeUrl: 'https://openapi-sem.sheincorp.com/#/empower',
      tokenBaseUrl: 'https://openapi.sheincorp.com',
      tokenPath: '/open-api/auth/get-by-token',
    });
    const edit = (patch: Record<string, unknown>) => sheinAppFrom({ ...sheinAuth(), shein: { ...sheinAuth().shein, ...patch } });
    expect(edit({ appSecret: '{{SHEIN_APP_SECRET}}' })).toBeUndefined();
    expect(edit({ appId: '' })).toBeUndefined();
    expect(edit({ tokenBaseUrl: 'http://openapi.sheincorp.com' })).toBeUndefined();
    expect(edit({ authorizeUrl: 'javascript:alert(1)' })).toBeUndefined();
    expect(edit({ tokenPath: 'open-api/auth/get-by-token' })).toBeUndefined();
    expect(edit({ tokenBaseUrl: 'https://openapi.sheincorp.com/' })!.tokenBaseUrl).toBe('https://openapi.sheincorp.com');
  });

  it("builds the authorization link as SHEIN's manual does: parameters after the hash route, the redirect in Base64", () => {
    const app = sheinAppFrom(sheinAuth({ shein: { ...sheinAuth().shein, appId: 'F9D87342D803BA78E1EE49997162' } }))!;
    // The manual's example: redirect https://www.baidu.com, state AUTH-SHEIN-1624700000000.
    expect(buildSheinAuthorizationUrl(app, 'https://www.baidu.com', 'AUTH-SHEIN-1624700000000')).toBe(
      'https://openapi-sem.sheincorp.com/#/empower?appid=F9D87342D803BA78E1EE49997162&redirectUrl=aHR0cHM6Ly93d3cuYmFpZHUuY29t&state=AUTH-SHEIN-1624700000000',
    );
    const url = buildSheinAuthorizationUrl(app, 'https://cloud.anythingmcp.com/api/shein-auth/callback', 'abc123');
    const query = new URLSearchParams(url.split('#/empower?')[1]);
    expect(Buffer.from(query.get('redirectUrl')!, 'base64').toString('utf8')).toBe('https://cloud.anythingmcp.com/api/shein-auth/callback');
    expect(query.get('state')).toBe('abc123');
    expect(url).not.toContain(DECRYPT_DOC.appSecret);
  });

  it("fills the shop's keys into the signature block in one pass, leaving everything else and the input alone", () => {
    const input = sheinAuth();
    const out = withSheinKeys(input, { openKeyId: 'OPEN-${secretKey}', secretKey: 'SEC-${nonce}' });
    expect(out.signature).toEqual({
      ...input.signature,
      secret: 'SEC-${nonce}${nonce}',
      template: 'OPEN-${secretKey}&${timestamp}&${pathname}',
      extraHeaders: { 'x-lt-openKeyId': 'OPEN-${secretKey}' },
    });
    expect(input.signature.secret).toBe('${secretKey}${nonce}');
    expect(out.shein).toBe(input.shein);
  });

  it('recognises the key SHEIN ended and a refused signature, in a 2xx answer or an HTTP error', () => {
    const body = (code: string, msg = 'x') => ({ code, msg, info: null, traceId: 't' });
    expect(isSheinKeyExpired(new ResponseBodyError('m', 401, body('openapi00004', 'The user [1] has expired')))).toBe(true);
    expect(isSheinKeyExpired({ response: { status: 401, data: body('openapi00004') } })).toBe(true);
    expect(isSheinKeyExpired(new ResponseBodyError('m', 401, body('openapi00001')))).toBe(false);
    expect(isSheinKeyExpired(new Error('network'))).toBe(false);
    expect(
      isSheinSignatureRefused(
        new ResponseBodyError('m', 401, body('openapi00001', 'Signature Error: The generated signature is incorrect, please check')),
      ),
    ).toBe(true);
    // The same code for an expired timestamp or malformed headers: not the key.
    expect(isSheinSignatureRefused(new ResponseBodyError('m', 401, body('openapi00001', 'The request timestamp has expired')))).toBe(false);
    expect(isSheinSignatureRefused(new ResponseBodyError('m', 401, body('openapi00001', 'Header parameters are abnormal')))).toBe(false);
    expect(describeSheinError({ response: { status: 200, data: body('33051002', 'Request timed out') } })).toBe(
      'HTTP 200: 33051002: Request timed out',
    );
    expect(describeSheinError(new Error('bad tempToken abc'))).toBe('network error');
  });
});

describe('SheinTokenService', () => {
  const prevKey = process.env.ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = KEY;
  });
  afterAll(() => {
    process.env.ENCRYPTION_KEY = prevKey;
  });

  let stored: Record<string, unknown> | null;
  let prisma: { connector: { findUnique: jest.Mock; update: jest.Mock } };
  let authStatus: { mark: jest.Mock; clear: jest.Mock };
  let service: SheinTokenService;
  const config = { get: jest.fn(() => KEY) } as unknown as ConfigService;

  beforeEach(() => {
    mockedAxios.post.mockReset();
    stored = { ...sheinAuth(), shein: { ...sheinAuth().shein, appId: '{{SHEIN_APP_ID}}', appSecret: '{{SHEIN_APP_SECRET}}' } };
    prisma = {
      connector: {
        findUnique: jest.fn(async () => (stored ? { authConfig: encrypt(JSON.stringify(stored), KEY) } : null)),
        update: jest.fn(async ({ data }: { data: { authConfig: string } }) => {
          stored = JSON.parse(decrypt(data.authConfig, KEY));
          return {};
        }),
      },
    };
    authStatus = { mark: jest.fn(async () => undefined), clear: jest.fn(async () => undefined) };
    service = new SheinTokenService(prisma as never, config, authStatus as never);
  });

  const app = () => sheinAppFrom(sheinAuth())!;
  // SHEIN's get-by-token answer example, with a secretKey encrypted as SHEIN does it (the manual's C# vector).
  const answer = (info: Record<string, unknown> = {}) => ({
    status: 200,
    data: {
      code: '0',
      msg: 'OK',
      info: {
        secretKey: DECRYPT_DOC.encrypted,
        appid: APP_ID,
        openKeyId: '5C83782096BA46008D66C424CB39803F',
        state: 'OPENAPI',
        supplierId: 21840925,
        supplierSource: 10,
        supplierBusinessMode: 'POP-US',
        ...info,
      },
      traceId: '7b0461d5534f3e1',
    },
  });

  it('exchanges the tempToken with a call signed by the app id and secret, as the manual shows', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1752560461085);
    mockedAxios.post.mockResolvedValueOnce(answer());
    try {
      await service.exchangeTempToken({ connectorId: 'conn-1', app: app(), tempToken: 'de723b1c-210b-4ecc-8da4-5f1da6ea0a9b' });
    } finally {
      now.mockRestore();
    }
    const [url, body, opts] = mockedAxios.post.mock.calls[0] as [string, unknown, { headers: Record<string, string> }];
    expect(url).toBe('https://openapi.sheincorp.com/open-api/auth/get-by-token');
    expect(body).toEqual({ tempToken: 'de723b1c-210b-4ecc-8da4-5f1da6ea0a9b' });
    expect(opts.headers).toMatchObject({
      'Content-Type': 'application/json;charset=UTF-8',
      'x-lt-appid': APP_ID,
      'x-lt-timestamp': '1752560461085',
    });
    expect(opts.headers).not.toHaveProperty('x-lt-openKeyId');
    // The recipe of the manual's Java and JS examples: appid&timestamp&path, key appSecret + random, hex, Base64, random in front.
    const sig = opts.headers['x-lt-signature'];
    const nonce = sig.slice(0, 5);
    expect(nonce).toMatch(/^[A-Za-z0-9]{5}$/);
    const hex = createHmac('sha256', DECRYPT_DOC.appSecret + nonce)
      .update(`${APP_ID}&1752560461085&/open-api/auth/get-by-token`, 'utf8')
      .digest('hex');
    expect(sig).toBe(nonce + Buffer.from(hex, 'utf8').toString('base64'));
    expect(JSON.stringify(mockedAxios.post.mock.calls[0])).not.toContain(DECRYPT_DOC.appSecret);
  });

  it("decrypts the shop's secretKey with the app secret and stores both keys encrypted on the connector", async () => {
    mockedAxios.post.mockResolvedValueOnce(answer());
    expect(await service.exchangeTempToken({ connectorId: 'conn-1', app: app(), tempToken: 't' })).toEqual({ supplierId: '21840925' });
    // The connector's authConfig is written encrypted: the raw write holds neither key.
    const written = prisma.connector.update.mock.calls[0][0].data.authConfig as string;
    expect(written).not.toContain(DECRYPT_DOC.plain);
    expect(written).not.toContain('5C83782096BA46008D66C424CB39803F');
    expect(stored).toMatchObject({
      tokenProvider: 'shein',
      shein: { appId: '{{SHEIN_APP_ID}}', appSecret: '{{SHEIN_APP_SECRET}}' },
      openKeyId: '5C83782096BA46008D66C424CB39803F',
      secretKey: DECRYPT_DOC.plain,
      supplierId: '21840925',
      supplierBusinessMode: 'POP-US',
      authorizedAt: expect.any(String),
    });
    // The adapter's placeholders stay as they are.
    expect((stored!.signature as Record<string, unknown>).secret).toBe('${secretKey}${nonce}');
    expect(authStatus.clear).toHaveBeenCalledWith('conn-1');
  });

  it("refuses SHEIN's error answers, an answer for another app and a secretKey this app secret cannot decrypt", async () => {
    mockedAxios.post.mockResolvedValueOnce({
      status: 200,
      data: { code: '33051002', msg: 'Request timed out: Please request to generate a temporary token again', info: null },
    });
    const timedOut = await service.exchangeTempToken({ connectorId: 'conn-1', app: app(), tempToken: 't' }).catch((e) => e);
    expect(describeSheinError(timedOut)).toMatch(/33051002: Request timed out/);

    mockedAxios.post.mockResolvedValueOnce(answer({ appid: 'ANOTHERAPP' }));
    await expect(service.exchangeTempToken({ connectorId: 'conn-1', app: app(), tempToken: 't' })).rejects.toThrow(/another app id/);

    const otherKey = Buffer.alloc(16, 7);
    const cipher = createCipheriv('aes-128-cbc', otherKey, Buffer.from('space-station-de', 'utf8'));
    const foreign = Buffer.concat([cipher.update('X'.repeat(32), 'utf8'), cipher.final()]).toString('base64');
    mockedAxios.post.mockResolvedValueOnce(answer({ secretKey: foreign }));
    const undecryptable = await service.exchangeTempToken({ connectorId: 'conn-1', app: app(), tempToken: 't' }).catch((e) => e);
    expect(describeSheinError(undecryptable)).toMatch(/could not be decrypted with this app secret/);

    mockedAxios.post.mockResolvedValueOnce(answer({ openKeyId: '' }));
    await expect(service.exchangeTempToken({ connectorId: 'conn-1', app: app(), tempToken: 't' })).rejects.toThrow(/no openKeyId/);

    expect(prisma.connector.update).not.toHaveBeenCalled();
  });

  it("signs with the stored keys, and refuses (status 401) before SHEIN's authorization", () => {
    const out = service.signingConfig({
      authType: 'HMAC',
      connectorId: 'conn-1',
      authConfig: sheinAuth({ openKeyId: SIGN_DOC.openKeyId, secretKey: SIGN_DOC.secretKey }),
    });
    expect(out.authConfig!.signature).toMatchObject({
      secret: `${SIGN_DOC.secretKey}\${nonce}`,
      template: `${SIGN_DOC.openKeyId}&\${timestamp}&\${pathname}`,
      extraHeaders: { 'x-lt-openKeyId': SIGN_DOC.openKeyId },
    });
    expect(() => service.signingConfig({ authType: 'HMAC', connectorId: 'conn-1', authConfig: sheinAuth() })).toThrow(
      expect.objectContaining({ status: 401, message: expect.stringMatching(/has not authorized.*No request was sent/) }),
    );
  });

  it('marks the connector for a new authorization when SHEIN says the shop key expired (openapi00004)', async () => {
    const cfg = { authType: 'HMAC', connectorId: 'conn-1', authConfig: sheinAuth({ openKeyId: 'OPEN-1', secretKey: 'S' }) };
    const hint = await service.onRejected(
      cfg,
      new ResponseBodyError('openapi00004 The user [1] has expired', 401, { code: 'openapi00004', msg: 'The user [1] has expired' }),
    );
    expect(hint).toMatch(/authorize the app again/);
    expect(authStatus.mark).toHaveBeenCalledWith('conn-1', {
      status: 'needs_reauth',
      code: 'shein_key_expired',
      message: hint,
      ref: credentialRef('OPEN-1'),
    });

    // A refused signature only says what to do: it may be the clock or the key.
    authStatus.mark.mockClear();
    const sigHint = await service.onRejected(
      cfg,
      new ResponseBodyError('x', 401, { code: 'openapi00001', msg: 'Signature Error: The generated signature is incorrect, please check' }),
    );
    expect(sigHint).toMatch(/Authorize with Provider/);
    expect(authStatus.mark).not.toHaveBeenCalled();

    // Anything else: no hint, nothing marked.
    expect(await service.onRejected(cfg, new ResponseBodyError('x', 403, { code: 'openapi00002', msg: 'IP is not in the whitelist' }))).toBeUndefined();
    expect(authStatus.mark).not.toHaveBeenCalled();
  });
});
