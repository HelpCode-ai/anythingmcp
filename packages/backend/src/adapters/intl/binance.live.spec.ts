import axios from 'axios';
import * as adapter from './binance.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Binance adapter:
 *
 *   1. Static: always runs. Pins the keyless connector (public Spot API at
 *      api.binance.com, USD-M futures at fapi.binance.com through absolute
 *      tool paths, authType NONE), the read-only guarantee (every tool is a GET
 *      on a public market data route; no signed, account or order route), every
 *      tool's URL and query through the real RestEngine, the page sizes that
 *      keep answers small, and the response mappings against payloads captured
 *      from the live API on 18 Oct 2026. Paths and parameters checked against
 *      the Spot REST docs (github.com/binance/binance-spot-api-docs, rest-api.md)
 *      and the official USD-M futures connector
 *      (binance-connector-js, derivatives-trading-usds-futures market-data-api.ts).
 *
 *   2. Live: skipped unless RUN_BINANCE_LIVE=1. The endpoints are public, so
 *      no credentials are needed, but Binance answers 451 from the United
 *      States and some other regions:
 *
 *        RUN_BINANCE_LIVE=1 npx jest src/adapters/intl/binance.live.spec.ts
 *
 *      Runs every tool against Binance and applies each tool's responseMapping
 *      the way the MCP layer does. There are no writes.
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

type Schema = { description?: string; default?: unknown; maximum?: number; pattern?: string; enum?: unknown[] };
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, Schema>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: { transform?: Record<string, any> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  description: string;
  aliases: string[];
  requiredEnvVars: string[];
  envVarMeta?: unknown;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig?: unknown; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const SPOT = 'https://api.binance.com';
const FUT = 'https://fapi.binance.com';
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
const run = async (name: string, params: Record<string, unknown>) => {
  const { body } = await engine().executeWithMeta(
    { baseUrl: a.connector.baseUrl, authType: a.connector.authType, headers: a.connector.headers },
    tool(name).endpointMapping,
    applySchemaDefaults(tool(name).parameters as never, params),
  );
  return body as any;
};
const shape = (name: string, raw: unknown) =>
  applyResponseTransform(raw, tool(name).responseMapping as never) as { value: any; truncated?: boolean };
const runShaped = async (name: string, params: Record<string, unknown>) => shape(name, await run(name, params)).value as any;
const sent = () => mockedAxios.mock.calls[0][0];

// Anything that would touch an account, an order or money.
const ACCOUNT_ROUTES = /\/(sapi|papi|dapi)\/|\/(order|openOrders|allOrders|orderList|account|myTrades|userDataStream|listenKey|balance|positionRisk|positionSide|leverage|marginType|income|commissionRate|wallet|asset|transfer|withdraw|deposit|historicalTrades)(\/|$)/i;

describe('binance adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed in finance with its own icon', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('binance');
    expect(a.icon).toBe('binance');
    expect(a.category).toBe('finance');
    expect(a.aliases).toEqual(expect.arrayContaining(['Binance Futures']));
  });

  it('is keyless: public market data, no credentials of any kind', () => {
    expect(a.connector.baseUrl).toBe(SPOT);
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.envVarMeta).toBeUndefined();
    expect(JSON.stringify(adapter)).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(JSON.stringify(adapter)).not.toMatch(/X-MBX-APIKEY|signature|timestamp=/i);
    expect(a.connector.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'AnythingMCP' });
    expect(a.connector.healthcheckPath).toBe('/api/v3/ping');
    expect(a.probe.tool).toBe('binance_get_server_time');
    expect(tool('binance_get_server_time').parameters.required).toBeUndefined();
    for (const status of ['451', '418', '429']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('cannot trade or move funds: every tool is a GET on a public market data route, none is switched off', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(t.endpointMapping.bodyMapping).toBeUndefined();
      expect(t.enabled).toBeUndefined();
      expect(t.annotations).toBeUndefined();
      expect(annotationsOf(t)).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.endpointMapping.path).toMatch(/^(\/api\/v3\/[A-Za-z0-9/]+|https:\/\/fapi\.binance\.com\/(fapi\/v[12]|futures\/data)\/[A-Za-z0-9/]+)$/);
      expect(`${t.name}:${ACCOUNT_ROUTES.test(t.endpointMapping.path)}`).toBe(`${t.name}:false`);
    }
    expect(a.instructions).toContain('Read-only by design: this connector cannot trade or move funds.');
    expect(a.description).toMatch(/cannot trade or move funds/);
  });

  it('sends futures tools to fapi.binance.com and spot tools to api.binance.com', () => {
    for (const t of a.tools) {
      const futures = t.name.startsWith('binance_futures_');
      expect(`${t.name}:${t.endpointMapping.path.startsWith(`${FUT}/`)}`).toBe(`${t.name}:${futures}`);
    }
  });

  it('says that market data is not financial advice and where Binance refuses service', () => {
    expect(a.instructions).toContain('**Not financial advice.**');
    for (const t of a.tools.filter((x) => !/server_time|list_symbols|symbol_info/.test(x.name))) {
      expect(`${t.name}:${/not financial advice/.test(t.description)}`).toBe(`${t.name}:true`);
    }
    expect(a.instructions).toMatch(/451/);
    expect(a.instructions).toContain('api.binance.us');
    expect(a.instructions).toMatch(/6,000 weight per minute on spot, 2,400 on futures/);
    expect(a.instructions).toMatch(/418/);
  });

  it('prefixes every tool with binance_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^binance_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('documents every parameter, names every tool in the instructions, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bbinance_[a-z0-9_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bbinance_[a-z0-9_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions.startsWith('## Binance\n')).toBe(true);
    expect(a.instructions).toContain('Out of scope');
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
      for (const [key, value] of Object.entries(t.endpointMapping.queryParams ?? {})) {
        if (typeof value === 'string' && value.startsWith('$')) expect(`${t.name}.${key}:${value.slice(1) in (t.parameters.properties ?? {})}`).toBe(`${t.name}.${key}:true`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('gives every tool a valid response mapping that does real work', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:true`);
      expect(validateTransform(tr)).toBeNull();
      expect(tr!.select ?? tr!.expression).toBeDefined();
    }
  });

  it('caps every list: default page sizes and maxima keep answers small', () => {
    const caps: Record<string, [number, number]> = {
      binance_get_order_book: [20, 500],
      binance_get_recent_trades: [20, 500],
      binance_get_klines: [100, 500],
      binance_futures_get_klines: [100, 500],
      binance_futures_get_funding_rate_history: [100, 500],
      binance_futures_get_open_interest_history: [30, 500],
      binance_futures_get_long_short_ratio: [30, 500],
    };
    for (const [name, [def, max]] of Object.entries(caps)) {
      const limit = tool(name).parameters.properties!.limit;
      expect(`${name}:${limit.default}:${limit.maximum}`).toBe(`${name}:${def}:${max}`);
      expect(tool(name).endpointMapping.queryParams!.limit).toBe('$limit');
    }
    expect(tool('binance_futures_get_order_book').parameters.properties!.limit).toMatchObject({ default: 20, enum: [5, 10, 20, 50, 100, 500] });
    for (const t of a.tools.filter((x) => !/(?:server_time|avg_price|open_interest)$/.test(x.name))) {
      expect(`${t.name}:${(t.responseMapping!.transform!.maxBytes ?? 0) > 0}`).toBe(`${t.name}:true`);
    }
  });

  const table: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
    ['binance_get_server_time', {}, `${SPOT}/api/v3/time`, {}],
    ['binance_list_symbols', {}, `${SPOT}/api/v3/exchangeInfo`, { permissions: 'SPOT', showPermissionSets: 'false', symbolStatus: 'TRADING' }],
    ['binance_get_symbol_info', { symbol: 'BTCUSDT' }, `${SPOT}/api/v3/exchangeInfo`, { symbol: 'BTCUSDT', showPermissionSets: 'false' }],
    ['binance_get_price', { symbol: 'BTCUSDT' }, `${SPOT}/api/v3/ticker/price`, { symbol: 'BTCUSDT' }],
    ['binance_get_24h_ticker', { symbols: '["BTCUSDT","ETHUSDT"]' }, `${SPOT}/api/v3/ticker/24hr`, { symbols: '["BTCUSDT","ETHUSDT"]' }],
    ['binance_get_rolling_ticker', { symbol: 'BTCUSDT' }, `${SPOT}/api/v3/ticker`, { symbol: 'BTCUSDT', windowSize: '1d' }],
    ['binance_get_book_ticker', { symbol: 'BTCUSDT' }, `${SPOT}/api/v3/ticker/bookTicker`, { symbol: 'BTCUSDT' }],
    ['binance_get_avg_price', { symbol: 'BTCUSDT' }, `${SPOT}/api/v3/avgPrice`, { symbol: 'BTCUSDT' }],
    ['binance_get_order_book', { symbol: 'BTCUSDT' }, `${SPOT}/api/v3/depth`, { symbol: 'BTCUSDT', limit: 20 }],
    ['binance_get_recent_trades', { symbol: 'BTCUSDT' }, `${SPOT}/api/v3/trades`, { symbol: 'BTCUSDT', limit: 20 }],
    ['binance_get_klines', { symbol: 'BTCUSDT', interval: '1d' }, `${SPOT}/api/v3/klines`, { symbol: 'BTCUSDT', interval: '1d', limit: 100 }],
    ['binance_futures_list_symbols', {}, `${FUT}/fapi/v1/exchangeInfo`, {}],
    ['binance_futures_get_price', { symbol: 'BTCUSDT' }, `${FUT}/fapi/v2/ticker/price`, { symbol: 'BTCUSDT' }],
    ['binance_futures_get_24h_ticker', { symbol: 'BTCUSDT' }, `${FUT}/fapi/v1/ticker/24hr`, { symbol: 'BTCUSDT' }],
    ['binance_futures_get_klines', { symbol: 'BTCUSDT', interval: '1h' }, `${FUT}/fapi/v1/klines`, { symbol: 'BTCUSDT', interval: '1h', limit: 100 }],
    ['binance_futures_get_mark_price', { symbol: 'BTCUSDT' }, `${FUT}/fapi/v1/premiumIndex`, { symbol: 'BTCUSDT' }],
    ['binance_futures_get_funding_rate_history', { symbol: 'BTCUSDT' }, `${FUT}/fapi/v1/fundingRate`, { symbol: 'BTCUSDT', limit: 100 }],
    ['binance_futures_get_open_interest', { symbol: 'BTCUSDT' }, `${FUT}/fapi/v1/openInterest`, { symbol: 'BTCUSDT' }],
    ['binance_futures_get_open_interest_history', { symbol: 'BTCUSDT', period: '1h' }, `${FUT}/futures/data/openInterestHist`, { symbol: 'BTCUSDT', period: '1h', limit: 30 }],
    ['binance_futures_get_long_short_ratio', { symbol: 'BTCUSDT', period: '1h' }, `${FUT}/futures/data/globalLongShortAccountRatio`, { symbol: 'BTCUSDT', period: '1h', limit: 30 }],
    ['binance_futures_get_order_book', { symbol: 'BTCUSDT' }, `${FUT}/fapi/v1/depth`, { symbol: 'BTCUSDT', limit: 20 }],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends a GET to the documented URL and query, without credentials', async (name, params, url, query) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await run(name, params);
    expect(sent().method).toBe('GET');
    expect(sent().url).toBe(url);
    expect(sent().params ?? {}).toEqual(query);
    expect(sent().headers.Authorization).toBeUndefined();
    expect(sent().headers['X-MBX-APIKEY']).toBeUndefined();
    expect(sent().data).toBeUndefined();
  });

  it('sends symbols as one JSON array value, the way Binance parses it', async () => {
    mockedAxios.mockResolvedValue({ data: [] });
    await run('binance_get_price', { symbols: '["BTCUSDT","ETHUSDT"]' });
    // Checked live: %5B%22BTCUSDT%22,%22ETHUSDT%22%5D works; BTCUSDT,ETHUSDT is refused with -1100.
    expect(sent().paramsSerializer(sent().params)).toBe('symbols=%5B%22BTCUSDT%22,%22ETHUSDT%22%5D');
  });

  it('accepts real symbols, windows and time zones, and refuses malformed ones', () => {
    const sym = new RegExp(tool('binance_get_price').parameters.properties!.symbol.pattern!);
    for (const ok of ['BTCUSDT', 'ETHBTC', '1INCHUSDT', 'BTCUSDT_261225']) expect(sym.test(ok)).toBe(true);
    for (const bad of ['btcusdt', 'BTC USDT', 'BTC/USDT', 'BTCUSDT&x=1', '']) expect(sym.test(bad)).toBe(false);
    const syms = new RegExp(tool('binance_get_price').parameters.properties!.symbols.pattern!);
    for (const ok of ['["BTCUSDT"]', '["BTCUSDT","ETHUSDT"]']) expect(syms.test(ok)).toBe(true);
    for (const bad of ['BTCUSDT,ETHUSDT', '["BTCUSDT", "ETHUSDT"]', '[]', "['BTCUSDT']"]) expect(syms.test(bad)).toBe(false);
    const win = new RegExp(tool('binance_get_rolling_ticker').parameters.properties!.windowSize.pattern!);
    // Checked live: 1m, 59m, 1h, 23h, 1d and 7d work; 60m, 24h and 8d answer -1102.
    for (const ok of ['1m', '59m', '1h', '23h', '1d', '7d']) expect(win.test(ok)).toBe(true);
    for (const bad of ['60m', '24h', '8d', '1d2h', '0m']) expect(win.test(bad)).toBe(false);
    const tz = new RegExp(tool('binance_get_klines').parameters.properties!.timeZone.pattern!);
    for (const ok of ['0', '8', '-1:00', '05:45', '+14']) expect(tz.test(ok)).toBe(true);
    expect(tool('binance_get_klines').parameters.properties!.interval.enum).toContain('1s');
    expect(tool('binance_futures_get_klines').parameters.properties!.interval.enum).not.toContain('1s');
  });

  // Payloads captured from api.binance.com and fapi.binance.com on 18 Oct 2026, trimmed.
  it('turns klines into named fields', () => {
    const raw = [[1792195200000, '81615.91000000', '81770.01000000', '80819.66000000', '81491.04000000', '7038.87186000', 1792281599999, '573731477.30699520', 1168469, '3815.09423000', '310985629.91126200', '0']];
    const want = {
      openTime: 1792195200000, open: '81615.91000000', high: '81770.01000000', low: '80819.66000000', close: '81491.04000000', volume: '7038.87186000',
      closeTime: 1792281599999, quoteVolume: '573731477.30699520', trades: 1168469, takerBuyBaseVolume: '3815.09423000', takerBuyQuoteVolume: '310985629.91126200',
    };
    expect(shape('binance_get_klines', raw).value).toEqual([want]);
    expect(shape('binance_futures_get_klines', raw).value).toEqual([want]);
  });

  it('returns a list for one symbol and for several', () => {
    expect(shape('binance_get_price', { symbol: 'BTCUSDT', price: '80924.15000000' }).value).toEqual([{ symbol: 'BTCUSDT', price: '80924.15000000' }]);
    expect(shape('binance_get_price', [{ symbol: 'BTCUSDT', price: '1' }, { symbol: 'ETHUSDT', price: '2' }]).value).toHaveLength(2);
    const t24 = shape('binance_get_24h_ticker', {
      symbol: 'BTCUSDT', priceChange: '-641.84000000', priceChangePercent: '-0.787', weightedAvgPrice: '81565.28789811', prevClosePrice: '81565.99000000',
      lastPrice: '80924.16000000', lastQty: '0.01515000', bidPrice: '80924.15000000', bidQty: '5.68682000', askPrice: '80924.16000000', askQty: '3.06087000',
      openPrice: '81566.00000000', highPrice: '82295.47000000', lowPrice: '80819.66000000', volume: '9003.45754000', quoteVolume: '734369606.32847490',
      openTime: 1792265814002, closeTime: 1792352214002, firstId: 6771035791, lastId: 6772549795, count: 1514005,
    }).value;
    expect(t24).toHaveLength(1);
    expect(t24[0]).toMatchObject({ symbol: 'BTCUSDT', lastPrice: '80924.16000000', priceChangePercent: '-0.787', quoteVolume: '734369606.32847490', count: 1514005 });
    expect(t24[0].firstId).toBeUndefined();
    expect(shape('binance_get_book_ticker', { symbol: 'BTCUSDT', bidPrice: '1', bidQty: '2', askPrice: '3', askQty: '4' }).value).toEqual([
      { symbol: 'BTCUSDT', bidPrice: '1', bidQty: '2', askPrice: '3', askQty: '4' },
    ]);
  });

  it('sorts all futures tickers by quote volume and all mark prices by the size of the funding rate', () => {
    const tickers = [
      { symbol: 'AAAUSDT', quoteVolume: '1000.5', lastPrice: '1' },
      { symbol: 'BTCUSDT', quoteVolume: '6907187115.71', lastPrice: '80887.10' },
      { symbol: 'ETHUSDT', quoteVolume: '30000000', lastPrice: '2345' },
    ];
    expect(shape('binance_futures_get_24h_ticker', tickers).value.map((t: any) => t.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'AAAUSDT']);
    const marks = [
      { symbol: 'BTCUSDT', markPrice: '80891.8', indexPrice: '80925.1', estimatedSettlePrice: '81099.7', lastFundingRate: '-0.00000484', interestRate: '0.0001', nextFundingTime: 1792368000000, time: 1792352216000 },
      { symbol: 'XUSDT', markPrice: '1', indexPrice: '1', lastFundingRate: '-0.0150', interestRate: '0.0001', nextFundingTime: 1, time: 1 },
      { symbol: 'YUSDT', markPrice: '1', indexPrice: '1', lastFundingRate: '0.0030', interestRate: '0.0001', nextFundingTime: 1, time: 1 },
    ];
    const out = shape('binance_futures_get_mark_price', marks).value;
    expect(out.map((m: any) => m.symbol)).toEqual(['XUSDT', 'YUSDT', 'BTCUSDT']);
    expect(out[2]).toEqual({ symbol: 'BTCUSDT', markPrice: '80891.8', indexPrice: '80925.1', lastFundingRate: '-0.00000484', interestRate: '0.0001', nextFundingTime: 1792368000000, time: 1792352216000 });
    expect(shape('binance_futures_get_mark_price', marks[0]).value).toHaveLength(1);
  });

  it('lists symbol names only and groups futures contracts', () => {
    const spot = { timezone: 'UTC', rateLimits: [], symbols: [{ symbol: 'BTCUSDT', status: 'TRADING', filters: [{}] }, { symbol: 'ETHBTC', status: 'TRADING', filters: [{}] }] };
    expect(shape('binance_list_symbols', spot).value).toEqual({ count: 2, symbols: ['BTCUSDT', 'ETHBTC'] });
    const fut = {
      symbols: [
        { symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', filters: [{}] },
        { symbol: 'AAPLUSDT', status: 'TRADING', contractType: 'TRADIFI_PERPETUAL' },
        { symbol: 'OLDUSDT', status: 'SETTLING', contractType: 'PERPETUAL' },
        { symbol: 'BTCUSDT_261225', status: 'TRADING', contractType: 'CURRENT_QUARTER' },
        { symbol: 'BTCUSDT_270326', status: 'TRADING', contractType: 'NEXT_QUARTER' },
      ],
    };
    expect(shape('binance_futures_list_symbols', fut).value).toEqual({ perpetual: ['BTCUSDT'], tradfiPerpetual: ['AAPLUSDT'], delivery: ['BTCUSDT_261225', 'BTCUSDT_270326'] });
  });

  it('keeps the trading rules of a pair and drops the permission sets', () => {
    const raw = {
      timezone: 'UTC', serverTime: 1792352401468, rateLimits: [{ rateLimitType: 'REQUEST_WEIGHT', limit: 6000 }], exchangeFilters: [],
      symbols: [{
        symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', baseAssetPrecision: 8, quoteAsset: 'USDT', quotePrecision: 8, quoteAssetPrecision: 8,
        orderTypes: ['LIMIT', 'MARKET'], icebergAllowed: true, isSpotTradingAllowed: true, isMarginTradingAllowed: true,
        filters: [{ filterType: 'PRICE_FILTER', minPrice: '0.01000000', maxPrice: '1000000.00000000', tickSize: '0.01000000' }],
        permissions: [], permissionSets: [['SPOT', 'MARGIN', 'TRD_GRP_004']], defaultSelfTradePreventionMode: 'EXPIRE_MAKER',
      }],
    };
    const out = shape('binance_get_symbol_info', raw).value;
    expect(out.symbols[0]).toMatchObject({ symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT', filters: raw.symbols[0].filters });
    expect(JSON.stringify(out)).not.toMatch(/permissionSets|TRD_GRP|rateLimits/);
  });

  it('shapes trades, books, funding, open interest and ratios', () => {
    expect(shape('binance_get_recent_trades', [{ id: 6772549794, price: '80924.16', qty: '0.0092', quoteQty: '744.50', time: 1792352213136, isBuyerMaker: false, isBestMatch: true }]).value).toEqual([
      { id: 6772549794, price: '80924.16', qty: '0.0092', quoteQty: '744.50', time: 1792352213136, isBuyerMaker: false },
    ]);
    expect(shape('binance_futures_get_order_book', { lastUpdateId: 11854773377462, E: 1792352217729, T: 1792352217725, bids: [['80891.70', '4.366']], asks: [['80891.80', '2.891']] }).value).toEqual({
      lastUpdateId: 11854773377462, time: 1792352217725, bids: [['80891.70', '4.366']], asks: [['80891.80', '2.891']],
    });
    expect(shape('binance_futures_get_funding_rate_history', [{ symbol: 'BTCUSDT', fundingTime: 1792310400002, fundingRate: '0.00006030', markPrice: '81645.00000000', rateType: 'Regular' }]).value).toEqual([
      { symbol: 'BTCUSDT', fundingTime: 1792310400002, fundingRate: '0.00006030', markPrice: '81645.00000000' },
    ]);
    expect(shape('binance_futures_get_open_interest_history', [{ symbol: 'BTCUSDT', sumOpenInterest: '93595.524', sumOpenInterestValue: '7595267413.04', CMCCirculatingSupply: '20098843', timestamp: 1792346400000 }]).value).toEqual([
      { symbol: 'BTCUSDT', sumOpenInterest: '93595.524', sumOpenInterestValue: '7595267413.04', timestamp: 1792346400000 },
    ]);
    expect(shape('binance_futures_get_long_short_ratio', [{ symbol: 'BTCUSDT', longAccount: '0.6464', longShortRatio: '1.8281', shortAccount: '0.3536', timestamp: 1792346400000 }]).value).toEqual([
      { symbol: 'BTCUSDT', longShortRatio: '1.8281', longAccount: '0.6464', shortAccount: '0.3536', timestamp: 1792346400000 },
    ]);
    expect(shape('binance_get_server_time', { serverTime: 1792352212431 }).value).toEqual({ serverTime: 1792352212431 });
  });

  it('cuts a list that slipped past the limit to whole items', () => {
    const many = Array.from({ length: 3500 }, (_, i) => ({ symbol: `S${i}USDT`, price: '1.00000000' }));
    const out = shape('binance_get_price', many);
    expect(out.truncated).toBe(true);
    expect(out.value.items.length).toBeGreaterThan(100);
    expect(JSON.stringify(out.value).length).toBeLessThan(45_000);
  });
});

const live = process.env.RUN_BINANCE_LIVE === '1' ? describe : describe.skip;

live('binance adapter: live public API', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  it('reads the server time and lists spot and futures symbols', async () => {
    const t = await runShaped('binance_get_server_time', {});
    expect(t.serverTime).toBeGreaterThan(1_700_000_000_000);
    const spot = await runShaped('binance_list_symbols', {});
    expect(spot.count).toBeGreaterThan(500);
    expect(spot.symbols).toContain('BTCUSDT');
    const fut = await runShaped('binance_futures_list_symbols', {});
    expect(fut.perpetual).toContain('BTCUSDT');
  }, 60_000);

  it('reads spot prices, tickers, book, trades, klines and rules', async () => {
    const one = await runShaped('binance_get_price', { symbol: 'BTCUSDT' });
    expect(one).toHaveLength(1);
    expect(Number(one[0].price)).toBeGreaterThan(0);
    const two = await runShaped('binance_get_price', { symbols: '["BTCUSDT","ETHUSDT"]' });
    expect(two.map((p: { symbol: string }) => p.symbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
    const t24 = await runShaped('binance_get_24h_ticker', { symbol: 'ETHUSDT' });
    expect(typeof t24[0].priceChangePercent).toBe('string');
    const roll = await runShaped('binance_get_rolling_ticker', { symbol: 'BTCUSDT', windowSize: '7d' });
    expect(Number(roll[0].highPrice)).toBeGreaterThanOrEqual(Number(roll[0].lowPrice));
    const bt = await runShaped('binance_get_book_ticker', { symbol: 'BTCUSDT' });
    expect(Number(bt[0].askPrice)).toBeGreaterThanOrEqual(Number(bt[0].bidPrice));
    expect((await runShaped('binance_get_avg_price', { symbol: 'BTCUSDT' })).mins).toBeGreaterThan(0);
    const book = await runShaped('binance_get_order_book', { symbol: 'BTCUSDT', limit: 5 });
    expect(book.bids).toHaveLength(5);
    expect(await runShaped('binance_get_recent_trades', { symbol: 'BTCUSDT', limit: 3 })).toHaveLength(3);
    const k = await runShaped('binance_get_klines', { symbol: 'BTCUSDT', interval: '1h', limit: 24 });
    expect(k).toHaveLength(24);
    expect(Object.keys(k[0])).toEqual(expect.arrayContaining(['openTime', 'open', 'high', 'low', 'close', 'volume']));
    const info = await runShaped('binance_get_symbol_info', { symbol: 'BTCUSDT' });
    expect(info.symbols[0].filters.map((f: { filterType: string }) => f.filterType)).toContain('PRICE_FILTER');
  }, 60_000);

  it('reads futures prices, candles, funding, open interest, ratio and book', async () => {
    expect(Number((await runShaped('binance_futures_get_price', { symbol: 'BTCUSDT' }))[0].price)).toBeGreaterThan(0);
    expect((await runShaped('binance_futures_get_24h_ticker', { symbol: 'BTCUSDT' }))[0].symbol).toBe('BTCUSDT');
    expect(await runShaped('binance_futures_get_klines', { symbol: 'BTCUSDT', interval: '4h', limit: 6 })).toHaveLength(6);
    const mark = await runShaped('binance_futures_get_mark_price', { symbol: 'BTCUSDT' });
    expect(mark[0].nextFundingTime).toBeGreaterThan(Date.now() - 60_000);
    expect(await runShaped('binance_futures_get_funding_rate_history', { symbol: 'BTCUSDT', limit: 3 })).toHaveLength(3);
    expect(Number((await runShaped('binance_futures_get_open_interest', { symbol: 'BTCUSDT' })).openInterest)).toBeGreaterThan(0);
    expect(await runShaped('binance_futures_get_open_interest_history', { symbol: 'BTCUSDT', period: '1h', limit: 2 })).toHaveLength(2);
    expect(await runShaped('binance_futures_get_long_short_ratio', { symbol: 'BTCUSDT', period: '1h', limit: 2 })).toHaveLength(2);
    expect((await runShaped('binance_futures_get_order_book', { symbol: 'BTCUSDT', limit: 5 })).asks).toHaveLength(5);
  }, 60_000);

  it('keeps answers without a symbol small, most traded or most extreme first', async () => {
    const all = shape('binance_futures_get_24h_ticker', await run('binance_futures_get_24h_ticker', {}));
    expect(all.truncated).toBe(true);
    expect(all.value.items[0].symbol).toMatch(/^(BTC|ETH)USDT$/);
    const marks = shape('binance_futures_get_mark_price', await run('binance_futures_get_mark_price', {}));
    const rates = (marks.value.items ?? marks.value).map((m: { lastFundingRate: string }) => Math.abs(Number(m.lastFundingRate)));
    expect(rates[0]).toBeGreaterThanOrEqual(rates[rates.length - 1]);
  }, 60_000);

  it('an unknown symbol is a 400 with code -1121', async () => {
    await expect(run('binance_get_price', { symbol: 'NOPEUSDT' })).rejects.toMatchObject({ response: { status: 400, data: { code: -1121 } } });
  }, 30_000);
});
