import axios from 'axios';
import * as adapter from './nocodb.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the NocoDB adapter:
 *
 *   1. Static: always runs. Pins xc-token API key auth on the instance URL
 *      the user enters, and checks every tool's method is GET, URL paths
 *      are correct, the discovery chain is documented, and descriptions
 *      meet the minimum length.
 *
 *   2. Live: skipped unless RUN_NOCODB_LIVE=1.
 *      With NOCODB_URL and NOCODB_API_TOKEN they run against that instance:
 *      list workspaces, list bases, list tables and read one page of records.
 *
 *        RUN_NOCODB_LIVE=1 npx jest src/adapters/intl/nocodb.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath?: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const FAKE_TOKEN = 'noco_test_' + 'x'.repeat(32);
const ENV: Record<string, string> = { NOCODB_URL: 'https://app.nocodb.com', NOCODB_API_TOKEN: FAKE_TOKEN };
const API = 'https://app.nocodb.com/api/v3';

const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[0][0];
const query = () => {
  const req = sent();
  return req.paramsSerializer ? decodeURIComponent(req.paramsSerializer(req.params)) : '';
};

describe('nocodb adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed and categorized as data', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.category).toBe('data');
    expect(a.icon).toBe('nocodb');
  });

  it('sends the API token as xc-token to the instance URL with /api/v3', () => {
    expect(a.connector.baseUrl).toBe('{{NOCODB_URL}}/api/v3');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'xc-token', apiKey: '{{NOCODB_API_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/meta/workspaces');
    expect(a.probe.tool).toBe('nocodb_list_workspaces');
    expect(a.requiredEnvVars).toEqual(['NOCODB_URL', 'NOCODB_API_TOKEN']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.NOCODB_URL).toMatchObject({ kind: 'address', secret: false });
    expect(meta.NOCODB_API_TOKEN).toMatchObject({ kind: 'credential', secret: true });
  });

  it('accepts Cloud and self-hosted URLs without a trailing slash, and a bare token', () => {
    const url = new RegExp(a.envVarMeta.NOCODB_URL.pattern!);
    for (const ok of ['https://app.nocodb.com', 'https://nocodb.example.com', 'http://nocodb.local:8080']) expect(url.test(ok)).toBe(true);
    for (const bad of ['app.nocodb.com', 'https://app.nocodb.com/', 'https://app.nocodb.com/api/']) expect(url.test(bad)).toBe(false);
    const token = new RegExp(a.envVarMeta.NOCODB_API_TOKEN.pattern!);
    expect(token.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', 'short', '   ']) expect(token.test(bad)).toBe(false);
  });

  it('explains wrong tokens, permissions and a wrong URL', () => {
    for (const status of ['401', '403', '404', '429']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('prefixes every tool with nocodb_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^nocodb_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('has exactly 7 tools and all are read-only GET methods', () => {
    expect(a.tools.length).toBe(7);
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(annotationsOf(t).readOnlyHint).toBe(true);
    }
    expect(a.tools.some((t) => ['DELETE', 'PUT', 'PATCH', 'POST'].includes(t.endpointMapping.method))).toBe(false);
  });

  it('only points the model at tools that exist, and descriptions meet minimum length', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bnocodb_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bnocodb_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('instructions meet the 800-character minimum and cover key topics', () => {
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    expect(a.instructions).toContain('xc-token');
    expect(a.instructions).toContain('SSRF_ALLOWED_HOSTS');
    expect(a.instructions).toContain('Out of scope');
    expect(a.instructions).toMatch(/where/);
    expect(a.instructions).toMatch(/pageSize/);
    expect(a.instructions).toMatch(/rate limit/i);
    expect(a.instructions).toContain('nocodb_list_workspaces');
    expect(a.instructions).toContain('nocodb_list_bases');
    expect(a.instructions).toContain('nocodb_get_table');
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['nocodb_list_workspaces', {}, 'GET', '/meta/workspaces'],
    ['nocodb_list_bases', { workspaceId: 'w_abc123' }, 'GET', '/meta/workspaces/w_abc123/bases'],
    ['nocodb_list_tables', { baseId: 'p_abc123' }, 'GET', '/meta/bases/p_abc123/tables'],
    ['nocodb_get_table', { baseId: 'p_abc123', tableId: 'm_xyz789' }, 'GET', '/meta/bases/p_abc123/tables/m_xyz789'],
    ['nocodb_list_records', { baseId: 'p_abc123', tableId: 'm_xyz789' }, 'GET', '/data/p_abc123/m_xyz789/records'],
    ['nocodb_get_record', { baseId: 'p_abc123', tableId: 'm_xyz789', recordId: 1 }, 'GET', '/data/p_abc123/m_xyz789/records/1'],
    ['nocodb_count_records', { baseId: 'p_abc123', tableId: 'm_xyz789' }, 'GET', '/data/p_abc123/m_xyz789/count'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the xc-token header', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${API}${path}`);
    expect(req.headers['xc-token']).toBe(FAKE_TOKEN);
    expect(JSON.stringify(req)).not.toContain('{{');
  });

  it('keeps a self-hosted URL path', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('nocodb_list_workspaces', {}, { ...ENV, NOCODB_URL: 'https://nocodb.example.com' });
    expect(sent().url).toBe('https://nocodb.example.com/api/v3/meta/workspaces');
  });

  it('writes list_records query params correctly', async () => {
    mockedAxios.mockResolvedValue({ data: { list: [] } });
    await call('nocodb_list_records', {
      baseId: 'p_abc123',
      tableId: 'm_xyz789',
      where: '(Status,eq,Open)~and(Priority,eq,High)',
      sort: '-CreatedAt',
      fields: 'Title,Status',
      page: 2,
      pageSize: 50,
    });
    const q = query();
    expect(q).toContain('where=(Status,eq,Open)~and(Priority,eq,High)');
    expect(q).toContain('sort=-CreatedAt');
    expect(q).toContain('fields=Title,Status');
    expect(q).toContain('page=2');
    expect(q).toContain('pageSize=50');
  });

  it('discovery chain is documented: workspaces -> bases -> tables -> records', () => {
    expect(tool('nocodb_list_workspaces').description).toMatch(/nocodb_list_bases/);
    expect(tool('nocodb_list_bases').description).toMatch(/nocodb_list_workspaces/);
    expect(tool('nocodb_list_bases').description).toMatch(/nocodb_list_tables/);
    expect(tool('nocodb_list_tables').description).toMatch(/nocodb_list_bases/);
    expect(tool('nocodb_list_records').description).toMatch(/nocodb_get_table/);
    expect(tool('nocodb_get_table').description).toMatch(/nocodb_list_records/);
  });
});

const live = process.env.RUN_NOCODB_LIVE === '1' ? describe : describe.skip;
live('nocodb adapter: live', () => {
  const liveEnv = () => ({
    NOCODB_URL: process.env.NOCODB_URL!,
    NOCODB_API_TOKEN: process.env.NOCODB_API_TOKEN!,
  });

  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it('lists workspaces', async () => {
    const result = await call('nocodb_list_workspaces', {}, liveEnv());
    expect(result).toBeDefined();
  }, 30000);

  it('lists bases for the first workspace', async () => {
    const env = liveEnv();
    const workspaces = await call('nocodb_list_workspaces', {}, env);
    const list = workspaces?.list ?? workspaces;
    if (Array.isArray(list) && list.length > 0) {
      const bases = await call('nocodb_list_bases', { workspaceId: list[0].id }, env);
      expect(bases).toBeDefined();
    }
  }, 30000);

  it('lists tables and reads one page of records from the first table', async () => {
    const env = liveEnv();
    const workspaces = await call('nocodb_list_workspaces', {}, env);
    const wsList = workspaces?.list ?? workspaces;
    if (!Array.isArray(wsList) || wsList.length === 0) return;

    const bases = await call('nocodb_list_bases', { workspaceId: wsList[0].id }, env);
    const baseList = bases?.list ?? bases;
    if (!Array.isArray(baseList) || baseList.length === 0) return;

    const tables = await call('nocodb_list_tables', { baseId: baseList[0].id }, env);
    const tableList = tables?.list ?? tables;
    if (!Array.isArray(tableList) || tableList.length === 0) return;

    const records = await call('nocodb_list_records', {
      baseId: baseList[0].id,
      tableId: tableList[0].id,
      pageSize: 5,
    }, env);
    expect(records).toBeDefined();

    const count = await call('nocodb_count_records', {
      baseId: baseList[0].id,
      tableId: tableList[0].id,
    }, env);
    expect(count).toBeDefined();
  }, 60000);
});
