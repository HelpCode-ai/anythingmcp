import axios from 'axios';
import { RestEngine } from './rest.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import { LoginTokenService } from './login-token.service';

/**
 * Pins what HMAC signing puts on the wire for the adapters that already use
 * it, byte for byte, at a fixed clock. The expected values below were
 * captured on main before the query-signing options were added, so any
 * change to the header-placed path (Kaufland's) fails here, not in a
 * seller's account.
 */
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as unknown as jest.Mock;

const kaufland = require('../../adapters/de/kaufland.json') as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers: Record<string, string> };
  tools: Array<{ name: string; endpointMapping: Record<string, unknown> }>;
};

const FIXED_NOW = 1_760_000_000_000; // 2025-10-09T08:53:20Z

function kauflandAuth(): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(kaufland.connector.authConfig)
      .replace('{{KAUFLAND_SECRET_KEY}}', 'pin-secret')
      .replace('{{KAUFLAND_CLIENT_KEY}}', 'pin-client'),
  );
}

/** Everything the engine handed to axios that reaches the wire. */
function wire(cfg: Record<string, any>) {
  const realAxios = (jest.requireActual('axios') as { default: typeof axios }).default;
  return {
    method: cfg.method,
    url: cfg.url,
    sentUrl: realAxios.getUri(cfg as never),
    headers: cfg.headers,
    params: cfg.params,
    data: cfg.data,
    serializedQuery: typeof cfg.paramsSerializer === 'function' ? cfg.paramsSerializer(cfg.params ?? {}) : null,
  };
}

describe('HMAC signing, pinned at a fixed clock (header placement)', () => {
  let engine: RestEngine;
  let now: jest.SpyInstance;

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {}, headers: {} });
    engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
    now = jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  });
  afterEach(() => now.mockRestore());

  const run = async (toolName: string, params: Record<string, unknown>) => {
    const tool = kaufland.tools.find((t) => t.name === toolName)!;
    await engine.execute(
      {
        baseUrl: kaufland.connector.baseUrl,
        authType: kaufland.connector.authType,
        authConfig: kauflandAuth(),
        headers: kaufland.connector.headers,
      },
      tool.endpointMapping as never,
      params,
    );
    return wire(mockedAxios.mock.calls[0][0]);
  };

  it('kaufland_list_warehouses', async () => {
    expect(await run('kaufland_list_warehouses', {})).toEqual({
      method: 'GET',
      url: 'https://sellerapi.kaufland.com/v2/warehouses',
      sentUrl: 'https://sellerapi.kaufland.com/v2/warehouses',
      headers: {
        Accept: 'application/json',
        'Shop-Client-Key': 'pin-client',
        'Shop-Signature': '42976d71ac792c9257f1b9ac797f2c3a74a77022d5356e7a9d8af1689b657f66',
        'Shop-Timestamp': '1760000000',
      },
      params: undefined,
      data: undefined,
      serializedQuery: null,
    });
  });

  it('kaufland_list_orders with a filter in the query', async () => {
    expect(
      await run('kaufland_list_orders', {
        storefront: 'de',
        ts_created_from: '2025-10-01T00:00:00Z',
        limit: 20,
        offset: 40,
      }),
    ).toEqual({
      method: 'GET',
      url: 'https://sellerapi.kaufland.com/v2/orders',
      sentUrl: 'https://sellerapi.kaufland.com/v2/orders?storefront=de&ts_created_from=2025-10-01T00:00:00Z&limit=20&offset=40',
      headers: {
        Accept: 'application/json',
        'Shop-Client-Key': 'pin-client',
        'Shop-Signature': '7dfc78692a18762f09404c1055ebbc18ba300004c97b4a615b5d8bc2f60a7bf3',
        'Shop-Timestamp': '1760000000',
      },
      params: { storefront: 'de', ts_created_from: '2025-10-01T00:00:00Z', limit: 20, offset: 40 },
      data: undefined,
      serializedQuery: 'storefront=de&ts_created_from=2025-10-01T00:00:00Z&limit=20&offset=40',
    });
  });

  it('kaufland_get_order with a path id', async () => {
    expect(await run('kaufland_get_order', { id_order: 'AB12C', embedded: 'delivery' })).toEqual({
      method: 'GET',
      url: 'https://sellerapi.kaufland.com/v2/orders/AB12C',
      sentUrl: 'https://sellerapi.kaufland.com/v2/orders/AB12C?embedded=delivery',
      headers: {
        Accept: 'application/json',
        'Shop-Client-Key': 'pin-client',
        'Shop-Signature': '79c235e9556fe8592ca0afb93e7287c19801da3293c79d4647499cac85f7e0ad',
        'Shop-Timestamp': '1760000000',
      },
      params: { embedded: 'delivery' },
      data: undefined,
      serializedQuery: 'embedded=delivery',
    });
  });

  it('a POST body, a path template and a trailing newline', async () => {
    await engine.execute(
      {
        baseUrl: 'https://api.test',
        authType: 'HMAC',
        authConfig: {
          signature: {
            secret: 's3cret',
            template: '${method}\n${path}\n${body}\n${timestamp}\n',
            headerName: 'X-Sig',
            timestampHeader: 'X-Ts',
            extraHeaders: { 'X-Key': 'k1' },
          },
        },
      },
      { method: 'POST', path: '/units', queryParams: { a: '$a' }, bodyMapping: { sku: '$sku', qty: '$qty' } } as never,
      { sku: 'A-1', qty: 3, a: 'x y' },
    );
    expect(wire(mockedAxios.mock.calls[0][0])).toEqual({
      method: 'POST',
      url: 'https://api.test/units',
      sentUrl: 'https://api.test/units?a=x+y',
      headers: { 'X-Key': 'k1', 'X-Sig': 'ab5d691029d50241941f3c2e6204c173222e2b18656a57424d8d371f631ccdf0', 'X-Ts': '1760000000' },
      params: { a: 'x y' },
      data: { sku: 'A-1', qty: 3 },
      serializedQuery: 'a=x+y',
    });
  });

  it('defaults: sha256, hex, header "Signature", the Kaufland template', async () => {
    await engine.execute(
      { baseUrl: 'https://api.test', authType: 'HMAC', authConfig: { signature: { secret: 'k' } } },
      { method: 'GET', path: '/x' } as never,
      {},
    );
    expect(wire(mockedAxios.mock.calls[0][0])).toEqual({
      method: 'GET',
      url: 'https://api.test/x',
      sentUrl: 'https://api.test/x',
      headers: { Signature: 'cab302b74a6a3d7959b966d7718d5d95ef257792a1a7febb10178a33f8576f98' },
      params: undefined,
      data: undefined,
      serializedQuery: null,
    });
  });
});
