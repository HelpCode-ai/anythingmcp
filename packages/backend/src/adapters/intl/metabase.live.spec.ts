import * as adapter from './metabase.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Metabase REST API (OpenAPI at https://www.metabase.com/docs/latest/api.json): the
 * instance's own address plus /api/..., API key in the x-api-key header. Query results
 * come back with status "completed" or "failed" (HTTP 202 either way).
 * Live part (reads only: current user, databases, search, collections):
 *   METABASE_URL=https://metabase.example.com METABASE_API_KEY=mb_... RUN_METABASE_LIVE=1 npx jest src/adapters/intl/metabase
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
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { secret?: boolean }>;
  probe: { tool: string };
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
const PREFIX = 'metabase_';
const shape = (name: string, body: unknown) => applyResponseTransform(body, tool(name).responseMapping as never).value;

describe('metabase adapter: static spec conformance', () => {
  it('sends the API key in the x-api-key header to the instance address', () => {
    expect(a.requiredEnvVars).toEqual(['METABASE_URL', 'METABASE_API_KEY']);
    expect(a.connector.baseUrl).toBe('{{METABASE_URL}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'x-api-key', apiKey: '{{METABASE_API_KEY}}' });
    expect(a.envVarMeta?.METABASE_API_KEY.secret).toBe(true);
    expect(a.connector.config?.errorWhen).toEqual([{ path: 'status', equals: 'failed', messagePath: 'error', status: 400 }]);
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/api\//);
  });

  it('maps the metadata and content reads to the documented paths', () => {
    expect(tool('metabase_get_current_user').endpointMapping).toEqual({ method: 'GET', path: '/api/user/current' });
    expect(tool('metabase_list_databases').endpointMapping).toEqual({ method: 'GET', path: '/api/database', queryParams: { include: '$include', saved: '$saved' } });
    expect(tool('metabase_get_database_metadata').endpointMapping.path).toBe('/api/database/{database_id}/metadata');
    expect(tool('metabase_list_database_schemas').endpointMapping.path).toBe('/api/database/{database_id}/schemas');
    expect(tool('metabase_list_schema_tables').endpointMapping.path).toBe('/api/database/{database_id}/schema/{schema}');
    expect(tool('metabase_get_table_metadata').endpointMapping).toEqual({ method: 'GET', path: '/api/table/{table_id}/query_metadata', queryParams: { include_hidden_fields: '$include_hidden_fields' } });
    expect(tool('metabase_get_field_values').endpointMapping.path).toBe('/api/field/{field_id}/values');
    expect(tool('metabase_list_cards').endpointMapping).toEqual({ method: 'GET', path: '/api/card', queryParams: { f: '$f', model_id: '$model_id' } });
    expect(tool('metabase_get_card').endpointMapping.path).toBe('/api/card/{card_id}');
    expect(tool('metabase_list_dashboards').endpointMapping.path).toBe('/api/dashboard');
    expect(tool('metabase_get_dashboard').endpointMapping.path).toBe('/api/dashboard/{dashboard_id}');
    expect(tool('metabase_list_collections').endpointMapping.queryParams).toEqual({ archived: '$archived', 'personal-only': '$personal_only', 'exclude-other-user-collections': '$exclude_other_user_collections' });
    expect(tool('metabase_list_collection_items').endpointMapping).toMatchObject({ path: '/api/collection/{collection_id}/items', queryParams: { models: '$models', 'pinned-state': '$pinned_state', 'sort-column': '$sort_column', 'sort-direction': '$sort_direction', limit: '$limit', offset: '$offset' } });
    expect(tool('metabase_search').endpointMapping).toMatchObject({ method: 'GET', path: '/api/search', queryParams: { q: '$q', models: '$models', table_db_id: '$table_db_id', limit: '$limit', offset: '$offset' } });
    expect(tool('metabase_get_recent_items').endpointMapping).toEqual({ method: 'GET', path: '/api/activity/recents', queryParams: { context: '$context' } });
    expect(tool('metabase_get_recent_items').parameters?.properties?.context.default).toBe('views');
    expect(tool('metabase_get_popular_items').endpointMapping.path).toBe('/api/activity/popular_items');
    expect(tool('metabase_list_permission_groups').endpointMapping.path).toBe('/api/permissions/group');
  });

  it('runs queries over POST and marks them read-only', () => {
    expect(tool('metabase_run_card').endpointMapping).toEqual({ method: 'POST', path: '/api/card/{card_id}/query', bodyMapping: { parameters: '$parameters', ignore_cache: '$ignore_cache' } });
    expect(tool('metabase_run_dashboard_card').endpointMapping).toEqual({ method: 'POST', path: '/api/dashboard/{dashboard_id}/dashcard/{dashcard_id}/card/{card_id}/query', bodyMapping: { parameters: '$parameters' } });
    expect(tool('metabase_run_native_query').endpointMapping).toEqual({
      method: 'POST',
      path: '/api/dataset',
      bodyMapping: { database: '$database_id', type: 'native', native: { query: '$sql', 'template-tags': '$template_tags' }, parameters: '$parameters' },
    });
    expect(tool('metabase_run_query').endpointMapping).toEqual({ method: 'POST', path: '/api/dataset', bodyMapping: { __merge: '$dataset_query' } });
    for (const n of ['run_card', 'run_dashboard_card', 'run_native_query', 'run_query']) expect(tool(PREFIX + n).annotations?.readOnlyHint).toBe(true);
  });

  it('maps the writes; archiving goes through the updates and nothing deletes', () => {
    expect(tool('metabase_create_card').endpointMapping).toMatchObject({ method: 'POST', path: '/api/card', bodyMapping: { name: '$name', dataset_query: '$dataset_query', display: '$display', visualization_settings: '$visualization_settings' } });
    expect(tool('metabase_create_card').parameters?.properties?.visualization_settings.default).toEqual({});
    expect(tool('metabase_update_card').endpointMapping).toMatchObject({ method: 'PUT', path: '/api/card/{card_id}', bodyMapping: { archived: '$archived' } });
    expect(tool('metabase_create_dashboard').endpointMapping).toMatchObject({ method: 'POST', path: '/api/dashboard' });
    expect(tool('metabase_update_dashboard').endpointMapping).toMatchObject({ method: 'PUT', path: '/api/dashboard/{dashboard_id}', bodyMapping: { dashcards: '$dashcards', tabs: '$tabs' } });
    expect(tool('metabase_create_collection').endpointMapping).toEqual({ method: 'POST', path: '/api/collection', bodyMapping: { name: '$name', description: '$description', parent_id: '$parent_id' } });
    expect(tool('metabase_update_collection').endpointMapping).toMatchObject({ method: 'PUT', path: '/api/collection/{collection_id}' });
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual([]);
  });

  it('drops connection details, fingerprints and result metadata, keeping rows and ids', () => {
    expect(shape('metabase_list_databases', { data: [{ id: 1, name: 'Sales', engine: 'postgres', details: { host: 'db', user: 'u' }, features: ['x'] }], total: 1 })).toEqual({ data: [{ id: 1, name: 'Sales', engine: 'postgres' }], total: 1 });
    expect(shape('metabase_list_cards', [{ id: 7, name: 'Revenue', dataset_query: { type: 'native' }, result_metadata: [{ a: 1 }], visualization_settings: { b: 2 } }])).toEqual([{ id: 7, name: 'Revenue', dataset_query: { type: 'native' } }]);
    expect(
      shape('metabase_run_card', { status: 'completed', row_count: 1, json_query: { q: 1 }, data: { rows: [[1]], cols: [{ name: 'n', base_type: 'type/Integer', fingerprint: { f: 1 } }], results_metadata: { columns: [] } } }),
    ).toEqual({ status: 'completed', row_count: 1, data: { rows: [[1]], cols: [{ name: 'n', base_type: 'type/Integer' }] } });
    expect(shape('metabase_get_table_metadata', { id: 3, db: { id: 1, details: { host: 'h' } }, fields: [{ id: 9, name: 'x', fingerprint: { f: 1 } }] })).toEqual({ id: 3, db: { id: 1 }, fields: [{ id: 9, name: 'x' }] });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_METABASE_LIVE === '1' && process.env.METABASE_URL && process.env.METABASE_API_KEY ? describe : describe.skip;
live('metabase adapter: live (read-only)', () => {
  const base = String(process.env.METABASE_URL).replace(/\/+$/, '');
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { 'x-api-key': String(process.env.METABASE_API_KEY), Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as unknown;
  };
  it('reads the current user, databases, collections and search', async () => {
    expect(await get('/api/user/current')).toHaveProperty('id');
    expect(Array.isArray(((await get('/api/database')) as { data: unknown[] }).data)).toBe(true);
    expect(Array.isArray(await get('/api/collection'))).toBe(true);
    expect(Array.isArray(((await get('/api/search?q=a&limit=5')) as { data: unknown[] }).data)).toBe(true);
  }, 60_000);
});
