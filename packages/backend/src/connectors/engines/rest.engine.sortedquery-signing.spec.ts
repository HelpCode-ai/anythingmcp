import axios from 'axios';
import { createHmac } from 'crypto';
import { hmacTimestamp, RestEngine, sortedQueryString, usesExtendedHmac } from './rest.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import { LoginTokenService } from './login-token.service';

/**
 * `${sortedQuery}` and `timestampFormat: "iso"`: the Rocket SellerCenter
 * signature (Falabella Seller Center). Every query parameter but the
 * signature, sorted by name, RFC 3986 encoded, `name=value` joined with `&`,
 * HMAC-SHA256 with the user's API key, lower-case hex, sent as `Signature`.
 */
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as unknown as jest.Mock;

// The reference values published in the vendor's signing guide.
const DOC_KEY = 'b1bdb357ced10fe4e9a69840cdd4f0e9c03d77fe';
const DOC_SIGNATURE = '3ceb8ed91049dfc718b0d2d176fb2ed0e5fd74f76c5971f34cdab48412476041';
const DOC_NOW = Date.parse('2015-07-01T11:11:11Z');

const signature = (statics: Record<string, string>) => ({
  algorithm: 'sha256',
  encoding: 'hex',
  secret: DOC_KEY,
  placement: 'query',
  paramName: 'Signature',
  timestampParam: 'Timestamp',
  timestampFormat: 'iso',
  queryParams: statics,
  template: '${sortedQuery}',
});

describe('sortedQueryString', () => {
  it('sorts by name and RFC 3986-encodes names and values', () => {
    expect(
      sortedQueryString({ Version: '1.0', Action: 'FeedList', UserID: 'look@me.com', Timestamp: '2015-07-01T11:11:11+00:00' }),
    ).toBe('Action=FeedList&Timestamp=2015-07-01T11%3A11%3A11%2B00%3A00&UserID=look%40me.com&Version=1.0');
  });

  it("encodes the characters encodeURIComponent leaves alone (! ' ( ) *) and a space as %20", () => {
    expect(sortedQueryString({ Search: "a b!'()*~._-" })).toBe('Search=a%20b%21%27%28%29%2A~._-');
  });

  it('leaves out the signature parameter but keeps empty values, which are sent', () => {
    expect(sortedQueryString({ b: '', Signature: 'x', a: '1' }, 'Signature')).toBe('a=1&b=');
  });

  it('writes arrays the way the query serializer sends them', () => {
    expect(sortedQueryString({ ids: ['2', '1'] })).toBe('ids=2&ids=1');
  });
});

describe('hmacTimestamp', () => {
  it('formats seconds (default), milliseconds and ISO 8601 in UTC', () => {
    expect(hmacTimestamp(undefined, DOC_NOW + 123)).toBe(String(Math.floor(DOC_NOW / 1000)));
    expect(hmacTimestamp('s', DOC_NOW)).toBe(String(DOC_NOW / 1000));
    expect(hmacTimestamp('ms', DOC_NOW + 123)).toBe(String(DOC_NOW + 123));
    expect(hmacTimestamp('iso', DOC_NOW + 123)).toBe('2015-07-01T11:11:11+00:00');
  });
});

describe('usesExtendedHmac', () => {
  it('takes the query-signing path for a ${sortedQuery} template', () => {
    expect(usesExtendedHmac({ template: '${sortedQuery}' })).toBe(true);
  });
});

describe('RestEngine with ${sortedQuery} and an ISO timestamp', () => {
  let engine: RestEngine;
  let now: jest.SpyInstance;

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { SuccessResponse: { Head: {}, Body: {} } }, headers: {} });
    engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
    now = jest.spyOn(Date, 'now').mockReturnValue(DOC_NOW);
  });
  afterEach(() => now.mockRestore());

  const sent = () => {
    const cfg = mockedAxios.mock.calls[0][0];
    const realAxios = (jest.requireActual('axios') as { default: typeof axios }).default;
    return { cfg, url: realAxios.getUri(cfg as never) };
  };

  it("reproduces the signing guide's reference signature", async () => {
    await engine.execute(
      {
        baseUrl: 'https://sellercenter-api.example.com',
        authType: 'HMAC',
        authConfig: { signature: signature({ UserID: 'look@me.com', Version: '1.0', Format: 'XML' }) },
      },
      { method: 'GET', path: '/', queryParams: { Action: 'FeedList' } } as never,
      {},
    );
    const { cfg, url } = sent();
    expect(cfg.params.Signature).toBe(DOC_SIGNATURE);
    expect(cfg.params.Timestamp).toBe('2015-07-01T11:11:11+00:00');
    // The `+` of the offset must reach the server as %2B, never as a space.
    expect(url).toContain('Timestamp=2015-07-01T11:11:11%2B00:00');
    expect(url).toContain(`Signature=${DOC_SIGNATURE}`);
  });

  it('signs a tool parameter with characters that need RFC 3986 encoding, and leaves the XML body out', async () => {
    await engine.execute(
      {
        baseUrl: 'https://sellercenter-api.example.com',
        authType: 'HMAC',
        authConfig: { signature: signature({ UserID: 'seller@example.com', Version: '1.0', Format: 'JSON' }) },
      },
      {
        method: 'POST',
        path: '/',
        queryParams: { Action: 'ProductUpdate', Search: '$search' },
        bodyEncoding: 'xml',
        bodyMapping: { __raw: '$xml' },
      } as never,
      { search: "Zapato (rojo) & 'azul'", xml: '<Request><Product><SellerSku>A1</SellerSku></Product></Request>' },
    );
    const { cfg } = sent();
    const expected = createHmac('sha256', DOC_KEY)
      .update(
        'Action=ProductUpdate&Format=JSON&Search=Zapato%20%28rojo%29%20%26%20%27azul%27' +
          '&Timestamp=2015-07-01T11%3A11%3A11%2B00%3A00&UserID=seller%40example.com&Version=1.0',
      )
      .digest('hex');
    expect(cfg.params.Signature).toBe(expected);
    expect(cfg.data).toBe('<Request><Product><SellerSku>A1</SellerSku></Product></Request>');
  });
});
