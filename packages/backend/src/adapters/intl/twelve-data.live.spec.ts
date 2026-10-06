import * as adapter from './twelve-data.json';

type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
};
const a = adapter as unknown as {
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;

describe('twelve-data adapter: static spec conformance', () => {
  it('api.twelvedata.com with the key in the Authorization header', () => {
    expect(a.connector.baseUrl).toBe('https://api.twelvedata.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'apikey {{TWELVE_DATA_API_KEY}}' });
  });

  it('probes with api_usage, which needs no arguments', () => {
    expect(a.probe.tool).toBe('twelve_data_get_api_usage');
    expect(tool('twelve_data_get_api_usage').endpointMapping.path).toBe('/api_usage');
  });

  it('every tool is a prefixed GET and every declared parameter reaches the query', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('twelve_data_')).toBe(true);
      expect(t.endpointMapping.method).toBe('GET');
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      const sent = Object.values(t.endpointMapping.queryParams ?? {});
      for (const p of Object.keys(t.parameters.properties ?? {})) {
        expect(`${t.name}:${sent.includes(`$${p}`)}`).toBe(`${t.name}:true`);
      }
    }
  });

  it('time series and indicators require symbol and interval', () => {
    for (const name of ['twelve_data_get_time_series', 'twelve_data_get_rsi', 'twelve_data_get_macd', 'twelve_data_get_bbands']) {
      expect(tool(name).parameters.required).toEqual(['symbol', 'interval']);
    }
  });

  it('documents the free plan limits', () => {
    const instructions = (adapter as unknown as { instructions: string }).instructions;
    expect(instructions).toContain('8 API credits per minute and 800 per day');
  });
});

/**
 * Opt-in live check against the public demo key Twelve Data documents for
 * sample symbols (AAPL, EUR/USD). RUN_TWELVE_DATA_LIVE=1 to run it.
 */
const live = process.env.RUN_TWELVE_DATA_LIVE === '1';
(live ? describe : describe.skip)('twelve-data: live with the demo key', () => {
  const call = async (name: string, args: Record<string, string | number>) => {
    const t = tool(name);
    const url = new URL(a.connector.baseUrl + t.endpointMapping.path);
    for (const [key, ref] of Object.entries(t.endpointMapping.queryParams ?? {})) {
      const v = args[ref.slice(1)];
      if (v !== undefined) url.searchParams.set(key, String(v));
    }
    const res = await fetch(url, { headers: { Authorization: 'apikey demo' } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('price of AAPL', async () => {
    const { status, body } = await call('twelve_data_get_price', { symbol: 'AAPL' });
    expect(status).toBe(200);
    expect(Number(body.price)).toBeGreaterThan(0);
  }, 20000);

  it('daily time series of AAPL', async () => {
    const { status, body } = await call('twelve_data_get_time_series', { symbol: 'AAPL', interval: '1day', outputsize: 3 });
    expect(status).toBe(200);
    expect(body.values).toHaveLength(3);
  }, 20000);

  it('EUR/USD exchange rate', async () => {
    const { status, body } = await call('twelve_data_get_exchange_rate', { symbol: 'EUR/USD' });
    expect(status).toBe(200);
    expect(Number(body.rate)).toBeGreaterThan(0);
  }, 20000);
});
