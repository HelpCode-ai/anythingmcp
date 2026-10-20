import * as adapter from './dadata.json';
import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../env-var-meta';

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
 * DaData (dadata.ru). Static: no customer key exists. Diffed against the
 * vendor's official Python client and dadata.ru/api: three hosts
 * (suggestions, cleaner, profile), Authorization: Token <key>, X-Secret only
 * where DaData asks for it, JSON bodies {query, count, ...}, iplocate as GET,
 * clean as a JSON array of raw values. Fake-key probes from the Cloud
 * backend (20 Oct 2026): suggestions and cleaner answer 403 "Feature ...
 * disabled for token", profile/balance 401.
 */
const a = adapter as unknown as Adapter;
const KEY = 'ab'.repeat(20);
const SECRET = 'cd'.repeat(20);
const ENV = { DADATA_API_KEY: KEY, DADATA_SECRET_KEY: SECRET };
const S = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs';
const { tool, call, sent } = harness(a, ENV);

describe('dadata adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset().mockResolvedValue({ status: 200, data: { suggestions: [] }, headers: {} }));

  it('sends the key as Authorization: Token, never in the URL', async () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'Token {{DADATA_API_KEY}}' });
    expect(needsBrowserAuthorization(a as never)).toBe(false);
    await call('dadata_find_party', { query: '7707083893' });
    expect(sent().headers.Authorization).toBe(`Token ${KEY}`);
    expect(sent().url).toBe(`${S}/findById/party`);
    expect(sent().method).toBe('POST');
    expect(sent().data).toEqual({ query: '7707083893', count: 10 });
    expect(sent().headers['X-Secret']).toBeUndefined();
    expect(sent().url).not.toContain(KEY);
  });

  it('posts every suggestion and lookup as JSON to its documented path', async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['dadata_suggest_address', { query: 'мск сухонская 11' }, '/suggest/address'],
      ['dadata_find_address', { query: '9120b43f-2fae-4838-a144-85e43c2bfb29' }, '/findById/address'],
      ['dadata_geolocate_address', { lat: 55.878, lon: 37.653 }, '/geolocate/address'],
      ['dadata_suggest_party', { query: 'сбербанк' }, '/suggest/party'],
      ['dadata_find_affiliated', { query: '7736207543' }, '/findAffiliated/party'],
      ['dadata_suggest_bank', { query: 'сбербанк' }, '/suggest/bank'],
      ['dadata_find_bank', { query: '044525225' }, '/findById/bank'],
      ['dadata_suggest_fio', { query: 'Викт' }, '/suggest/fio'],
      ['dadata_suggest_email', { query: 'anton@m' }, '/suggest/email'],
      ['dadata_suggest_reference', { directory: 'fms_unit', query: '772-053' }, '/suggest/fms_unit'],
    ];
    for (const [name, params, path] of cases) {
      mockedAxios.mockClear();
      await call(name, params);
      expect(`${name} ${sent().method} ${sent().url}`).toBe(`${name} POST ${S}${path}`);
      expect(sent().data).toMatchObject(params.directory ? { query: params.query } : params);
    }
  });

  it('locates an IP with a GET and the ip in the query', async () => {
    await call('dadata_iplocate', { ip: '46.226.227.20' });
    expect(sent().method).toBe('GET');
    expect(sent().url).toBe(`${S}/iplocate/address`);
    expect(sent().params).toEqual({ ip: '46.226.227.20' });
  });

  it('sends X-Secret only to the profile and cleaner hosts', async () => {
    await call('dadata_get_balance', {});
    expect(sent().url).toBe('https://dadata.ru/api/v2/profile/balance');
    expect(sent().headers['X-Secret']).toBe(SECRET);
    mockedAxios.mockClear();
    await call('dadata_get_daily_stats', { date: '2026-10-19' });
    expect(sent().url).toBe('https://dadata.ru/api/v2/stat/daily');
    expect(sent().params).toEqual({ date: '2026-10-19' });
    for (const t of a.tools.filter((x) => x.endpointMapping.headers?.['X-Secret'])) {
      expect(t.endpointMapping.path).toMatch(/^https:\/\/(dadata\.ru|cleaner\.dadata\.ru)\//);
    }
  });

  it('cleans a JSON array of values, is installed off and says it costs money', async () => {
    const t = tool('dadata_clean');
    expect(t.enabled).toBe(false);
    expect(t.description).toMatch(/COSTS MONEY/);
    expect(t.description).toMatch(/20 kopecks per value/);
    expect(t.parameters.properties!.values.maxItems).toBe(50);
    await call('dadata_clean', { type: 'address', values: ['мск сухонская 11/-89'] });
    expect(sent().url).toBe('https://cleaner.dadata.ru/api/v1/clean/address');
    expect(sent().data).toEqual(['мск сухонская 11/-89']);
    expect(sent().headers['X-Secret']).toBe(SECRET);
    expect(a.tools.filter((x) => x.enabled === false).map((x) => x.name)).toEqual(['dadata_clean']);
  });

  it('checks both keys and keeps them secret', () => {
    for (const v of ['DADATA_API_KEY', 'DADATA_SECRET_KEY']) {
      const re = new RegExp(a.envVarMeta[v].pattern!);
      expect(re.test(KEY)).toBe(true);
      expect(re.test(`Token ${KEY}`)).toBe(false);
      expect(describeAdapterEnvVars(a as never).find((d) => d.name === v)!.secret).toBe(true);
    }
    expect(a.optionalEnvVars).toEqual(['DADATA_SECRET_KEY']);
    expect(a.probe).toEqual({ tool: 'dadata_find_party', params: { query: '7707083893', count: 1 } });
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

