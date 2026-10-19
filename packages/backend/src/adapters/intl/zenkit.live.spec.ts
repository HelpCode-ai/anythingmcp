import axios from 'axios';
import * as adapter from './zenkit.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Zenkit adapter (REST API v1):
 *
 *   1. Static: always runs. Pins the Zenkit-API-Key header on zenkit.com/api/v1,
 *      every tool's method, path, query and body through the real RestEngine
 *      against Zenkit's API reference (base.zenkit.com/docs/api), the entry
 *      bodies keyed by <field uuid>_<value key>, and which tools write or
 *      install switched off. The JSON bodies of filter, create, update,
 *      comment and archive were also checked against the live server's
 *      request validation, which runs before authentication.
 *
 *   2. Live: skipped unless RUN_ZENKIT_LIVE=1 and ZENKIT_API_KEY are set.
 *      Reads only: the user, workspaces, and fields and entries of the
 *      first collection.
 *
 *        RUN_ZENKIT_LIVE=1 ZENKIT_API_KEY=... npx jest src/adapters/intl/zenkit.live.spec.ts
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
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: { method: string; path: string; encodePathParams?: boolean; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

// Built at run time so no literal here looks like a real key.
const KEY = ['Ab12Cd34', 'Ef56Gh78Ij90Kl12Mn34Op56Qr78St90'].join('-');
const BASE = 'https://zenkit.com/api/v1';
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, key: string, params: Record<string, unknown>) => {
  const env = { ZENKIT_API_KEY: key };
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return engine().execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: { headerName: 'Zenkit-API-Key', apiKey: key }, headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, KEY, params);
const sent = () => mockedAxios.mock.calls[0][0];

const UUID = '5a2e6a4c-1b2c-4d3e-8f90-123456789abc';
const WRITES = ['zenkit_comment_on_entry', 'zenkit_archive_entries', 'zenkit_create_entry', 'zenkit_update_entry'];

describe('zenkit adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the official API reference on 19 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('zenkit');
    expect(a.icon).toBe('zenkit');
    expect(a.category).toBe('project-management');
  });

  it('sends the key in the Zenkit-API-Key header and asks for English errors', async () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Zenkit-API-Key', apiKey: '{{ZENKIT_API_KEY}}' });
    expect(a.connector.headers['Accept-Language']).toBe('en');
    expect(a.connector.healthcheckPath).toBe('/users/me');
    expect(a.probe.tool).toBe('zenkit_get_current_user');
    mockedAxios.mockResolvedValue({ data: {} });
    await call('zenkit_get_current_user', {});
    expect(sent().headers['Zenkit-API-Key']).toBe(KEY);
    expect(sent().url).toBe(`${BASE}/users/me`);
    expect(JSON.stringify(sent().params ?? {})).not.toContain(KEY);
  });

  it('asks for the key as a secret', () => {
    expect(a.requiredEnvVars).toEqual(['ZENKIT_API_KEY']);
    const meta = a.envVarMeta.ZENKIT_API_KEY;
    expect(meta.secret).toBe(true);
    expect(meta.kind).toBe('credential');
    const re = new RegExp(meta.pattern!);
    expect(re.test(KEY)).toBe(true);
    for (const bad of ['', 'short', `Zenkit-API-Key: ${KEY}`, `${KEY} `]) expect(re.test(bad)).toBe(false);
    expect(describeAdapterEnvVars(a as never).find((d) => d.name === 'ZENKIT_API_KEY')!.secret).toBe(true);
  });

  it('prefixes every tool with zenkit_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^zenkit_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only (the POST filter too), asks for confirmation on every write and installs archiving switched off', () => {
    for (const t of a.tools) {
      const read = t.endpointMapping.method === 'GET' || t.name === 'zenkit_filter_entries';
      expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${read}`);
    }
    expect(a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort()).toEqual([...WRITES].sort());
    for (const name of WRITES) expect(tool(name).description).toMatch(/confirm with the user first/i);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['zenkit_archive_entries']);
    expect(annotationsOf(tool('zenkit_archive_entries')).destructiveHint).toBe(true);
    // Permanent deletion is not offered.
    for (const t of a.tools) expect(t.endpointMapping.path).not.toContain('deprecated-entries');
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
  });

  it('URL-encodes path ids, so an id cannot reach another route', async () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.path.includes('{'))) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    mockedAxios.mockResolvedValue({ data: {} });
    await call('zenkit_get_entry', { list_id: 'abc1234', entry_id: '../../users/me' });
    expect(sent().url).toBe(`${BASE}/lists/abc1234/entries/..%2F..%2Fusers%2Fme`);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bzenkit_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bzenkit_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(8);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Zenkit\n')).toBe(true);
    for (const text of ['Integrations', 'API Key', '200 requests a minute', '_categories', 'C21', 'Out of scope']) expect(a.instructions).toContain(text);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  // [tool, args, method, path] from the Zenkit API reference.
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['zenkit_get_current_user', {}, 'GET', '/users/me'],
    ['zenkit_list_workspaces_with_lists', {}, 'GET', '/users/me/workspacesWithLists'],
    ['zenkit_get_workspace', { workspace_id: 'Wk12345' }, 'GET', '/workspaces/Wk12345'],
    ['zenkit_list_workspace_users', { workspace_id: 42 }, 'GET', '/workspaces/42/users'],
    ['zenkit_get_list', { list_id: 'Ls12345' }, 'GET', '/lists/Ls12345'],
    ['zenkit_list_list_users', { list_id: 'Ls12345' }, 'GET', '/lists/Ls12345/users'],
    ['zenkit_list_fields', { list_id: 'Ls12345' }, 'GET', '/lists/Ls12345/elements'],
    ['zenkit_filter_entries', { list_id: 'Ls12345' }, 'POST', '/lists/Ls12345/entries/filter/list'],
    ['zenkit_search_entries', { query: 'invoice' }, 'GET', '/entries/search'],
    ['zenkit_get_entry', { list_id: 'Ls12345', entry_id: 'En12345' }, 'GET', '/lists/Ls12345/entries/En12345'],
    ['zenkit_list_entry_activities', { list_id: 'Ls12345', entry_id: 'En12345' }, 'GET', '/lists/Ls12345/entries/En12345/activities'],
    ['zenkit_list_list_activities', { list_id: 'Ls12345' }, 'GET', '/lists/Ls12345/activities'],
    ['zenkit_create_entry', { list_id: 'Ls12345', values: { [`${UUID}_text`]: 'A' } }, 'POST', '/lists/Ls12345/entries'],
    ['zenkit_update_entry', { list_id: 'Ls12345', entry_id: 'En12345', values: { [`${UUID}_text`]: 'B' } }, 'PUT', '/lists/Ls12345/entries/En12345'],
    ['zenkit_comment_on_entry', { list_id: 'Ls12345', entry_id: 'En12345', message: 'Done' }, 'POST', '/users/me/lists/Ls12345/entries/En12345/activities'],
    ['zenkit_archive_entries', { list_id: 'Ls12345', entry_ids: [101] }, 'POST', '/lists/Ls12345/entries/delete/filter'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to %s', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(sent().method).toBe(method);
    expect(sent().url).toBe(`${BASE}${path}`);
  });

  it('filters entries with only the body keys Zenkit allows, 50 per page by default', async () => {
    mockedAxios.mockResolvedValue({ data: { countData: { total: 0, filteredTotal: 0 }, listEntries: [] } });
    await call('zenkit_filter_entries', { list_id: 'Ls12345' });
    expect(sent().data).toEqual({ limit: 50 });
    mockedAxios.mockClear();
    const filter = { AND: { TERMS: [{ elementId: 230, modus: 'contains', text: 'invoice' }] } };
    await call('zenkit_filter_entries', { list_id: 'Ls12345', filter, limit: 10, skip: 20, allowDeprecated: false });
    expect(sent().data).toEqual({ filter, limit: 10, skip: 20, allowDeprecated: false });
  });

  it('sends entry values as top-level <uuid>_<key> fields, with updateAction on updates', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const values = { [`${UUID}_text`]: 'Call supplier', [`${UUID}_checked`]: true, [`${UUID}_categories`]: [2] };
    await call('zenkit_create_entry', { list_id: 'Ls12345', values });
    expect(sent().data).toEqual(values);
    mockedAxios.mockClear();
    await call('zenkit_update_entry', { list_id: 'Ls12345', entry_id: 'En12345', values: { [`${UUID}_persons`]: [7] }, update_action: 'append' });
    expect(sent().data).toEqual({ [`${UUID}_persons`]: [7], updateAction: 'append' });
  });

  it('comments with a message body and archives by numeric ids without deleting everything', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('zenkit_comment_on_entry', { list_id: 'Ls12345', entry_id: 'En12345', message: 'Done' });
    expect(sent().data).toEqual({ message: 'Done' });
    mockedAxios.mockClear();
    await call('zenkit_archive_entries', { list_id: 'Ls12345', entry_ids: [101, 102] });
    expect(sent().data).toEqual({ shouldDeleteAll: false, listEntryIds: [101, 102] });
  });

  it('pages activities in the query string', async () => {
    mockedAxios.mockResolvedValue({ data: { total: 0, activities: [] } });
    await call('zenkit_list_entry_activities', { list_id: 'Ls12345', entry_id: 'En12345', filter: 2 });
    expect(sent().params).toEqual({ filter: 2, limit: 20 });
  });
});

const LIVE_KEY = process.env.ZENKIT_API_KEY;
const live = process.env.RUN_ZENKIT_LIVE === '1' && LIVE_KEY ? describe : describe.skip;

live('zenkit adapter: live API (reads only)', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, LIVE_KEY as string, params);

  it('reads the user, workspaces, and the fields and entries of the first collection', async () => {
    expect((await run('zenkit_get_current_user')).id).toBeDefined();
    const workspaces = await run('zenkit_list_workspaces_with_lists');
    expect(Array.isArray(workspaces)).toBe(true);
    const list = workspaces.flatMap((w: { lists?: unknown[] }) => w.lists ?? [])[0] as { id: number } | undefined;
    if (!list) return;
    expect(Array.isArray(await run('zenkit_list_fields', { list_id: String(list.id) }))).toBe(true);
    const entries = await run('zenkit_filter_entries', { list_id: String(list.id), limit: 3 });
    expect(Array.isArray(entries.listEntries)).toBe(true);
  }, 60_000);

  it('a wrong key is a 401', async () => {
    await expect(execute('zenkit_get_current_user', 'AAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', {})).rejects.toMatchObject({ response: { status: 401 } });
  }, 30_000);
});
