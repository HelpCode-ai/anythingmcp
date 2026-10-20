import * as adapter from './finnhub.json';
import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock;

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: Record<string, any>;
  annotations?: Record<string, unknown>;
  useProxy?: boolean;
};
type Adapter = {
  slug: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
  probe?: { tool: string; params?: Record<string, unknown> };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers?: Record<string, string> };
  tools: Tool[];
};
const harness = (a: Adapter, env: Record<string, string>) => {
  const tool = (name: string) => {
    const t = a.tools.find((x) => x.name === name);
    if (!t) throw new Error(`missing tool ${name}`);
    return t;
  };
  // Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
  const call = (name: string, params: Record<string, unknown>, authType = a.connector.authType) => {
    const { config, endpointMapping } = interpolateConnectorConfig(
      { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
      tool(name).endpointMapping as never,
      env,
    );
    return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
      { baseUrl: config.baseUrl, authType, authConfig: interpolateDeep({ ...a.connector.authConfig }, env), headers: config.headers },
      endpointMapping as never,
      { ...applySchemaDefaults(tool(name).parameters as never, params), ...env },
    ) as Promise<any>;
  };
  const sent = (i = 0) => mockedAxios.mock.calls[i][0];
  return { tool, call, sent };
};


/**
 * Finnhub. Static: no customer key exists. Every tool diffed against
 * Finnhub's own swagger (finnhub.io/static/swagger.json, 20 Oct 2026): path,
 * GET, query names, and the free/premium flag of each endpoint (only
 * /stock/candle here is premium, and its description says so). Fake-key
 * probes from the Cloud backend: X-Finnhub-Token answers 401
 * "Invalid API key.", no key 401 "Please use an API key.".
 */
const a = adapter as unknown as Adapter;
const KEY = ['d1fake', '0000', 'abcd', 'ef12'].join('');
const { tool, call, sent } = harness(a, { FINNHUB_API_KEY: KEY });

// From the swagger: path -> query names the tool may send.
const SPEC: Record<string, [string, string[]]> = {
  finnhub_search_symbols: ['/search', ['q', 'exchange']],
  finnhub_get_quote: ['/quote', ['symbol']],
  finnhub_get_company_profile: ['/stock/profile2', ['symbol', 'isin', 'cusip']],
  finnhub_get_basic_financials: ['/stock/metric', ['symbol', 'metric']],
  finnhub_get_company_news: ['/company-news', ['symbol', 'from', 'to']],
  finnhub_get_market_news: ['/news', ['category', 'minId']],
  finnhub_get_peers: ['/stock/peers', ['symbol', 'grouping']],
  finnhub_get_recommendation_trends: ['/stock/recommendation', ['symbol']],
  finnhub_get_earnings_surprises: ['/stock/earnings', ['symbol', 'limit']],
  finnhub_get_earnings_calendar: ['/calendar/earnings', ['from', 'to', 'symbol', 'international']],
  finnhub_get_ipo_calendar: ['/calendar/ipo', ['from', 'to']],
  finnhub_get_insider_transactions: ['/stock/insider-transactions', ['symbol', 'from', 'to']],
  finnhub_get_insider_sentiment: ['/stock/insider-sentiment', ['symbol', 'from', 'to']],
  finnhub_get_financials_reported: ['/stock/financials-reported', ['symbol', 'cik', 'accessNumber', 'freq', 'from', 'to']],
  finnhub_get_sec_filings: ['/stock/filings', ['symbol', 'cik', 'form', 'from', 'to']],
  finnhub_get_market_status: ['/stock/market-status', ['exchange']],
  finnhub_get_market_holidays: ['/stock/market-holiday', ['exchange']],
  finnhub_list_forex_exchanges: ['/forex/exchange', []],
  finnhub_list_forex_symbols: ['/forex/symbol', ['exchange']],
  finnhub_list_crypto_exchanges: ['/crypto/exchange', []],
  finnhub_list_crypto_symbols: ['/crypto/symbol', ['exchange']],
  finnhub_get_stock_candles: ['/stock/candle', ['symbol', 'resolution', 'from', 'to']],
};

describe('finnhub adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset().mockResolvedValue({ status: 200, data: {}, headers: {} }));

  it('sends the key in X-Finnhub-Token, never in the URL', async () => {
    expect(a.connector.baseUrl).toBe('https://finnhub.io/api/v1');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Finnhub-Token', apiKey: '{{FINNHUB_API_KEY}}' });
    await call('finnhub_get_quote', { symbol: 'AAPL' });
    expect(sent().headers['X-Finnhub-Token']).toBe(KEY);
    expect(sent().url).toBe('https://finnhub.io/api/v1/quote');
    expect(sent().params).toEqual({ symbol: 'AAPL' });
    expect(JSON.stringify(sent().params)).not.toContain(KEY);
  });

  it('matches the swagger path and query names of every tool, all GET', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(SPEC).sort());
    for (const t of a.tools) {
      const [path, names] = SPEC[t.name];
      expect(`${t.name} ${t.endpointMapping.method} ${t.endpointMapping.path}`).toBe(`${t.name} GET ${path}`);
      for (const q of Object.keys(t.endpointMapping.queryParams ?? {})) expect(`${t.name}:${q}:${names.includes(q)}`).toBe(`${t.name}:${q}:true`);
      for (const r of t.parameters.required ?? []) expect(t.parameters.properties).toHaveProperty(r);
    }
  });

  it('asks for all metrics and maps renamed parameters', async () => {
    await call('finnhub_get_basic_financials', { symbol: 'SAP.DE' });
    expect(sent().params).toEqual({ symbol: 'SAP.DE', metric: 'all' });
    mockedAxios.mockClear();
    await call('finnhub_get_market_news', { category: 'general', min_id: 7 });
    expect(sent().params).toEqual({ category: 'general', minId: 7 });
    mockedAxios.mockClear();
    await call('finnhub_get_financials_reported', { symbol: 'AAPL', access_number: '0000320193-25-000079', freq: 'quarterly' });
    expect(sent().params).toEqual({ symbol: 'AAPL', accessNumber: '0000320193-25-000079', freq: 'quarterly' });
  });

  it('marks candles as paid-plan only and everything as read-only', () => {
    expect(tool('finnhub_get_stock_candles').description).toMatch(/PAID PLAN ONLY/);
    for (const t of a.tools) expect(t.enabled).toBeUndefined();
    expect(a.instructions).toMatch(/Read-only/);
    expect(new RegExp(a.envVarMeta.FINNHUB_API_KEY.pattern!).test(KEY)).toBe(true);
    expect(describeAdapterEnvVars(a as never)[0].secret).toBe(true);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

