import * as adapter from './deribit.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Deribit public market data (docs.deribit.com, JSON-RPC over HTTP): every
 * public method is reachable as GET https://www.deribit.com/api/v2/public/<method>
 * with its parameters in the query string; no key is needed.
 * Live part (keyless, reads only): RUN_DERIBIT_LIVE=1 npx jest src/adapters/intl/deribit
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  requiredEnvVars: string[];
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
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
const PREFIX = 'deribit_';

describe('deribit adapter: static spec conformance', () => {
  it('is keyless and points at the production public API', () => {
    expect(a.slug).toBe('deribit');
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.connector.baseUrl).toBe('https://www.deribit.com/api/v2');
    expect(a.category).toBe('finance');
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(t.endpointMapping.path).toMatch(/^\/public\/[a-z_]+$/);
      expect(t.endpointMapping.path).not.toMatch(/private/);
    }
  });

  it('maps the documented public methods and their parameters', () => {
    expect(tool('deribit_get_book_summary_by_currency').endpointMapping).toEqual({
      method: 'GET', path: '/public/get_book_summary_by_currency', queryParams: { currency: '$currency', kind: '$kind' },
    });
    expect(tool('deribit_get_volatility_index_data').endpointMapping.queryParams).toEqual({
      currency: '$currency', start_timestamp: '$start_timestamp', end_timestamp: '$end_timestamp', resolution: '$resolution',
    });
    expect(tool('deribit_get_volatility_index_data').parameters?.properties?.resolution.enum).toEqual(['1', '60', '3600', '43200', '1D']);
    expect(tool('deribit_get_instruments').endpointMapping).toMatchObject({ path: '/public/get_instruments', queryParams: { currency: '$currency', kind: '$kind', expired: '$expired' } });
    expect(tool('deribit_get_ticker').endpointMapping).toEqual({ method: 'GET', path: '/public/ticker', queryParams: { instrument_name: '$instrument_name' } });
    expect(tool('deribit_get_order_book').endpointMapping.queryParams).toEqual({ instrument_name: '$instrument_name', depth: '$depth' });
    expect(tool('deribit_get_tradingview_chart_data').parameters?.required).toEqual(['instrument_name', 'start_timestamp', 'end_timestamp', 'resolution']);
    expect(tool('deribit_get_tradingview_chart_data').parameters?.properties?.resolution.enum).toContain('1D');
    expect(tool('deribit_get_historical_volatility').endpointMapping).toEqual({ method: 'GET', path: '/public/get_historical_volatility', queryParams: { currency: '$currency' } });
    expect(tool('deribit_get_funding_rate_history').endpointMapping.queryParams).toEqual({ instrument_name: '$instrument_name', start_timestamp: '$start_timestamp', end_timestamp: '$end_timestamp' });
    expect(tool('deribit_get_funding_rate_value').endpointMapping.path).toBe('/public/get_funding_rate_value');
    expect(tool('deribit_get_index_price').endpointMapping).toEqual({ method: 'GET', path: '/public/get_index_price', queryParams: { index_name: '$index_name' } });
    expect(tool('deribit_get_last_trades_by_instrument').endpointMapping.queryParams).toMatchObject({ instrument_name: '$instrument_name', count: '$count', sorting: '$sorting' });
    expect(tool('deribit_get_last_trades_by_currency').endpointMapping.queryParams).toMatchObject({ currency: '$currency', kind: '$kind' });
    expect(tool('deribit_get_delivery_prices').endpointMapping.queryParams).toEqual({ index_name: '$index_name', count: '$count', offset: '$offset' });
    expect(tool('deribit_get_book_summary_by_instrument').endpointMapping.path).toBe('/public/get_book_summary_by_instrument');
    expect(tool('deribit_get_index_price_names').endpointMapping.path).toBe('/public/get_index_price_names');
    expect(tool('deribit_get_currencies').endpointMapping.path).toBe('/public/get_currencies');
  });

  it('slims the option book summary and the instrument list', () => {
    const summary = applyResponseTransform(
      { jsonrpc: '2.0', result: [{ instrument_name: 'BTC-27DEC26-100000-C', open_interest: 12.5, mark_iv: 48.1, mark_price: 0.031, underlying_price: 80000, base_currency: 'BTC', creation_timestamp: 1 }], usIn: 1, usOut: 2 },
      tool('deribit_get_book_summary_by_currency').responseMapping as never,
    ).value as { instruments: Record<string, unknown>[] };
    expect(summary.instruments[0]).toEqual({ instrument_name: 'BTC-27DEC26-100000-C', open_interest: 12.5, mark_iv: 48.1, mark_price: 0.031, underlying_price: 80000 });
    const instruments = applyResponseTransform(
      { result: [{ instrument_name: 'BTC-PERPETUAL', kind: 'future', tick_size_steps: [], base_currency_uuid: 'x', contract_size: 10, is_active: true }] },
      tool('deribit_get_instruments').responseMapping as never,
    ).value as { instruments: Record<string, unknown>[] };
    expect(instruments.instruments[0]).toEqual({ instrument_name: 'BTC-PERPETUAL', kind: 'future', contract_size: 10, is_active: true });
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

  it('probes with a read tool without parameters and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_DERIBIT_LIVE === '1' ? describe : describe.skip;
live('deribit adapter: live (keyless, read-only)', () => {
  const base = `${a.connector.baseUrl}/public`;
  const get = async (method: string, q: Record<string, string | number> = {}) => {
    const qs = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString();
    const res = await fetch(`${base}/${method}${qs ? `?${qs}` : ''}`, { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: unknown; error?: unknown };
    expect(body.error).toBeUndefined();
    return body.result;
  };
  const now = Date.now();
  const day = 86_400_000;

  it('reads index names, the index price, currencies and instruments', async () => {
    expect(await get('get_index_price_names')).toEqual(expect.arrayContaining(['btc_usd', 'eth_usd']));
    const idx = (await get('get_index_price', { index_name: 'btc_usd' })) as { index_price: number };
    expect(idx.index_price).toBeGreaterThan(0);
    const cur = (await get('get_currencies')) as Array<{ currency: string }>;
    expect(cur.map((c) => c.currency)).toContain('BTC');
    const raw = { result: await get('get_instruments', { currency: 'BTC', kind: 'future' }) };
    const out = applyResponseTransform(raw, tool('deribit_get_instruments').responseMapping as never).value as { instruments: Array<{ instrument_name: string }> };
    expect(out.instruments.map((i) => i.instrument_name)).toContain('BTC-PERPETUAL');
  }, 60_000);

  it('reads the option book summary, DVOL and historical volatility', async () => {
    const raw = { result: await get('get_book_summary_by_currency', { currency: 'BTC', kind: 'option' }) };
    const out = applyResponseTransform(raw, tool('deribit_get_book_summary_by_currency').responseMapping as never).value as { instruments: Array<{ instrument_name: string; mark_iv?: number }> };
    expect(out.instruments.length).toBeGreaterThan(10);
    expect(typeof out.instruments[0].mark_iv).toBe('number');
    const dvol = (await get('get_volatility_index_data', { currency: 'BTC', start_timestamp: now - day, end_timestamp: now, resolution: '3600' })) as { data: number[][] };
    expect(dvol.data.length).toBeGreaterThan(0);
    const hv = (await get('get_historical_volatility', { currency: 'BTC' })) as number[][];
    expect(hv[0]).toHaveLength(2);
  }, 60_000);

  it('reads ticker, order book, candles, trades, funding and delivery prices of BTC-PERPETUAL', async () => {
    const t = (await get('ticker', { instrument_name: 'BTC-PERPETUAL' })) as { mark_price: number };
    expect(t.mark_price).toBeGreaterThan(0);
    const ob = (await get('get_order_book', { instrument_name: 'BTC-PERPETUAL', depth: 5 })) as { bids: unknown[] };
    expect(ob.bids.length).toBeGreaterThan(0);
    const c = (await get('get_tradingview_chart_data', { instrument_name: 'BTC-PERPETUAL', start_timestamp: now - 3 * day, end_timestamp: now, resolution: '1D' })) as { status: string };
    expect(c.status).toBe('ok');
    const tr = (await get('get_last_trades_by_instrument', { instrument_name: 'BTC-PERPETUAL', count: 3 })) as { trades: unknown[] };
    expect(tr.trades.length).toBeGreaterThan(0);
    const fr = (await get('get_funding_rate_history', { instrument_name: 'BTC-PERPETUAL', start_timestamp: now - day / 4, end_timestamp: now })) as unknown[];
    expect(Array.isArray(fr)).toBe(true);
    const dp = (await get('get_delivery_prices', { index_name: 'btc_usd', count: 2 })) as { data: unknown[] };
    expect(dp.data).toHaveLength(2);
  }, 60_000);
});
