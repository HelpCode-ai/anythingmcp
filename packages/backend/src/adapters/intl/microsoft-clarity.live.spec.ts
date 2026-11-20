import axios from 'axios';
import * as adapter from './microsoft-clarity.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Microsoft Clarity Data Export API adapter.
 *
 * Static checks always run: Bearer auth with the project's Data Export
 * token, the single documented endpoint
 * (GET /export-data/api/v1/project-live-insights), the query every tool
 * sends (numOfDays 1 to 3 and up to three dimensions with Microsoft's exact
 * dimension names), the 30-minute cache that protects the quota of 10
 * requests per project per day, and that every tool is a read.
 * https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api
 *
 * The endpoints behind Microsoft's own Clarity MCP server
 * (clarity.microsoft.com/mcp/...) are not a documented public API and are
 * left out on purpose.
 *
 * Live checks run only with RUN_MICROSOFT_CLARITY_LIVE=1. Without a token
 * they confirm that the endpoint refuses a call with no token (401) or a
 * wrong one (401 or 403; a made-up token answered 403 on 19 Nov 2026). With
 * CLARITY_API_TOKEN one export is read, which uses ONE of the project's 10
 * daily requests.
 *
 *   RUN_MICROSOFT_CLARITY_LIVE=1 CLARITY_API_TOKEN=... \
 *     npx jest src/adapters/intl/microsoft-clarity.live.spec.ts
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

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: {
    properties?: Record<string, { description?: string; default?: unknown; enum?: unknown[] }>;
    required?: string[];
  };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown> };
  responseMapping?: { cacheTtl?: number };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  description: string;
  instructions: string;
  prerequisites: string;
  docsUrl: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean; help?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};

const ENV: Record<string, string> = {
  CLARITY_API_TOKEN: 'eyJhbGciOiJSUzI1NiJ9.eyJqdGkiOiJ0ZXN0LXRva2VuIn0.c2lnbmF0dXJlLXRlc3Q',
};
const ENDPOINT = 'https://www.clarity.ms/export-data/api/v1/project-live-insights';
const DIMENSIONS = ['Browser', 'Device', 'Country/Region', 'OS', 'Source', 'Medium', 'Campaign', 'Channel', 'URL'];
const TOOLS = [
  'microsoft_clarity_get_dashboard_insights',
  'microsoft_clarity_get_page_insights',
  'microsoft_clarity_get_traffic_source_insights',
  'microsoft_clarity_get_device_insights',
  'microsoft_clarity_get_country_insights',
  'microsoft_clarity_get_insights_by_dimensions',
];

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: cfg.headers,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = () => mockedAxios.mockResolvedValueOnce({ status: 200, data: [], headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

describe('microsoft-clarity adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('reads the Data Export API with the project token as a Bearer token', () => {
    expect(a.slug).toBe('microsoft-clarity');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('analytics');
    expect(a.icon).toBe('microsoft-clarity');
    expect(a.docsUrl).toBe('https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://www.clarity.ms');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{CLARITY_API_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['CLARITY_API_TOKEN']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.envVarMeta.CLARITY_API_TOKEN).toMatchObject({ kind: 'credential', secret: true });
  });

  it('accepts a three-part token and refuses a pasted header or a token with spaces', () => {
    const pattern = new RegExp(a.envVarMeta.CLARITY_API_TOKEN.pattern!);
    expect(pattern.test(ENV.CLARITY_API_TOKEN)).toBe(true);
    for (const bad of ['', 'Bearer ' + ENV.CLARITY_API_TOKEN, 'only-one-part', 'two.parts', 'has space.in.token']) {
      expect(pattern.test(bad)).toBe(false);
    }
  });

  it('probes the totals for one day and explains 400, 401, 403 and the daily limit', () => {
    expect(a.probe).toEqual({ tool: 'microsoft_clarity_get_dashboard_insights', params: { num_of_days: 1 } });
    for (const key of ['400', '401', '403', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    expect(a.verifyHints.rate_limited).toMatch(/10 Data Export requests/);
  });

  it('states the limit of 10 requests per project per day wherever a user or a model reads', () => {
    expect(a.description).toMatch(/10 requests per project per day/);
    expect(a.prerequisites).toMatch(/10 API requests per project per day/);
    expect(a.instructions).toMatch(/10 Data Export requests per project per day/);
    expect(a.envVarMeta.CLARITY_API_TOKEN.help).toMatch(/10 requests per project per day/);
    for (const entry of a.tools) expect(entry.description).toMatch(/one of the 10 Data Export requests/);
  });

  it('has exactly the six read tools, prefixed, named in the instructions and unique in the catalog', () => {
    expect(a.tools.map((entry) => entry.name)).toEqual(TOOLS);
    const mine = new Set(TOOLS);
    for (const name of mine) expect(name).toMatch(/^microsoft_clarity_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/[–—]/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('keeps every tool a cached GET on the one documented path, switched on, with declared arguments', () => {
    for (const entry of a.tools) {
      expect(entry.endpointMapping.method).toBe('GET');
      expect(entry.endpointMapping.path).toBe('/export-data/api/v1/project-live-insights');
      expect(entry.responseMapping).toEqual({ cacheTtl: 1800 });
      expect(entry.enabled).not.toBe(false);
      expect(
        deriveToolAnnotations({
          name: entry.name,
          connectorType: 'REST',
          endpointMapping: entry.endpointMapping,
          annotations: entry.annotations,
        }).readOnlyHint,
      ).toBe(true);
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const value of Object.values(entry.endpointMapping.queryParams ?? {})) {
        if (typeof value === 'string' && value.startsWith('$')) expect(declared.has(value.slice(1))).toBe(true);
        else expect(DIMENSIONS).toContain(value);
      }
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect(entry.parameters.properties!.num_of_days).toMatchObject({ enum: [1, 2, 3], default: 1 });
      expect(entry.description.length).toBeGreaterThan(40);
      expect(entry.description).not.toMatch(/[{}<]/);
    }
    expect(a.tools.filter((entry) => entry.enabled === false)).toEqual([]);
    expect(tool('microsoft_clarity_get_insights_by_dimensions').parameters.required).toEqual(['dimension1']);
    for (const name of ['dimension1', 'dimension2', 'dimension3']) {
      expect(tool('microsoft_clarity_get_insights_by_dimensions').parameters.properties![name].enum).toEqual(DIMENSIONS);
    }
    expect(tool('microsoft_clarity_get_page_insights').parameters.properties!.second_dimension.enum).toEqual(
      DIMENSIONS.filter((d) => d !== 'URL'),
    );
    expect(tool('microsoft_clarity_get_country_insights').parameters.properties!.second_dimension.enum).toEqual(
      DIMENSIONS.filter((d) => d !== 'Country/Region'),
    );
  });

  it('never calls the undocumented endpoints of the Clarity MCP backend', () => {
    const text = JSON.stringify(a.tools) + JSON.stringify(a.connector);
    expect(text).not.toContain('clarity.microsoft.com/mcp');
    expect(text).not.toContain('/recordings/');
    expect(text).not.toContain('/dashboard/query');
    expect(a.instructions).toMatch(/Not covered/);
  });

  it('reads the totals for the last 24 hours by default, with the Bearer token and no dimension', async () => {
    ok();
    await call('microsoft_clarity_get_dashboard_insights', {});
    const req = sent();
    expect(req.url).toBe(ENDPOINT);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Authorization')).toBe(`Bearer ${ENV.CLARITY_API_TOKEN}`);
    expect(req.params).toEqual({ numOfDays: 1 });
  });

  it('sends the fixed dimensions of each preset exactly as Microsoft names them', async () => {
    ok();
    await call('microsoft_clarity_get_page_insights', { num_of_days: 3 });
    expect(sent().url).toBe(ENDPOINT);
    expect(sent().params).toEqual({ numOfDays: 3, dimension1: 'URL' });

    ok();
    await call('microsoft_clarity_get_page_insights', { num_of_days: 2, second_dimension: 'Device' });
    expect(sent().params).toEqual({ numOfDays: 2, dimension1: 'URL', dimension2: 'Device' });

    ok();
    await call('microsoft_clarity_get_traffic_source_insights', {});
    expect(sent().params).toEqual({ numOfDays: 1, dimension1: 'Channel', dimension2: 'Source', dimension3: 'Medium' });

    ok();
    await call('microsoft_clarity_get_device_insights', { num_of_days: 2 });
    expect(sent().params).toEqual({ numOfDays: 2, dimension1: 'Device', dimension2: 'Browser', dimension3: 'OS' });

    ok();
    await call('microsoft_clarity_get_country_insights', {});
    expect(sent().params).toEqual({ numOfDays: 1, dimension1: 'Country/Region' });

    ok();
    await call('microsoft_clarity_get_country_insights', { second_dimension: 'Channel' });
    expect(sent().params).toEqual({ numOfDays: 1, dimension1: 'Country/Region', dimension2: 'Channel' });
  });

  it('passes one to three chosen dimensions through and leaves the unused ones out', async () => {
    ok();
    await call('microsoft_clarity_get_insights_by_dimensions', { dimension1: 'Campaign' });
    expect(sent().params).toEqual({ numOfDays: 1, dimension1: 'Campaign' });

    ok();
    await call('microsoft_clarity_get_insights_by_dimensions', {
      num_of_days: 3,
      dimension1: 'URL',
      dimension2: 'Device',
      dimension3: 'Country/Region',
    });
    expect(sent().url).toBe(ENDPOINT);
    expect(sent().params).toEqual({ numOfDays: 3, dimension1: 'URL', dimension2: 'Device', dimension3: 'Country/Region' });
  });
});

// Opt-in: RUN_MICROSOFT_CLARITY_LIVE=1. The refusal checks need no account.
// The read needs CLARITY_API_TOKEN and uses one of the project's 10 daily
// requests. Nothing is written.
const live = process.env.RUN_MICROSOFT_CLARITY_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('microsoft clarity: live', () => {
  it('refuses a call without a token and a call with a wrong token', async () => {
    const none = await liveFetch.get(ENDPOINT, { params: { numOfDays: 1 }, validateStatus: () => true });
    expect(none.status).toBe(401);
    const wrong = await liveFetch.get(ENDPOINT, {
      params: { numOfDays: 1 },
      headers: { Authorization: 'Bearer not.a.token' },
      validateStatus: () => true,
    });
    expect([401, 403]).toContain(wrong.status);
  });

  it('reads one export of the last 24 hours (uses one of the 10 daily requests)', async () => {
    const token = process.env.CLARITY_API_TOKEN;
    if (!token) throw new Error('Set CLARITY_API_TOKEN for the live read');
    const response = await liveFetch.get(ENDPOINT, {
      params: { numOfDays: 1 },
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      validateStatus: () => true,
    });
    // 429 means today's quota is already used: the token was still accepted.
    expect([200, 429]).toContain(response.status);
    if (response.status === 200) {
      expect(Array.isArray(response.data)).toBe(true);
      for (const block of response.data as Array<{ metricName?: unknown; information?: unknown }>) {
        expect(typeof block.metricName).toBe('string');
        expect(Array.isArray(block.information)).toBe(true);
      }
    }
  });
});
