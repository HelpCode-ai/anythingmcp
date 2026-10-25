import * as adapter from './ebay-browse.json';
import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

type Tool = { name: string; endpointMapping: Record<string, any>; parameters: { required?: string[] } };
const a = adapter as unknown as {
  requiredEnvVars: string[];
  probe: { tool: string; params: Record<string, unknown> };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

/**
 * eBay Browse API (buyer-side search) with an application token. Every tool
 * is a GET and was checked against eBay production with an existing keyset:
 * search, item, item by legacy id and item group.
 */
describe('ebay-browse adapter: static spec conformance', () => {
  it('gets an application token with client credentials and the public api_scope', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig.grant).toBe('client_credentials');
    expect(a.connector.authConfig.tokenUrl).toBe('https://api.ebay.com/identity/v1/oauth2/token');
    expect(a.connector.authConfig.tokenAuthMethod).toBe('client_secret_basic');
    expect(a.connector.authConfig.scope).toBe('https://api.ebay.com/oauth/api_scope');
    expect(a.connector.authConfig.refreshToken).toBeUndefined();
  });

  it('sends the marketplace on every call', () => {
    expect(a.connector.headers['X-EBAY-C-MARKETPLACE-ID']).toBe('{{EBAY_MARKETPLACE_ID}}');
    expect(a.requiredEnvVars).toContain('EBAY_MARKETPLACE_ID');
  });

  it('is read-only', () => {
    for (const t of a.tools) expect(t.endpointMapping.method).toBe('GET');
  });

  it('probes with a one-item search', () => {
    expect(a.probe.tool).toBe('ebay_browse_search_items');
    expect(a.probe.params).toEqual({ q: 'book', limit: 1 });
  });
});

describe('ebay-browse adapter: requests', () => {
  const engine = new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue('app-token'), refreshToken: jest.fn() } as any,
    { getToken: jest.fn(), forceRelogin: jest.fn() } as any,
  );
  const config = {
    baseUrl: 'https://api.ebay.com',
    authType: 'OAUTH2' as const,
    authConfig: { ...a.connector.authConfig, clientId: 'id', clientSecret: 'secret' },
    headers: { 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_DE' },
  };
  const run = (name: string, params: Record<string, unknown>) =>
    engine.execute(config, tool(name).endpointMapping as any, params);
  const sent = () => mockedAxios.mock.calls[0][0] as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.mockResolvedValue({ status: 200, data: { ok: true }, headers: {} });
  });

  it('searches with eBay parameter names', async () => {
    await run('ebay_browse_search_items', { q: 'lego technic', filter: 'conditions:{NEW}', limit: 5 });
    expect(sent().url).toBe('https://api.ebay.com/buy/browse/v1/item_summary/search');
    expect(sent().params).toEqual({ q: 'lego technic', filter: 'conditions:{NEW}', limit: 5 });
    expect(sent().headers['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_DE');
    expect(sent().headers.Authorization).toBe('Bearer app-token');
  });

  it('encodes the pipes of a RESTful item id', async () => {
    await run('ebay_browse_get_item', { item_id: 'v1|123456789012|0' });
    expect(sent().url).toBe('https://api.ebay.com/buy/browse/v1/item/v1%7C123456789012%7C0');
  });

  it('reads an item by its classic item number', async () => {
    await run('ebay_browse_get_item_by_legacy_id', { legacy_item_id: '123456789012' });
    expect(sent().url).toBe('https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id');
    expect(sent().params).toEqual({ legacy_item_id: '123456789012' });
  });
});

// Opt-in live check with your own production keyset (read-only).
const live = process.env.RUN_EBAY_BROWSE_LIVE === '1';
(live ? describe : describe.skip)('ebay-browse: live (read-only)', () => {
  const realAxios = jest.requireActual('axios').default;

  it('gets an application token and finds listings', async () => {
    const basic = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');
    const tok = await realAxios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' }).toString(),
      { headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    const res = await realAxios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
      params: { q: 'book', limit: 1 },
      headers: {
        Authorization: `Bearer ${tok.data.access_token}`,
        'X-EBAY-C-MARKETPLACE-ID': process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US',
      },
    });
    expect(res.status).toBe(200);
    expect(typeof res.data.total).toBe('number');
  });
});
