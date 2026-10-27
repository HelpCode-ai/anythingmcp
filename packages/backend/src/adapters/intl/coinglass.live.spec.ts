import * as adapter from './coinglass.json';
import { assertNoResponseBodyError, describeErrorWhenProblems, ResponseBodyError } from '../../connectors/engines/response-error.util';

/**
 * CoinGlass API v4 (docs.coinglass.com): base https://open-api-v4.coinglass.com,
 * the key in the CG-API-KEY header, every answer { code, msg, data } with HTTP
 * 200 even for errors (code "0" is success).
 * Live part (reads only: plan, coins, aggregated open interest, funding, ETF flows):
 *   COINGLASS_API_KEY=... RUN_COINGLASS_LIVE=1 npx jest src/adapters/intl/coinglass
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; config?: { errorWhen?: unknown } };
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
const PREFIX = 'coinglass_';
const INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '6h', '8h', '12h', '1d', '1w'];
const statusOf = (body: unknown) => {
  try {
    assertNoResponseBodyError(body, a.connector.config?.errorWhen);
    return 0;
  } catch (e) {
    expect(e).toBeInstanceOf(ResponseBodyError);
    return (e as ResponseBodyError).status;
  }
};

describe('coinglass adapter: static spec conformance', () => {
  it('sends the key in CG-API-KEY to the v4 host', () => {
    expect(a.requiredEnvVars).toEqual(['COINGLASS_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://open-api-v4.coinglass.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'CG-API-KEY', apiKey: '{{COINGLASS_API_KEY}}' });
    expect(a.envVarMeta?.COINGLASS_API_KEY.secret).toBe(true);
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(t.endpointMapping.path).toMatch(/^\/api\//);
    }
  });

  it('turns the error codes CoinGlass returns with HTTP 200 into failures', () => {
    expect(describeErrorWhenProblems(a.connector.config?.errorWhen)).toEqual([]);
    expect(statusOf({ code: '0', msg: 'success', data: [] })).toBe(0);
    expect(statusOf({ code: '0', data: ['BTC'] })).toBe(0);
    expect(statusOf({ code: '401', msg: 'API key missing.' })).toBe(401);
    expect(statusOf({ code: '400', msg: 'Invalid API key provided' })).toBe(401);
    expect(statusOf({ code: '429', msg: 'Too Many Requests' })).toBe(429);
    expect(statusOf({ code: '400', msg: 'interval is not supported by your plan' })).toBe(400);
  });

  it('maps the documented history endpoints with symbol, exchange, interval, limit and time range', () => {
    const range = { interval: '$interval', limit: '$limit', start_time: '$start_time', end_time: '$end_time' };
    expect(tool('coinglass_get_global_long_short_account_ratio').endpointMapping).toEqual({
      method: 'GET', path: '/api/futures/global-long-short-account-ratio/history', queryParams: { exchange: '$exchange', symbol: '$symbol', ...range },
    });
    expect(tool('coinglass_get_oi_weighted_funding_rate_history').endpointMapping).toEqual({
      method: 'GET', path: '/api/futures/funding-rate/oi-weight-history', queryParams: { symbol: '$symbol', ...range },
    });
    expect(tool('coinglass_get_aggregated_open_interest_history').endpointMapping).toEqual({
      method: 'GET', path: '/api/futures/open-interest/aggregated-history', queryParams: { symbol: '$symbol', ...range, unit: '$unit' },
    });
    expect(tool('coinglass_get_coinbase_premium_index').endpointMapping).toEqual({ method: 'GET', path: '/api/coinbase-premium-index', queryParams: range });
    expect(tool('coinglass_get_aggregated_liquidation_history').endpointMapping.queryParams).toMatchObject({ exchange_list: '$exchange_list', symbol: '$symbol' });
    expect(tool('coinglass_get_liquidation_history').endpointMapping.path).toBe('/api/futures/liquidation/history');
    expect(tool('coinglass_get_funding_rate_history').endpointMapping.path).toBe('/api/futures/funding-rate/history');
    expect(tool('coinglass_get_top_long_short_account_ratio').endpointMapping.path).toBe('/api/futures/top-long-short-account-ratio/history');
    expect(tool('coinglass_get_top_long_short_position_ratio').endpointMapping.path).toBe('/api/futures/top-long-short-position-ratio/history');
    expect(tool('coinglass_get_price_history').parameters?.properties?.limit.default).toBe(100);
    for (const t of a.tools) {
      const iv = t.parameters?.properties?.interval;
      if (!iv) continue;
      expect(iv.enum).toEqual(INTERVALS);
      expect(t.parameters?.required).toContain('interval');
    }
  });

  it('maps the snapshot, ETF and index endpoints', () => {
    expect(tool('coinglass_get_bitcoin_etf_flows').endpointMapping).toEqual({ method: 'GET', path: '/api/etf/bitcoin/flow-history' });
    expect(tool('coinglass_get_ethereum_etf_flows').endpointMapping).toEqual({ method: 'GET', path: '/api/etf/ethereum/flow-history' });
    expect(tool('coinglass_list_bitcoin_etfs').endpointMapping.path).toBe('/api/etf/bitcoin/list');
    expect(tool('coinglass_get_stablecoin_market_cap_history').endpointMapping.path).toBe('/api/index/stableCoin-marketCap-history');
    expect(tool('coinglass_get_fear_greed_history').endpointMapping.path).toBe('/api/index/fear-greed-history');
    expect(tool('coinglass_get_option_max_pain').endpointMapping).toEqual({ method: 'GET', path: '/api/option/max-pain', queryParams: { symbol: '$symbol', exchange: '$exchange' } });
    expect(tool('coinglass_list_supported_coins').endpointMapping.path).toBe('/api/futures/supported-coins');
    expect(tool('coinglass_list_supported_exchanges').endpointMapping.path).toBe('/api/futures/supported-exchanges');
    expect(tool('coinglass_list_exchange_pairs').endpointMapping).toEqual({ method: 'GET', path: '/api/futures/supported-exchange-pairs', queryParams: { exchange: '$exchange' } });
    expect(tool('coinglass_list_open_interest_by_exchange').endpointMapping.queryParams).toEqual({ symbol: '$symbol' });
    expect(tool('coinglass_list_funding_rates_by_exchange').endpointMapping.path).toBe('/api/futures/funding-rate/exchange-list');
    expect(tool('coinglass_get_pairs_markets').endpointMapping.queryParams).toEqual({ symbol: '$symbol' });
    expect(tool('coinglass_get_account_subscription').endpointMapping.path).toBe('/api/user/account/subscription');
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('is read-only: no tool writes, none is switched off', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      expect(t.annotations?.readOnlyHint === false).toBe(false);
    }
  });

  it('probes with the plan lookup and documents every tool and the plan limits in the instructions', () => {
    expect(a.probe.tool).toBe('coinglass_get_account_subscription');
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).toMatch(/Hobbyist/);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_COINGLASS_LIVE === '1' && process.env.COINGLASS_API_KEY ? describe : describe.skip;
live('coinglass adapter: live (read-only)', () => {
  const get = async (path: string, q: Record<string, string | number> = {}) => {
    const qs = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString();
    const res = await fetch(`${a.connector.baseUrl}${path}${qs ? `?${qs}` : ''}`, {
      headers: { 'CG-API-KEY': process.env.COINGLASS_API_KEY as string, Accept: 'application/json' },
    });
    const body = (await res.json()) as { code: string; msg?: string; data: unknown };
    expect(`${body.code} ${body.msg ?? ''}`).toMatch(/^0 /);
    return body.data;
  };
  it('reads the plan, coins, aggregated open interest, weighted funding, the long/short ratio and ETF flows', async () => {
    const sub = (await get('/api/user/account/subscription')) as { level: string };
    expect(typeof sub.level).toBe('string');
    expect(await get('/api/futures/supported-coins')).toEqual(expect.arrayContaining(['BTC']));
    const oi = (await get('/api/futures/open-interest/aggregated-history', { symbol: 'BTC', interval: '1d', limit: 3 })) as unknown[];
    expect(oi.length).toBeGreaterThan(0);
    const fr = (await get('/api/futures/funding-rate/oi-weight-history', { symbol: 'BTC', interval: '8h', limit: 3 })) as unknown[];
    expect(fr.length).toBeGreaterThan(0);
    const ls = (await get('/api/futures/global-long-short-account-ratio/history', { exchange: 'Binance', symbol: 'BTCUSDT', interval: '4h', limit: 3 })) as unknown[];
    expect(ls.length).toBeGreaterThan(0);
    const etf = (await get('/api/etf/bitcoin/flow-history')) as unknown[];
    expect(etf.length).toBeGreaterThan(0);
  }, 60_000);
});
