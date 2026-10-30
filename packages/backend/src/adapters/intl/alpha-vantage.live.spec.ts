import * as adapter from './alpha-vantage.json';
import { assertNoResponseBodyError } from '../../connectors/engines/response-error.util';

/**
 * Alpha Vantage API (alphavantage.co/documentation/): every call is GET /query?function=<NAME>&apikey=<key>.
 * Errors arrive as HTTP 200 with "Error Message", "Information" or "Note", mapped by connector.config.errorWhen.
 * Live part: RUN_ALPHA_VANTAGE_LIVE=1 ALPHA_VANTAGE_API_KEY=... npx jest src/adapters/intl/alpha-vantage
 * (reads only, on the IBM examples that Alpha Vantage's published demo key also serves).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { default?: unknown; enum?: unknown[]; pattern?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string>; config?: { errorWhen?: unknown[] } };
  tools: Tool[];
};
const KEY = 'ALPHA_VANTAGE_API_KEY';
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
const PREFIX = 'alpha_vantage_';
const statusOf = (body: unknown): number | undefined => {
  try {
    assertNoResponseBodyError(body, a.connector.config?.errorWhen);
    return undefined;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};

describe('alpha-vantage adapter: static spec conformance', () => {
  it('sends the key as the apikey query parameter to alphavantage.co', () => {
    expect(a.slug).toBe('alpha-vantage');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('finance');
    expect(a.icon).toBe('alpha-vantage');
    expect(a.docsUrl).toBe('https://www.alphavantage.co/documentation/');
    expect(a.requiredEnvVars).toEqual([KEY]);
    expect(a.connector.baseUrl).toBe('https://www.alphavantage.co');
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ apikey: `{{${KEY}}}` });
    expect(a.envVarMeta?.[KEY]).toMatchObject({ kind: 'credential', secret: true });
    const pattern = new RegExp(a.envVarMeta?.[KEY].pattern as string);
    expect(pattern.test(['ABCD', 'EFGH', '1234', '5678'].join(''))).toBe(true);
    expect(pattern.test('apikey=ABCD1234')).toBe(false);
  });

  it('calls GET /query with the documented function for every tool', () => {
    const fixed: Record<string, string> = {
      alpha_vantage_get_quote: 'GLOBAL_QUOTE',
      alpha_vantage_get_bulk_quotes: 'REALTIME_BULK_QUOTES',
      alpha_vantage_get_intraday: 'TIME_SERIES_INTRADAY',
      alpha_vantage_search_symbols: 'SYMBOL_SEARCH',
      alpha_vantage_get_market_status: 'MARKET_STATUS',
      alpha_vantage_get_top_movers: 'TOP_GAINERS_LOSERS',
      alpha_vantage_get_news_sentiment: 'NEWS_SENTIMENT',
      alpha_vantage_get_company_overview: 'OVERVIEW',
      alpha_vantage_get_etf_profile: 'ETF_PROFILE',
      alpha_vantage_get_income_statement: 'INCOME_STATEMENT',
      alpha_vantage_get_balance_sheet: 'BALANCE_SHEET',
      alpha_vantage_get_cash_flow: 'CASH_FLOW',
      alpha_vantage_get_earnings: 'EARNINGS',
      alpha_vantage_get_earnings_estimates: 'EARNINGS_ESTIMATES',
      alpha_vantage_get_shares_outstanding: 'SHARES_OUTSTANDING',
      alpha_vantage_get_insider_transactions: 'INSIDER_TRANSACTIONS',
      alpha_vantage_get_institutional_holdings: 'INSTITUTIONAL_HOLDINGS',
      alpha_vantage_get_earnings_call_transcript: 'EARNINGS_CALL_TRANSCRIPT',
      alpha_vantage_get_index_data: 'INDEX_DATA',
      alpha_vantage_list_indices: 'INDEX_CATALOG',
      alpha_vantage_get_exchange_rate: 'CURRENCY_EXCHANGE_RATE',
    };
    const chosen: Record<string, string[]> = {
      alpha_vantage_get_time_series: ['TIME_SERIES_DAILY', 'TIME_SERIES_DAILY_ADJUSTED', 'TIME_SERIES_WEEKLY', 'TIME_SERIES_WEEKLY_ADJUSTED', 'TIME_SERIES_MONTHLY', 'TIME_SERIES_MONTHLY_ADJUSTED'],
      alpha_vantage_get_corporate_actions: ['DIVIDENDS', 'SPLITS'],
      alpha_vantage_get_options: ['HISTORICAL_OPTIONS', 'REALTIME_OPTIONS'],
      alpha_vantage_get_fx_time_series: ['FX_DAILY', 'FX_WEEKLY', 'FX_MONTHLY', 'FX_INTRADAY'],
      alpha_vantage_get_crypto_time_series: ['DIGITAL_CURRENCY_DAILY', 'DIGITAL_CURRENCY_WEEKLY', 'DIGITAL_CURRENCY_MONTHLY', 'CRYPTO_INTRADAY'],
      alpha_vantage_get_commodity: ['WTI', 'BRENT', 'NATURAL_GAS', 'COPPER', 'ALUMINUM', 'WHEAT', 'CORN', 'COTTON', 'SUGAR', 'COFFEE', 'ALL_COMMODITIES'],
      alpha_vantage_get_precious_metals: ['GOLD_SILVER_SPOT', 'GOLD_SILVER_HISTORY'],
      alpha_vantage_get_economic_indicator: ['REAL_GDP', 'REAL_GDP_PER_CAPITA', 'TREASURY_YIELD', 'FEDERAL_FUNDS_RATE', 'CPI', 'INFLATION', 'RETAIL_SALES', 'DURABLES', 'UNEMPLOYMENT', 'NONFARM_PAYROLL'],
    };
    expect(a.tools.map((t) => t.name).sort()).toEqual([...Object.keys(fixed), ...Object.keys(chosen), 'alpha_vantage_get_technical_indicator'].sort());
    for (const t of a.tools) expect(t.endpointMapping).toMatchObject({ method: 'GET', path: '/query' });
    for (const [name, fn] of Object.entries(fixed)) expect(`${name}:${tool(name).endpointMapping.queryParams?.function}`).toBe(`${name}:${fn}`);
    for (const [name, fns] of Object.entries(chosen)) {
      expect(tool(name).endpointMapping.queryParams?.function).toBe('$function');
      expect(tool(name).parameters?.properties?.function.enum).toEqual(fns);
      expect(tool(name).parameters?.required).toContain('function');
    }
    const tech = tool('alpha_vantage_get_technical_indicator').parameters?.properties?.function.enum ?? [];
    for (const f of ['SMA', 'EMA', 'RSI', 'MACD', 'BBANDS', 'STOCH', 'ADX', 'ATR', 'OBV', 'VWAP', 'HT_PHASOR']) expect(tech).toContain(f);
    expect(tech).toHaveLength(53);
  });

  it('exposes the documented options of the main reads', () => {
    expect(tool('alpha_vantage_get_intraday').parameters?.properties?.interval.enum).toEqual(['1min', '5min', '15min', '30min', '60min']);
    expect(tool('alpha_vantage_get_intraday').endpointMapping.queryParams).toMatchObject({ adjusted: '$adjusted', extended_hours: '$extended_hours', month: '$month', outputsize: '$outputsize', entitlement: '$entitlement' });
    expect(tool('alpha_vantage_get_time_series').parameters?.properties?.outputsize.default).toBe('compact');
    expect(tool('alpha_vantage_get_news_sentiment').endpointMapping.queryParams).toMatchObject({ tickers: '$tickers', topics: '$topics', time_from: '$time_from', time_to: '$time_to', sort: '$sort', limit: '$limit' });
    expect(tool('alpha_vantage_get_economic_indicator').parameters?.properties?.maturity.enum).toEqual(['3month', '2year', '5year', '7year', '10year', '30year']);
    expect(tool('alpha_vantage_get_precious_metals').parameters?.properties?.symbol.enum).toEqual(['GOLD', 'XAU', 'SILVER', 'XAG']);
    expect(new RegExp(tool('alpha_vantage_get_earnings_call_transcript').parameters?.properties?.quarter.pattern as string).test('2026Q2')).toBe(true);
    expect(tool('alpha_vantage_get_quote').parameters?.properties?.entitlement.enum).toEqual(['realtime', 'delayed']);
  });

  it('turns the errors Alpha Vantage sends with HTTP 200 into failed calls', () => {
    expect(statusOf({ 'Error Message': 'the parameter apikey is invalid or missing. Please claim your free API key' })).toBe(401);
    expect(statusOf({ 'Error Message': 'Invalid API call. Please retry or visit the documentation for TIME_SERIES_DAILY.' })).toBe(400);
    expect(statusOf({ Information: 'Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day.' })).toBe(429);
    expect(statusOf({ Information: 'Thank you for using Alpha Vantage! This is a premium endpoint.' })).toBe(403);
    expect(statusOf({ Note: 'Thank you for using Alpha Vantage! Please consider spreading out your free API requests more sparingly.' })).toBe(429);
    expect(statusOf({ endpoint: 'Realtime Bulk Quotes', message: 'This is a premium endpoint. THE SAMPLE DATA SCHEMA BELOW IS ARTIFICIAL', data: [] })).toBe(403);
    expect(statusOf({ 'Global Quote': { '01. symbol': 'IBM', '05. price': '257.81' } })).toBeUndefined();
    expect(statusOf({ endpoint: 'Global Market Open & Close Status', markets: [] })).toBeUndefined();
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('is read-only: every tool is a GET marked read-only and installs enabled', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe.tool).toBe('alpha_vantage_get_market_status');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_ALPHA_VANTAGE_LIVE === '1' && process.env[KEY] ? describe : describe.skip;
live('alpha-vantage adapter: live (read-only)', () => {
  // Alpha Vantage allows about one request per second: pause before each call.
  const call = async (params: Record<string, string>) => {
    await new Promise((r) => setTimeout(r, 1500));
    const res = await fetch(`https://www.alphavantage.co/query?${new URLSearchParams({ ...params, apikey: process.env[KEY] as string })}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(statusOf(body)).toBeUndefined();
    return body;
  };

  it('reads the market status, a quote, a daily series and the 10-year treasury yield', async () => {
    const status = (await call({ function: 'MARKET_STATUS' })) as { markets: Array<{ market_type: string }> };
    expect(status.markets.length).toBeGreaterThan(5);
    const quote = (await call({ function: 'GLOBAL_QUOTE', symbol: 'IBM' })) as { 'Global Quote': Record<string, string> };
    expect(quote['Global Quote']['01. symbol']).toBe('IBM');
    const daily = (await call({ function: 'TIME_SERIES_DAILY', symbol: 'IBM' })) as Record<string, Record<string, unknown>>;
    expect(Object.keys(daily['Time Series (Daily)']).length).toBe(100);
    const yields = (await call({ function: 'TREASURY_YIELD', interval: 'monthly', maturity: '10year' })) as { unit: string; data: Array<{ date: string }> };
    expect(yields.unit).toBe('percent');
    expect(yields.data[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }, 60_000);
});
