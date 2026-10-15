import axios from 'axios';
import * as adapter from './coinbase.json';
import { RestEngine, serializeRepeatedParams } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Coinbase adapter:
 *
 *   1. Static: always runs. Pins the keyless connector (public market data of
 *      the Advanced Trade API and the Data API spot price, authType NONE), the
 *      read-only guarantee (no tool can trade or move funds, and none is
 *      hidden behind a switch), every tool's method and URL through the real
 *      RestEngine, the default page sizes that keep answers small, and the
 *      response mappings against payloads captured from the live API.
 *
 *   2. Live: skipped unless RUN_COINBASE_LIVE=1. The endpoints are public, so
 *      no credentials are needed:
 *
 *        RUN_COINBASE_LIVE=1 npx jest src/adapters/intl/coinbase.live.spec.ts
 *
 *      Runs every tool against api.coinbase.com and applies each tool's
 *      responseMapping the way the MCP layer does. There are no writes.
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { default?: unknown; maximum?: number; pattern?: string }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  responseMapping?: { transform?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  description: string;
  requiredEnvVars: string[];
  envVarMeta?: unknown;
  probe: { tool: string };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig?: unknown;
    headers: Record<string, string>;
    healthcheckPath: string;
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const BASE = 'https://api.coinbase.com';
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
const run = async (name: string, params: Record<string, unknown>) => {
  const { body } = await engine().executeWithMeta(
    { baseUrl: a.connector.baseUrl, authType: a.connector.authType, headers: a.connector.headers },
    tool(name).endpointMapping,
    applySchemaDefaults(tool(name).parameters, params),
  );
  return body as any;
};
// What the model receives: the body shaped by the tool's responseMapping.
const runShaped = async (name: string, params: Record<string, unknown>) =>
  applyResponseTransform(await run(name, params), tool(name).responseMapping as never).value as any;
const sent = () => mockedAxios.mock.calls[0][0];
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as never);

const MARKET_TOOLS = [
  'coinbase_get_candles',
  'coinbase_get_market_trades',
  'coinbase_get_product',
  'coinbase_get_product_book',
  'coinbase_get_spot_price',
  'coinbase_list_products',
];
// Anything that would touch an account, an order or money.
const MONEY_MOVING = /order|trade(?!s\b)|convert|conversion|transfer|withdraw|deposit|send|buy|sell|portfolio|account|payment|fill|wallet|address|allocat|margin|position|sweep|preview|edit|cancel|close/i;

describe('coinbase adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('coinbase');
    expect(a.icon).toBe('coinbase');
    expect(a.category).toBe('finance');
  });

  it('is keyless: public market data at api.coinbase.com, no credentials of any kind', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.envVarMeta).toBeUndefined();
    expect(JSON.stringify(adapter)).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(a.connector.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'AnythingMCP' });
    expect(a.connector.healthcheckPath).toBe('/api/v3/brokerage/time');
    expect(a.probe.tool).toBe('coinbase_get_server_time');
    expect(tool('coinbase_get_server_time').parameters.required).toBeUndefined();
  });

  it('cannot trade or move funds: every tool is a GET on a public market data route, none is switched off', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(t.endpointMapping.bodyMapping).toBeUndefined();
      expect(t.enabled).toBeUndefined();
      expect(t.annotations).toBeUndefined();
      expect(annotationsOf(t)).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.endpointMapping.path).toMatch(
        /^(\/api\/v3\/brokerage\/time|\/api\/v3\/brokerage\/market\/[a-z_/{}]+|\/v2\/prices\/\{currency_pair\}\/spot)$/,
      );
      expect(`${t.name}:${MONEY_MOVING.test(t.endpointMapping.path)}`).toBe(`${t.name}:false`);
      expect(`${t.name}:${MONEY_MOVING.test(t.name.replace('market_trades', 'market'))}`).toBe(`${t.name}:false`);
    }
    // The account routes the instructions say are out of reach really are absent.
    const paths = a.tools.map((t) => t.endpointMapping.path).join(' ');
    for (const route of ['/orders', '/accounts', '/portfolios', '/convert', '/transactions', '/payment_methods', '/best_bid_ask']) {
      expect(paths).not.toContain(route);
    }
    expect(a.instructions).toContain('Read-only by design: this connector cannot trade or move funds.');
    expect(a.instructions).toMatch(/places, edits or cancels an order, buys, sells or converts crypto, or sends, withdraws, deposits or transfers crypto or money, and none can be switched on/);
    expect(a.description).toMatch(/cannot trade or move funds/);
  });

  it('says that market data is not financial advice, in the instructions and on every market tool', () => {
    expect(a.instructions).toContain('**Not financial advice.**');
    for (const name of MARKET_TOOLS) expect(tool(name).description).toMatch(/not financial advice/);
  });

  it('prefixes every tool with coinbase_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^coinbase_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('every responseMapping does real work, and every tool has one', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${Boolean(tr && (tr.select || tr.exclude || tr.include))}`).toBe(`${t.name}:true`);
    }
  });

  it('caps every list: default page sizes and maxima keep answers small', () => {
    const caps: Record<string, [number, number]> = {
      coinbase_list_products: [25, 100],
      coinbase_get_market_trades: [20, 100],
      coinbase_get_candles: [60, 300],
      coinbase_get_product_book: [10, 50],
    };
    for (const [name, [def, max]] of Object.entries(caps)) {
      const limit = tool(name).parameters.properties!.limit;
      expect(limit.default).toBe(def);
      expect(limit.maximum).toBe(max);
      expect(tool(name).endpointMapping.queryParams!.limit).toBe('$limit');
    }
    for (const name of ['coinbase_list_products', 'coinbase_get_market_trades', 'coinbase_get_candles', 'coinbase_get_product_book']) {
      expect(tool(name).responseMapping!.transform!.maxBytes).toBeGreaterThan(0);
    }
  });

  it('only points the model at tools that exist and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bcoinbase_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bcoinbase_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(8);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Coinbase\n')).toBe(true);
    expect(a.instructions).toContain('Out of scope');
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const M = `${BASE}/api/v3/brokerage/market`;
  const table: Array<[string, Record<string, unknown>, string]> = [
    ['coinbase_get_server_time', {}, `${BASE}/api/v3/brokerage/time`],
    ['coinbase_list_products', {}, `${M}/products`],
    ['coinbase_get_product', { product_id: 'BTC-USD' }, `${M}/products/BTC-USD`],
    ['coinbase_get_market_trades', { product_id: 'ETH-EUR' }, `${M}/products/ETH-EUR/ticker`],
    ['coinbase_get_candles', { product_id: 'BTC-USD', granularity: 'ONE_DAY', start: '1760000000', end: '1760300000' }, `${M}/products/BTC-USD/candles`],
    ['coinbase_get_product_book', { product_id: 'BTC-USD' }, `${M}/product_book`],
    ['coinbase_get_spot_price', { currency_pair: 'BTC-EUR' }, `${BASE}/v2/prices/BTC-EUR/spot`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends a GET to the right URL without an Authorization header', async (name, params, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await run(name, params);
    expect(sent().method).toBe('GET');
    expect(sent().url).toBe(url);
    expect(sent().headers.Authorization).toBeUndefined();
    expect(sent().data).toBeUndefined();
  });

  it('encodes path arguments, so a crafted id cannot reach another route', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await run('coinbase_get_product', { product_id: '../../orders' });
    expect(sent().url).toBe(`${BASE}/api/v3/brokerage/market/products/..%2F..%2Forders`);
    for (const t of a.tools.filter((x) => /\{[a-z_]+\}/.test(x.endpointMapping.path))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('sends the default page sizes and repeats product_ids the way Coinbase parses them', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await run('coinbase_list_products', { product_ids: ['BTC-USD', 'ETH-EUR'] });
    expect(sent().params).toEqual({ limit: 25, product_ids: ['BTC-USD', 'ETH-EUR'] });
    // A comma-joined list returns no products at all; the repeated form works (checked live).
    expect(sent().paramsSerializer(sent().params)).toBe('limit=25&product_ids=BTC-USD&product_ids=ETH-EUR');
    mockedAxios.mockClear();
    await run('coinbase_get_market_trades', { product_id: 'BTC-USD' });
    expect(sent().params).toEqual({ limit: 20 });
    mockedAxios.mockClear();
    await run('coinbase_get_product_book', { product_id: 'BTC-USD' });
    expect(sent().params).toEqual({ product_id: 'BTC-USD', limit: 10 });
    mockedAxios.mockClear();
    await run('coinbase_get_candles', { product_id: 'BTC-USD', granularity: 'ONE_HOUR', start: '1760000000', end: '1760172800' });
    expect(sent().params).toEqual({ granularity: 'ONE_HOUR', start: '1760000000', end: '1760172800', limit: 60 });
    expect(tool('coinbase_get_candles').parameters.required).toEqual(['product_id', 'granularity', 'start', 'end']);
    mockedAxios.mockClear();
    await run('coinbase_get_spot_price', { currency_pair: 'ETH-EUR', date: '2024-02-29' });
    expect(sent().params).toEqual({ date: '2024-02-29' });
    expect(serializeRepeatedParams({ date: '2024-02-29' })).toBe('date=2024-02-29');
  });

  it('accepts real product ids and pairs, and refuses malformed ones', () => {
    const pid = new RegExp(tool('coinbase_get_product').parameters.properties!.product_id.pattern!);
    for (const ok of ['BTC-USD', 'ETH-EUR', 'SOL-USDC', '1INCH-USD', 'BIT-30OCT26-CDE']) expect(pid.test(ok)).toBe(true);
    for (const bad of ['btc-usd', 'BTCUSD', 'BTC-USD/../x', '']) expect(pid.test(bad)).toBe(false);
    const pair = new RegExp(tool('coinbase_get_spot_price').parameters.properties!.currency_pair.pattern!);
    for (const ok of ['BTC-EUR', 'USD-EUR', 'eth-usd']) expect(pair.test(ok)).toBe(true);
    for (const bad of ['BTC', 'BTC-EUR/buy', 'BTC-EUR-X']) expect(pair.test(bad)).toBe(false);
  });

  // Payloads captured from api.coinbase.com on 15 Oct 2026, trimmed.
  it('shapes a product list to the fields a price question needs', () => {
    const raw = {
      products: [
        {
          product_id: 'BTC-USD', price: '80124.98', price_percentage_change_24h: '-2.96', volume_24h: '6757.28', volume_percentage_change_24h: '22.2',
          base_increment: '0.00000001', quote_increment: '0.01', base_name: 'Bitcoin', quote_name: 'US Dollar', watched: false, status: 'online',
          trading_disabled: false, product_type: 'SPOT', approximate_quote_24h_volume: '541427525.69', high_24h: '83026.41', low_24h: '80124.64',
          fcm_trading_session_details: null, icon_url: '', about_description: '',
        },
      ],
      num_products: 925,
      pagination: { prev_cursor: '', next_cursor: 'cHJvZA==', has_next: true, has_prev: false },
    };
    expect(shape('coinbase_list_products', raw).value).toEqual({
      products: [
        {
          product_id: 'BTC-USD', base_name: 'Bitcoin', quote_name: 'US Dollar', price: '80124.98', price_percentage_change_24h: '-2.96',
          volume_24h: '6757.28', approximate_quote_24h_volume: '541427525.69', high_24h: '83026.41', low_24h: '80124.64', status: 'online',
          trading_disabled: false, product_type: 'SPOT',
        },
      ],
      numProducts: 925,
      hasNext: true,
    });
  });

  it('shapes trades, book, candles, spot price and server time', () => {
    const trades = shape('coinbase_get_market_trades', {
      trades: [{ trade_id: '1106450203', product_id: 'BTC-USD', price: '80137.89', size: '0.00000036', time: '2026-10-15T13:29:29.778961Z', side: 'BUY', bid: '', ask: '', exchange: 'coinbase' }],
      best_bid: '80137.89',
      best_ask: '80137.9',
    }).value;
    expect(trades).toEqual({ best_bid: '80137.89', best_ask: '80137.9', trades: [{ trade_id: '1106450203', price: '80137.89', size: '0.00000036', time: '2026-10-15T13:29:29.778961Z', side: 'BUY' }] });
    const book = shape('coinbase_get_product_book', {
      pricebook: { product_id: 'BTC-USD', bids: [{ price: '80137.89', size: '0.01636133' }], asks: [{ price: '80137.9', size: '0.52873738' }], time: '2026-10-15T13:29:30.103086Z' },
      last: '80137.895', mid_market: '80137.895', spread_bps: '0.00124784902', spread_absolute: '0.01',
    }).value;
    expect(book).toEqual({
      product_id: 'BTC-USD', time: '2026-10-15T13:29:30.103086Z', bids: [{ price: '80137.89', size: '0.01636133' }], asks: [{ price: '80137.9', size: '0.52873738' }],
      last: '80137.895', mid_market: '80137.895', spread_bps: '0.00124784902', spread_absolute: '0.01',
    });
    const candle = { start: '1792069200', low: '80114.22', high: '80561.35', open: '80445.43', close: '80137.89', volume: '175.56842252' };
    expect(shape('coinbase_get_candles', { candles: [candle] }).value).toEqual({ candles: [candle] });
    expect(shape('coinbase_get_spot_price', { data: { amount: '71539.635', base: 'BTC', currency: 'EUR' } }).value).toEqual({ amount: '71539.635', base: 'BTC', currency: 'EUR' });
    expect(shape('coinbase_get_server_time', { iso: '2026-10-15T13:29:29Z', epochSeconds: '1792070969', epochMillis: '1792070969588' }).value).toEqual({ iso: '2026-10-15T13:29:29Z', epochSeconds: '1792070969' });
    const product = shape('coinbase_get_product', { product_id: 'BTC-USD', price: '1', base_increment: '0.00000001', icon_color: '', status: 'online' }).value;
    expect(product).toEqual({ product_id: 'BTC-USD', price: '1', status: 'online' });
  });

  it('caps a 1,000-level order book that slipped past the limit', () => {
    const level = { price: '80137.89', size: '0.01636133' };
    const out = shape('coinbase_get_product_book', { pricebook: { product_id: 'BTC-USD', bids: Array(1000).fill(level), asks: Array(1000).fill(level), time: 't' } });
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(out.value).length).toBeLessThan(16_000);
  });
});

const live = process.env.RUN_COINBASE_LIVE === '1' ? describe : describe.skip;

live('coinbase adapter: live public API', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  it('reads the server time', async () => {
    const t = await runShaped('coinbase_get_server_time', {});
    expect(t.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Number(t.epochSeconds)).toBeGreaterThan(1_700_000_000);
  }, 30_000);

  it('lists a small page of products and looks up two pairs at once', async () => {
    const page = await runShaped('coinbase_list_products', {});
    expect(page.products.length).toBeGreaterThan(0);
    expect(page.products.length).toBeLessThanOrEqual(25);
    expect(typeof page.products[0].product_id).toBe('string');
    expect(typeof page.products[0].price).toBe('string');
    expect(page.hasNext).toBe(true);
    const two = await runShaped('coinbase_list_products', { product_ids: ['BTC-USD', 'ETH-EUR'] });
    expect(two.products.map((p: { product_id: string }) => p.product_id).sort()).toEqual(['BTC-USD', 'ETH-EUR']);
  }, 30_000);

  it('reads a product, its trades, its book and its candles', async () => {
    const p = await runShaped('coinbase_get_product', { product_id: 'BTC-USD' });
    expect(p.product_id).toBe('BTC-USD');
    expect(Number(p.price)).toBeGreaterThan(0);
    const trades = await runShaped('coinbase_get_market_trades', { product_id: 'BTC-USD', limit: 5 });
    expect(trades.trades).toHaveLength(5);
    expect(Number(trades.best_ask)).toBeGreaterThanOrEqual(Number(trades.best_bid));
    expect(Object.keys(trades.trades[0]).sort()).toEqual(['price', 'side', 'size', 'time', 'trade_id']);
    const book = await runShaped('coinbase_get_product_book', { product_id: 'BTC-USD' });
    expect(book.bids).toHaveLength(10);
    expect(book.asks).toHaveLength(10);
    expect(typeof book.spread_bps).toBe('string');
    const now = Number((await runShaped('coinbase_get_server_time', {})).epochSeconds);
    const candles = await runShaped('coinbase_get_candles', { product_id: 'BTC-USD', granularity: 'ONE_HOUR', start: String(now - 48 * 3600), end: String(now) });
    expect(candles.candles.length).toBeGreaterThan(40);
    expect(Object.keys(candles.candles[0]).sort()).toEqual(['close', 'high', 'low', 'open', 'start', 'volume']);
  }, 60_000);

  it('reads a spot price now and on a past day, and a fiat rate', async () => {
    const now = await runShaped('coinbase_get_spot_price', { currency_pair: 'BTC-EUR' });
    expect(now).toMatchObject({ base: 'BTC', currency: 'EUR' });
    expect(Number(now.amount)).toBeGreaterThan(0);
    const past = await runShaped('coinbase_get_spot_price', { currency_pair: 'BTC-USD', date: '2025-01-01' });
    expect(Number(past.amount)).toBeGreaterThan(50_000);
    const fx = await runShaped('coinbase_get_spot_price', { currency_pair: 'USD-EUR' });
    expect(Number(fx.amount)).toBeGreaterThan(0.5);
  }, 30_000);

  it('a pair that does not exist is a 404', async () => {
    await expect(run('coinbase_get_product', { product_id: 'NOPE-USD' })).rejects.toMatchObject({ response: { status: 404 } });
  }, 30_000);
});
