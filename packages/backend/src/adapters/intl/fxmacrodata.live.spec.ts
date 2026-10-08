import * as adapter from './fxmacrodata.json';
import axios, { AxiosError, AxiosHeaders } from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';

/**
 * Two layers of verification for the FXMacroData adapter:
 *
 *   1. Static - always runs, no network. Pins what makes the connector work
 *      with no setup and keeps its one optional secret where it belongs:
 *      - the key is optional. The free routes answer a request with no key,
 *        but FXMacroData answers a wrong or empty X-API-Key with 401
 *        invalid_api_key, so an unset key must mean no header at all.
 *      - every tool is a read-only GET on api.fxmacrodata.com/v1, with path
 *        values percent-encoded and list sizes capped at 100.
 *
 *   2. Live - skipped unless RUN_FXMACRODATA_LIVE is set. Without a key it
 *      calls the free routes (catalogue, USD releases, USD calendar) and
 *      checks that FX rates are refused; with FXMACRODATA_API_KEY it also
 *      reads EUR/USD:
 *
 *        RUN_FXMACRODATA_LIVE=1 npx jest src/adapters/intl/fxmacrodata.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
    AxiosHeaders: actual.AxiosHeaders,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Property = { type: string; enum?: string[]; minimum?: number; maximum?: number; pattern?: string };
type Tool = {
  name: string;
  description: string;
  parameters: { properties: Record<string, Property>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    queryParams?: Record<string, string>;
    headers?: Record<string, string>;
  };
};

const a = adapter as unknown as {
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  envVarMeta: Record<string, { kind: string; secret: boolean; pattern: string }>;
  probe: { tool: string; params: Record<string, unknown> };
  connector: { baseUrl: string; authType: string; authConfig?: unknown };
  tools: Tool[];
};

const CURRENCIES = [
  'aud', 'brl', 'cad', 'chf', 'cnh', 'cny', 'dkk', 'eur', 'gbp', 'huf', 'ils',
  'jpy', 'krw', 'myr', 'ngn', 'nok', 'nzd', 'pen', 'sek', 'thb', 'twd', 'usd',
];

const tool = (name: string) => {
  const found = a.tools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
const config = () => ({ baseUrl: a.connector.baseUrl, authType: a.connector.authType });

const lastRequest = () =>
  mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0] as {
    method: string;
    url: string;
    params?: Record<string, unknown>;
    headers: Record<string, string>;
  };

const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  fxmacrodata_data_catalogue: { currency: 'usd' },
  fxmacrodata_latest_announcements: { currency: 'usd' },
  fxmacrodata_indicator_history: { currency: 'usd', indicator: 'inflation' },
  fxmacrodata_release_calendar: { currency: 'usd' },
  fxmacrodata_fx_rates: { base: 'eur', quote: 'usd' },
};

describe('fxmacrodata adapter - static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('installs with no credentials and probes a free route', () => {
    expect(a.connector.baseUrl).toBe('https://api.fxmacrodata.com/v1');
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.optionalEnvVars).toEqual(['FXMACRODATA_API_KEY']);
    expect(a.probe).toEqual({ tool: 'fxmacrodata_data_catalogue', params: { currency: 'usd' } });
  });

  it('treats the key as a secret and rejects whitespace in it at setup', () => {
    const meta = a.envVarMeta.FXMACRODATA_API_KEY;
    expect(meta.kind).toBe('credential');
    expect(meta.secret).toBe(true);
    const pattern = new RegExp(meta.pattern);
    expect(pattern.test('test-key')).toBe(true);
    expect(pattern.test('test-key\n')).toBe(false);
    expect(pattern.test(' test-key')).toBe(false);
  });

  it.each(Object.keys(SAMPLE_ARGS))('%s sends X-API-Key only when the key is set', async (name) => {
    mockedAxios.mockResolvedValue({ data: {} });
    const mapping = tool(name).endpointMapping;
    const args = SAMPLE_ARGS[name];

    await engine().execute(config(), mapping, { ...args });
    expect(lastRequest().headers).not.toHaveProperty('X-API-Key');

    await engine().execute(config(), mapping, { ...args, FXMACRODATA_API_KEY: '' });
    expect(lastRequest().headers).not.toHaveProperty('X-API-Key');

    await engine().execute(config(), mapping, { ...args, FXMACRODATA_API_KEY: 'test-key' });
    expect(lastRequest().headers['X-API-Key']).toBe('test-key');
    expect(lastRequest().url).toMatch(/^https:\/\/api\.fxmacrodata\.com\/v1\//);
    expect(lastRequest().params ?? {}).not.toHaveProperty('api_key');
  });

  it.each([
    ['fxmacrodata_data_catalogue', { currency: 'eur' }, 'https://api.fxmacrodata.com/v1/data_catalogue/eur', {}],
    ['fxmacrodata_latest_announcements', { currency: 'usd' }, 'https://api.fxmacrodata.com/v1/announcements/usd/latest', {}],
    [
      'fxmacrodata_indicator_history',
      { currency: 'usd', indicator: 'inflation', start_date: '2026-01-01', end_date: '2026-06-30', limit: 100, offset: 20 },
      'https://api.fxmacrodata.com/v1/announcements/usd/inflation',
      { start_date: '2026-01-01', end_date: '2026-06-30', limit: '100', offset: '20' },
    ],
    [
      'fxmacrodata_release_calendar',
      { currency: 'usd', indicator: 'policy_rate', start_date: '2026-10-01', end_date: '2026-12-31' },
      'https://api.fxmacrodata.com/v1/calendar/usd',
      { indicator: 'policy_rate', start_date: '2026-10-01', end_date: '2026-12-31' },
    ],
    [
      'fxmacrodata_fx_rates',
      { base: 'eur', quote: 'usd', start_date: '2026-09-01', limit: 5 },
      'https://api.fxmacrodata.com/v1/forex/eur/usd',
      { start_date: '2026-09-01', limit: '5' },
    ],
  ])('%s builds the request URL and query', async (name, args, url, params) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await engine().execute(config(), tool(name as string).endpointMapping, args as Record<string, unknown>);
    expect(lastRequest().method).toBe('GET');
    expect(lastRequest().url).toBe(url);
    expect(Object.fromEntries(Object.entries(lastRequest().params ?? {}).map(([k, v]) => [k, String(v)]))).toEqual(params);
  });

  it('percent-encodes path values, so a slug cannot reach another route', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await engine().execute(config(), tool('fxmacrodata_indicator_history').endpointMapping, {
      currency: 'usd',
      indicator: '../../forex/eur/usd',
    });
    expect(lastRequest().url).toBe(
      'https://api.fxmacrodata.com/v1/announcements/usd/..%2F..%2Fforex%2Feur%2Fusd',
    );
  });

  it('raises a 401 from the API instead of returning it as data', async () => {
    const response = {
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: { error: 'api_key_required', code: 'api_key_required' },
    };
    mockedAxios.mockRejectedValue(
      new AxiosError('Request failed with status code 401', 'ERR_BAD_REQUEST', response.config, null, response),
    );
    await expect(
      engine().execute(config(), tool('fxmacrodata_fx_rates').endpointMapping, { base: 'eur', quote: 'usd' }),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  it('constrains inputs: supported currencies, YYYY-MM-DD dates, limit 1-100', () => {
    for (const t of a.tools) {
      const properties = t.parameters.properties;
      for (const [key, property] of Object.entries(properties)) {
        if (['currency', 'base', 'quote'].includes(key)) expect(property.enum).toEqual(CURRENCIES);
        if (key.endsWith('_date')) expect(property.pattern).toBe('^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
        if (key === 'limit') expect([property.minimum, property.maximum]).toEqual([1, 100]);
      }
    }
  });

  it('is read-only everywhere', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(
        deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping }).readOnlyHint,
      ).toBe(true);
    }
  });

  it('documents the keyless scope, the free-tier markers and release timing', () => {
    expect(a.instructions).toMatch(/data catalogue for every currency/);
    expect(a.instructions).toMatch(/USD release calendar/);
    expect(a.instructions).toMatch(/most recent 90 days/);
    expect(a.instructions).toMatch(/FX rates/);
    expect(a.instructions).toMatch(/freemium_delay/);
    expect(a.instructions).toMatch(/`date`.*reference period/);
    expect(a.instructions).toMatch(/announcement_datetime/);
    const names = new Set(a.tools.map((t) => t.name));
    for (const m of a.instructions.matchAll(/\bfxmacrodata_[a-z_]+/g)) expect(names).toContain(m[0]);
  });
});

const live = process.env.RUN_FXMACRODATA_LIVE ? describe : describe.skip;

live('fxmacrodata adapter - live API', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  const apiKey = process.env.FXMACRODATA_API_KEY;
  const run = (name: string, args: Record<string, unknown>, key?: string) =>
    engine().execute(config(), tool(name).endpointMapping, key ? { ...args, FXMACRODATA_API_KEY: key } : args) as Promise<any>;

  it('reads the USD catalogue without a key', async () => {
    const out = await run('fxmacrodata_data_catalogue', { currency: 'usd' });
    expect(out.inflation).toEqual(expect.objectContaining({ name: expect.any(String) }));
  }, 30_000);

  it('reads USD releases without a key, marked as delayed', async () => {
    const out = await run('fxmacrodata_latest_announcements', { currency: 'usd' });
    expect(out.data.length).toBeGreaterThan(0);
    expect(out.freemium_delay).toEqual(expect.objectContaining({ applied: true, message: expect.any(String) }));
  }, 30_000);

  it('pages USD CPI history without a key', async () => {
    const out = await run('fxmacrodata_indicator_history', { currency: 'usd', indicator: 'inflation', limit: 2 });
    expect(out.pagination).toEqual(expect.objectContaining({ limit: 2, offset: 0, has_more: expect.any(Boolean) }));
    expect(out.freemium_window).toEqual(expect.objectContaining({ applied: true }));
    for (const row of out.data) expect(typeof row.announcement_datetime).toBe('number');
  }, 30_000);

  it('reads the USD calendar without a key', async () => {
    const out = await run('fxmacrodata_release_calendar', { currency: 'usd' });
    expect(out.data.length).toBeGreaterThan(0);
    expect(typeof out.data[0].announcement_datetime).toBe('number');
  }, 30_000);

  it('refuses FX rates without a key', async () => {
    await expect(run('fxmacrodata_fx_rates', { base: 'eur', quote: 'usd', limit: 2 })).rejects.toMatchObject({
      response: { status: 401 },
    });
  }, 30_000);

  (apiKey ? it : it.skip)('reads EUR/USD with a key', async () => {
    const out = await run('fxmacrodata_fx_rates', { base: 'eur', quote: 'usd', limit: 2 }, apiKey);
    expect(out.data.length).toBeGreaterThan(0);
  }, 30_000);
});
