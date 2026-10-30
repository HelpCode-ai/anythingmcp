import * as adapter from './massive.json';

/**
 * Massive REST API (massive.com/docs/rest, formerly Polygon.io; OpenAPI at https://api.massive.com/openapi):
 * GET https://api.massive.com/..., key as Authorization: Bearer (or apiKey=). api.polygon.io keeps working.
 * Live part: RUN_MASSIVE_LIVE=1 MASSIVE_API_KEY=... npx jest src/adapters/intl/massive
 * (reads only, within the free Basic plan: market status, ticker details, previous close, daily bars, news, dividends, SMA, treasury yields).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { default?: unknown; enum?: unknown[]; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  aliases: string[];
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const KEY = 'MASSIVE_API_KEY';
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
const PREFIX = 'massive_';

describe('massive adapter: static spec conformance', () => {
  it('uses the current Massive brand and host and sends the key as a bearer token', () => {
    expect(a.slug).toBe('massive');
    expect(a.name).toBe('Massive');
    expect(a.aliases).toContain('Polygon.io');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('finance');
    expect(a.icon).toBe('massive');
    expect(a.docsUrl).toBe('https://massive.com/docs/rest/quickstart');
    expect(a.requiredEnvVars).toEqual([KEY]);
    expect(a.connector.baseUrl).toBe('https://api.massive.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: `{{${KEY}}}` });
    expect(a.envVarMeta?.[KEY]).toMatchObject({ kind: 'credential', secret: true });
    const pattern = new RegExp(a.envVarMeta?.[KEY].pattern as string);
    expect(pattern.test(['abcdEFGH', 'ijklMNOP', '01234567'].join(''))).toBe(true);
    expect(pattern.test('apiKey=abc')).toBe(false);
  });

  it('maps the documented REST routes', () => {
    const routes: Record<string, string> = {
      massive_get_market_status: '/v1/marketstatus/now',
      massive_get_market_holidays: '/v1/marketstatus/upcoming',
      massive_get_aggregates: '/v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}',
      massive_get_previous_close: '/v2/aggs/ticker/{ticker}/prev',
      massive_get_daily_open_close: '/v1/open-close/{ticker}/{date}',
      massive_list_trades: '/v3/trades/{ticker}',
      massive_list_quotes: '/v3/quotes/{ticker}',
      massive_get_last_trade: '/v2/last/trade/{ticker}',
      massive_get_last_quote: '/v2/last/nbbo/{ticker}',
      massive_get_snapshots: '/v3/snapshot',
      massive_get_stock_snapshot: '/v2/snapshot/locale/us/markets/stocks/tickers/{ticker}',
      massive_get_gainers_losers: '/v2/snapshot/locale/us/markets/stocks/{direction}',
      massive_list_tickers: '/v3/reference/tickers',
      massive_get_ticker_details: '/v3/reference/tickers/{ticker}',
      massive_list_ticker_types: '/v3/reference/tickers/types',
      massive_list_exchanges: '/v3/reference/exchanges',
      massive_get_related_companies: '/v1/related-companies/{ticker}',
      massive_list_news: '/v2/reference/news',
      massive_list_income_statements: '/stocks/financials/v1/income-statements',
      massive_list_balance_sheets: '/stocks/financials/v1/balance-sheets',
      massive_list_cash_flow_statements: '/stocks/financials/v1/cash-flow-statements',
      massive_list_financial_ratios: '/stocks/financials/v1/ratios',
      massive_list_dividends: '/stocks/v1/dividends',
      massive_list_splits: '/stocks/v1/splits',
      massive_list_options_contracts: '/v3/reference/options/contracts',
      massive_get_options_chain: '/v3/snapshot/options/{underlying}',
      massive_get_option_contract_snapshot: '/v3/snapshot/options/{underlying}/{contract}',
      massive_convert_currency: '/v1/conversion/{from}/{to}',
      massive_get_last_forex_quote: '/v1/last_quote/currencies/{from}/{to}',
      massive_get_last_crypto_trade: '/v1/last/crypto/{from}/{to}',
      massive_get_technical_indicator: '/v1/indicators/{indicator}/{ticker}',
      massive_get_treasury_yields: '/fed/v1/treasury-yields',
      massive_get_inflation: '/fed/v1/inflation',
    };
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(routes).sort());
    for (const [name, path] of Object.entries(routes)) expect(tool(name).endpointMapping).toMatchObject({ method: 'GET', path });
  });

  it('sends the documented range filters under their dotted names', () => {
    expect(tool('massive_list_trades').endpointMapping.queryParams).toEqual({
      timestamp: '$timestamp', 'timestamp.gte': '$timestamp_gte', 'timestamp.lte': '$timestamp_lte', order: '$order', limit: '$limit', cursor: '$cursor',
    });
    expect(tool('massive_get_snapshots').endpointMapping.queryParams).toMatchObject({ 'ticker.any_of': '$ticker_any_of', type: '$type' });
    expect(tool('massive_list_news').endpointMapping.queryParams).toMatchObject({ 'published_utc.gte': '$published_utc_gte', 'published_utc.lte': '$published_utc_lte' });
    for (const n of ['massive_list_income_statements', 'massive_list_balance_sheets', 'massive_list_cash_flow_statements']) {
      expect(tool(n).endpointMapping.queryParams).toMatchObject({ tickers: '$tickers', timeframe: '$timeframe', 'period_end.gte': '$period_end_gte', 'filing_date.lte': '$filing_date_lte', sort: '$sort' });
      expect(tool(n).parameters?.properties?.timeframe.enum).toEqual(['quarterly', 'annual', 'trailing_twelve_months']);
      expect(tool(n).parameters?.properties?.sort.default).toBe('period_end.desc');
    }
    expect(tool('massive_list_financial_ratios').endpointMapping.queryParams).toMatchObject({ 'ticker.any_of': '$ticker_any_of', 'market_cap.gte': '$market_cap_gte', 'price_to_earnings.lte': '$price_to_earnings_lte' });
    expect(tool('massive_get_options_chain').endpointMapping.queryParams).toMatchObject({ 'strike_price.gte': '$strike_price_gte', 'expiration_date.lte': '$expiration_date_lte' });
    expect(tool('massive_get_options_chain').parameters?.properties?.limit.maximum).toBe(250);
    expect(tool('massive_get_aggregates').parameters?.properties?.timespan.enum).toEqual(['second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year']);
    expect(tool('massive_get_technical_indicator').parameters?.properties?.indicator.enum).toEqual(['sma', 'ema', 'rsi', 'macd']);
    // Dotted names never leak into tool parameter names.
    for (const t of a.tools) for (const p of Object.keys(t.parameters?.properties ?? {})) expect(p).toMatch(/^\w+$/);
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
    expect(a.probe.tool).toBe('massive_get_market_status');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).toContain('formerly Polygon.io');
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_MASSIVE_LIVE === '1' && process.env[KEY] ? describe : describe.skip;
live('massive adapter: live (read-only, free Basic plan)', () => {
  // Basic allows 5 requests per minute: pause between calls.
  const getJson = async (path: string) => {
    await new Promise((r) => setTimeout(r, 13_000));
    const res = await fetch(`https://api.massive.com${path}`, { headers: { Authorization: `Bearer ${process.env[KEY]}` } });
    expect(res.status).toBe(200);
    return res.json() as Promise<Record<string, unknown>>;
  };

  it('reads market status, ticker details, previous close and daily bars', async () => {
    const status = (await getJson('/v1/marketstatus/now')) as { market: string };
    expect(typeof status.market).toBe('string');
    const details = (await getJson('/v3/reference/tickers/AAPL')) as { results: { ticker: string; cik: string } };
    expect(details.results).toMatchObject({ ticker: 'AAPL', cik: '0000320193' });
    const prev = (await getJson('/v2/aggs/ticker/AAPL/prev')) as { results: Array<{ c: number; t: number }> };
    expect(prev.results[0].c).toBeGreaterThan(0);
    const bars = (await getJson('/v2/aggs/ticker/AAPL/range/1/day/2026-01-05/2026-01-09')) as { results: Array<{ o: number }> };
    expect(bars.results.length).toBe(5);
  }, 180_000);

  it('reads news, dividends, an SMA and treasury yields', async () => {
    const news = (await getJson('/v2/reference/news?ticker=AAPL&limit=2')) as { results: unknown[] };
    expect(news.results.length).toBeGreaterThan(0);
    const divs = (await getJson('/stocks/v1/dividends?ticker=AAPL&limit=2&sort=ex_dividend_date.desc')) as { results: Array<{ ticker: string }> };
    expect(divs.results[0].ticker).toBe('AAPL');
    const sma = (await getJson('/v1/indicators/sma/AAPL?timespan=day&window=50&limit=2')) as { results: { values: unknown[] } };
    expect(sma.results.values.length).toBe(2);
    const yields = (await getJson('/fed/v1/treasury-yields?limit=1&sort=date.desc')) as { results: Array<{ date: string }> };
    expect(yields.results[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }, 180_000);
});
