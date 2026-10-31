import * as adapter from './coinmarketcap.json';

/**
 * CoinMarketCap Pro API (coinmarketcap.com/api/documentation, OpenAPI at
 * github.com/OpenCMC/coinmarketcap-openapi): base https://pro-api.coinmarketcap.com,
 * API key in the X-CMC_PRO_API_KEY header, every answer wrapped in { status, data }.
 * Live part (reads only: key info, id map, quotes, global metrics, fear and greed):
 *   CMC_PRO_API_KEY=... RUN_COINMARKETCAP_LIVE=1 npx jest src/adapters/intl/coinmarketcap
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; healthcheckPath?: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
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
const PREFIX = 'coinmarketcap_';

describe('coinmarketcap adapter: static spec conformance', () => {
  it('sends the key in the X-CMC_PRO_API_KEY header against the Pro API host', () => {
    expect(a.requiredEnvVars).toEqual(['CMC_PRO_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://pro-api.coinmarketcap.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-CMC_PRO_API_KEY', apiKey: '{{CMC_PRO_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/v1/key/info');
    expect(a.envVarMeta?.CMC_PRO_API_KEY.secret).toBe(true);
    const pattern = new RegExp(a.envVarMeta?.CMC_PRO_API_KEY.pattern ?? '');
    expect(pattern.test(['0123abcd', '4567', '89ef', '0123', '456789abcdef'].join('-'))).toBe(true);
    expect(pattern.test('not a key')).toBe(false);
  });

  it('maps the cryptocurrency endpoints to the current versions', () => {
    expect(tool('coinmarketcap_map_cryptocurrencies').endpointMapping).toMatchObject({ path: '/v1/cryptocurrency/map', queryParams: { symbol: '$symbol', listing_status: '$listing_status', start: '$start', limit: '$limit', sort: '$sort', aux: '$aux' } });
    expect(tool('coinmarketcap_get_cryptocurrency_info').endpointMapping).toMatchObject({ path: '/v2/cryptocurrency/info', queryParams: { id: '$id', slug: '$slug', symbol: '$symbol', address: '$address' } });
    expect(tool('coinmarketcap_list_listings_latest').endpointMapping).toMatchObject({
      path: '/v3/cryptocurrency/listings/latest',
      queryParams: { start: '$start', limit: '$limit', sort: '$sort', sort_dir: '$sort_dir', cryptocurrency_type: '$cryptocurrency_type', tag: '$tag', percent_change_24h_min: '$percent_change_24h_min', convert: '$convert', convert_id: '$convert_id' },
    });
    expect(tool('coinmarketcap_get_quotes_latest').endpointMapping).toMatchObject({ path: '/v3/cryptocurrency/quotes/latest', queryParams: { id: '$id', slug: '$slug', symbol: '$symbol', skip_invalid: '$skip_invalid' } });
    expect(tool('coinmarketcap_get_simple_price').endpointMapping).toMatchObject({ path: '/v2/simple/price', queryParams: { include_market_cap: '$include_market_cap', include_24h_volume: '$include_24h_volume', include_24h_change: '$include_24h_change', include_all: '$include_all' } });
    expect(tool('coinmarketcap_get_quotes_historical').endpointMapping).toMatchObject({ path: '/v3/cryptocurrency/quotes/historical', queryParams: { time_start: '$time_start', time_end: '$time_end', count: '$count', interval: '$interval' } });
    expect(tool('coinmarketcap_get_ohlcv_historical').endpointMapping).toMatchObject({ path: '/v2/cryptocurrency/ohlcv/historical', queryParams: { time_period: '$time_period' } });
    expect(tool('coinmarketcap_list_gainers_losers').endpointMapping.path).toBe('/v1/cryptocurrency/trending/gainers-losers');
    expect(tool('coinmarketcap_list_categories').endpointMapping.path).toBe('/v1/cryptocurrency/categories');
    expect(tool('coinmarketcap_get_category').endpointMapping).toMatchObject({ path: '/v1/cryptocurrency/category', queryParams: { id: '$id' } });
    expect(tool('coinmarketcap_get_category').parameters?.required).toEqual(['id']);
  });

  it('maps the market, exchange and tool endpoints', () => {
    expect(tool('coinmarketcap_get_key_info').endpointMapping).toEqual({ method: 'GET', path: '/v1/key/info' });
    expect(tool('coinmarketcap_get_global_metrics').endpointMapping).toEqual({ method: 'GET', path: '/v1/global-metrics/quotes/latest', queryParams: { convert: '$convert', convert_id: '$convert_id' } });
    expect(tool('coinmarketcap_get_global_metrics_historical').endpointMapping.path).toBe('/v1/global-metrics/quotes/historical');
    expect(tool('coinmarketcap_get_fear_and_greed_latest').endpointMapping).toEqual({ method: 'GET', path: '/v3/fear-and-greed/latest' });
    expect(tool('coinmarketcap_get_fear_and_greed_historical').endpointMapping).toEqual({ method: 'GET', path: '/v3/fear-and-greed/historical', queryParams: { start: '$start', limit: '$limit' } });
    expect(tool('coinmarketcap_get_altcoin_season_index').endpointMapping.path).toBe('/v1/altcoin-season-index/latest');
    expect(tool('coinmarketcap_get_cmc100_index').endpointMapping.path).toBe('/v3/index/cmc100-latest');
    expect(tool('coinmarketcap_map_exchanges').endpointMapping).toMatchObject({ path: '/v1/exchange/map', queryParams: { slug: '$slug', crypto_id: '$crypto_id' } });
    expect(tool('coinmarketcap_get_exchange_info').endpointMapping).toMatchObject({ path: '/v1/exchange/info', queryParams: { id: '$id', slug: '$slug' } });
    expect(tool('coinmarketcap_get_exchange_assets').endpointMapping).toEqual({ method: 'GET', path: '/v1/exchange/assets', queryParams: { id: '$id' } });
    expect(tool('coinmarketcap_convert_price').endpointMapping).toMatchObject({ path: '/v2/tools/price-conversion', queryParams: { amount: '$amount', id: '$id', symbol: '$symbol', time: '$time', convert: '$convert' } });
    expect(tool('coinmarketcap_convert_price').parameters?.required).toEqual(['amount']);
    expect(tool('coinmarketcap_map_fiat').endpointMapping).toMatchObject({ path: '/v1/fiat/map', queryParams: { include_metals: '$include_metals' } });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      expect(t.endpointMapping.path.startsWith('/v')).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('is read-only: every tool is a GET, none is switched off', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      expect(t.annotations?.readOnlyHint === false).toBe(false);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe.tool).toBe('coinmarketcap_get_key_info');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_COINMARKETCAP_LIVE === '1' && process.env.CMC_PRO_API_KEY ? describe : describe.skip;
live('coinmarketcap adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { 'X-CMC_PRO_API_KEY': String(process.env.CMC_PRO_API_KEY), Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as { status: { error_code: number | string }; data: unknown };
  };
  it('reads key info, the id map, quotes, global metrics and fear and greed', async () => {
    const key = (await get('/v1/key/info')).data as { usage: { current_month: { credits_left: number } } };
    expect(typeof key.usage.current_month.credits_left).toBe('number');
    const map = (await get('/v1/cryptocurrency/map?symbol=BTC')).data as Array<{ id: number }>;
    expect(map.map((c) => c.id)).toContain(1);
    const quotes = (await get('/v3/cryptocurrency/quotes/latest?id=1,1027')).data as Array<{ id: number; quote: Array<{ price: number }> }>;
    expect(quotes.find((c) => c.id === 1)?.quote[0].price).toBeGreaterThan(0);
    const global = (await get('/v1/global-metrics/quotes/latest')).data as { btc_dominance: number };
    expect(global.btc_dominance).toBeGreaterThan(0);
    const fng = (await get('/v3/fear-and-greed/latest')).data as { value: number };
    expect(fng.value).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
