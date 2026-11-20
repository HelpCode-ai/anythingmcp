import * as adapter from './appwrite.json';

/**
 * Appwrite server API adapter (Appwrite Cloud or self-hosted).
 *
 * Static checks always run: the endpoint variable, the X-Appwrite-Key and
 * X-Appwrite-Project headers, every tool's method and path against Appwrite's
 * published OpenAPI document (https://github.com/appwrite/specs, server
 * platform: TablesDB plus the Databases API kept for servers before 1.8), the
 * bracketed "queries[]" parameter, the write bodies, and that deleting a row
 * and running a function install switched off.
 * https://appwrite.io/docs/references
 *
 * Live checks run only with RUN_APPWRITE_LIVE=1. Without credentials they confirm
 * that Appwrite Cloud refuses a wrong key; with APPWRITE_ENDPOINT,
 * APPWRITE_PROJECT_ID and APPWRITE_API_KEY they ping the project and list its
 * databases. Nothing is written.
 *
 *   RUN_APPWRITE_LIVE=1 APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1 \
 *     APPWRITE_PROJECT_ID=... APPWRITE_API_KEY=... npx jest src/adapters/intl/appwrite.live.spec.ts
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { description?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  description: string;
  instructions: string;
  prerequisites?: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string; help?: string; options?: Array<{ value: string; label: string }> }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string>; config?: Record<string, unknown> };
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
// Text outside `code` spans: the website renders descriptions as MDX.
const prose = (text: string) => text.replace(/`[^`]*`/g, '');

const PREFIX = 'appwrite_';
// Method and path of every tool, as the vendor documents them.
const ROUTES: Record<string, [string, string]> = {
  appwrite_ping: ['GET', '/ping'],
  appwrite_list_databases: ['GET', '/tablesdb'],
  appwrite_list_tables: ['GET', '/tablesdb/{database_id}/tables'],
  appwrite_get_table: ['GET', '/tablesdb/{database_id}/tables/{table_id}'],
  appwrite_list_columns: ['GET', '/tablesdb/{database_id}/tables/{table_id}/columns'],
  appwrite_list_rows: ['GET', '/tablesdb/{database_id}/tables/{table_id}/rows'],
  appwrite_get_row: ['GET', '/tablesdb/{database_id}/tables/{table_id}/rows/{row_id}'],
  appwrite_create_row: ['POST', '/tablesdb/{database_id}/tables/{table_id}/rows'],
  appwrite_update_row: ['PATCH', '/tablesdb/{database_id}/tables/{table_id}/rows/{row_id}'],
  appwrite_delete_row: ['DELETE', '/tablesdb/{database_id}/tables/{table_id}/rows/{row_id}'],
  appwrite_list_legacy_databases: ['GET', '/databases'],
  appwrite_list_collections: ['GET', '/databases/{database_id}/collections'],
  appwrite_list_documents: ['GET', '/databases/{database_id}/collections/{collection_id}/documents'],
  appwrite_get_document: ['GET', '/databases/{database_id}/collections/{collection_id}/documents/{document_id}'],
  appwrite_create_document: ['POST', '/databases/{database_id}/collections/{collection_id}/documents'],
  appwrite_update_document: ['PATCH', '/databases/{database_id}/collections/{collection_id}/documents/{document_id}'],
  appwrite_list_users: ['GET', '/users'],
  appwrite_get_user: ['GET', '/users/{user_id}'],
  appwrite_list_user_memberships: ['GET', '/users/{user_id}/memberships'],
  appwrite_list_user_sessions: ['GET', '/users/{user_id}/sessions'],
  appwrite_list_buckets: ['GET', '/storage/buckets'],
  appwrite_get_bucket: ['GET', '/storage/buckets/{bucket_id}'],
  appwrite_list_files: ['GET', '/storage/buckets/{bucket_id}/files'],
  appwrite_get_file: ['GET', '/storage/buckets/{bucket_id}/files/{file_id}'],
  appwrite_list_functions: ['GET', '/functions'],
  appwrite_get_function: ['GET', '/functions/{function_id}'],
  appwrite_list_executions: ['GET', '/functions/{function_id}/executions'],
  appwrite_get_execution: ['GET', '/functions/{function_id}/executions/{execution_id}'],
  appwrite_create_execution: ['POST', '/functions/{function_id}/executions'],
  appwrite_list_teams: ['GET', '/teams'],
  appwrite_get_team: ['GET', '/teams/{team_id}'],
  appwrite_list_team_memberships: ['GET', '/teams/{team_id}/memberships'],
};
const REQUIRED: Record<string, string[]> = {
  appwrite_list_tables: ['database_id'],
  appwrite_get_table: ['database_id', 'table_id'],
  appwrite_list_columns: ['database_id', 'table_id'],
  appwrite_list_rows: ['database_id', 'table_id'],
  appwrite_get_row: ['database_id', 'table_id', 'row_id'],
  appwrite_create_row: ['database_id', 'table_id', 'data'],
  appwrite_update_row: ['database_id', 'table_id', 'row_id'],
  appwrite_delete_row: ['database_id', 'table_id', 'row_id'],
  appwrite_list_collections: ['database_id'],
  appwrite_list_documents: ['database_id', 'collection_id'],
  appwrite_get_document: ['database_id', 'collection_id', 'document_id'],
  appwrite_create_document: ['database_id', 'collection_id', 'data'],
  appwrite_update_document: ['database_id', 'collection_id', 'document_id'],
  appwrite_get_user: ['user_id'],
  appwrite_list_user_memberships: ['user_id'],
  appwrite_list_user_sessions: ['user_id'],
  appwrite_get_bucket: ['bucket_id'],
  appwrite_list_files: ['bucket_id'],
  appwrite_get_file: ['bucket_id', 'file_id'],
  appwrite_get_function: ['function_id'],
  appwrite_list_executions: ['function_id'],
  appwrite_get_execution: ['function_id', 'execution_id'],
  appwrite_create_execution: ['function_id'],
  appwrite_get_team: ['team_id'],
  appwrite_list_team_memberships: ['team_id'],
};
// Installed switched off: an administrator turns them on per connector.
const SWITCHED_OFF: string[] = ['appwrite_delete_row', 'appwrite_create_execution'];
// Writes that are on at install.
const WRITES: string[] = ['appwrite_create_row', 'appwrite_update_row', 'appwrite_create_document', 'appwrite_update_document'];
// POST requests that only read (searches and log queries).
const READ_POSTS: string[] = [];

describe('appwrite adapter: static contract', () => {
  it('declares the catalog envelope, the base URL and the authentication', () => {
    expect(a.slug).toBe('appwrite');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('database');
    expect(a.icon).toBe('appwrite');
    expect(a.requiredEnvVars).toEqual(['APPWRITE_ENDPOINT', 'APPWRITE_PROJECT_ID', 'APPWRITE_API_KEY']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{APPWRITE_ENDPOINT}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Appwrite-Key', apiKey: '{{APPWRITE_API_KEY}}', extraHeaders: { 'X-Appwrite-Project': '{{APPWRITE_PROJECT_ID}}' } });
    for (const name of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) {
      expect(`${name}:${Boolean(a.envVarMeta[name]?.help)}`).toBe(`${name}:true`);
      expect(`${name}:${a.envVarMeta[name]?.secret === true}`).toBe(`${name}:${(['APPWRITE_API_KEY'] as string[]).includes(name)}`);
    }
    // An optional variable in a connector header would be sent as the literal placeholder.
    for (const name of a.optionalEnvVars ?? []) expect(JSON.stringify(a.connector.headers ?? {})).not.toContain(name);
  });

  it('checks the credentials with a cheap read and explains the usual refusals', () => {
    expect(a.probe).toEqual({ tool: 'appwrite_ping' });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const key of ['401', '403', '404', 'rate_limited', 'unreachable']) expect(`${key}:${Boolean(a.verifyHints[key])}`).toBe(`${key}:true`);
  });

  it('maps every tool to its documented method and path', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const t of a.tools) {
      expect(`${t.name} ${t.endpointMapping.method} ${t.endpointMapping.path}`).toBe(`${t.name} ${ROUTES[t.name][0]} ${ROUTES[t.name][1]}`);
      expect(`${t.name}:${JSON.stringify(t.parameters?.required ?? [])}`).toBe(`${t.name}:${JSON.stringify(REQUIRED[t.name] ?? [])}`);
    }
  });

  it('prefixes every tool, sends every declared parameter, declares every argument it reads and requires its path parameters', () => {
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) {
        expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
        expect(`${t.name}:${p}:${Boolean(t.parameters?.properties?.[p]?.description)}`).toBe(`${t.name}:${p}:true`);
      }
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p) || envNames.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required ?? []).toContain(p);
    }
  });

  it('installs deletes and other risky calls switched off and marks reading POSTs read-only', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...SWITCHED_OFF].sort());
    for (const t of a.tools) {
      const method = t.endpointMapping.method;
      if (method === 'DELETE') expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:false`);
      if (READ_POSTS.includes(t.name)) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
      else expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:undefined`);
      const reads = method === 'GET' || READ_POSTS.includes(t.name);
      expect(`${t.name}:${reads || WRITES.includes(t.name) || SWITCHED_OFF.includes(t.name)}`).toBe(`${t.name}:true`);
      if (reads) expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
    }
  });

  it('names every tool in the instructions and keeps the texts MDX-safe', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    const texts = [a.description, a.instructions, a.prerequisites ?? '', ...Object.values(a.verifyHints)];
    for (const t of a.tools) {
      texts.push(t.description);
      for (const p of Object.values(t.parameters?.properties ?? {})) texts.push(p.description ?? '');
    }
    for (const text of texts) expect(prose(text)).not.toMatch(/[{}<]/);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });


  it('accepts Cloud regional and self-hosted endpoints that end in /v1', () => {
    const url = new RegExp(a.envVarMeta.APPWRITE_ENDPOINT.pattern ?? '');
    for (const ok of ['https://cloud.appwrite.io/v1', 'https://fra.cloud.appwrite.io/v1', 'https://appwrite.example.com/v1', 'http://10.0.0.4/v1', 'https://example.com/appwrite/v1']) {
      expect(`${ok}:${url.test(ok)}`).toBe(`${ok}:true`);
    }
    for (const bad of ['https://fra.cloud.appwrite.io', 'https://fra.cloud.appwrite.io/v1/', 'fra.cloud.appwrite.io/v1', '']) expect(`${bad}:${url.test(bad)}`).toBe(`${bad}:false`);
    const project = new RegExp(a.envVarMeta.APPWRITE_PROJECT_ID.pattern ?? '');
    for (const ok of ['66a1f0c2001b2c3d4e5f', 'my-project', 'shop_prod.1']) expect(`${ok}:${project.test(ok)}`).toBe(`${ok}:true`);
    for (const bad of ['', 'has space', '_leading']) expect(`${bad}:${project.test(bad)}`).toBe(`${bad}:false`);
    expect(a.connector.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'AnythingMCP' });
  });

  it('sends queries in the bracketed form Appwrite parses', () => {
    for (const t of a.tools) {
      const props = t.parameters?.properties ?? {};
      if (!('queries' in props)) continue;
      expect(t.endpointMapping.method).toBe('GET');
      expect(t.endpointMapping.queryParams).toMatchObject({ 'queries[]': '$queries' });
      expect((props.queries as unknown as { type: string; items: { type: string } }).items.type).toBe('string');
    }
    expect(tool('appwrite_list_rows').endpointMapping.queryParams).toEqual({ 'queries[]': '$queries', total: '$total' });
    expect(tool('appwrite_list_users').endpointMapping.queryParams).toEqual({ 'queries[]': '$queries', search: '$search' });
  });

  it('builds the row and document bodies and generates an id by default', () => {
    expect(tool('appwrite_create_row').endpointMapping.bodyMapping).toEqual({ rowId: '$row_id', data: '$data', permissions: '$permissions' });
    expect((tool('appwrite_create_row').parameters?.properties?.row_id as unknown as { default: string }).default).toBe('unique()');
    expect(tool('appwrite_update_row').endpointMapping.bodyMapping).toEqual({ data: '$data', permissions: '$permissions' });
    expect(tool('appwrite_create_document').endpointMapping.bodyMapping).toEqual({ documentId: '$document_id', data: '$data', permissions: '$permissions' });
    expect((tool('appwrite_create_document').parameters?.properties?.document_id as unknown as { default: string }).default).toBe('unique()');
    expect(tool('appwrite_update_document').endpointMapping.bodyMapping).toEqual({ data: '$data', permissions: '$permissions' });
    expect(tool('appwrite_create_execution').endpointMapping.bodyMapping).toEqual({ body: '$body', async: '$async', path: '$path', method: '$method', headers: '$headers' });
  });

  it('changes no schema, manages no users and never downloads or uploads a file', () => {
    for (const t of a.tools) {
      const { method, path } = t.endpointMapping;
      expect(path).not.toMatch(/\/download|\/preview|\/view|\/columns\/|\/attributes|\/indexes|\/deployments|\/variables|\/transactions/);
      if (/^\/(users|teams|storage|functions)/.test(path) && t.name !== 'appwrite_create_execution') expect(`${t.name}:${method}`).toBe(`${t.name}:GET`);
      if (method === 'DELETE') expect(t.name).toBe('appwrite_delete_row');
    }
  });
});

const env = process.env;
(env.RUN_APPWRITE_LIVE === '1' ? describe : describe.skip)('appwrite adapter: live (read-only)', () => {
  it('refuses a wrong API key on Appwrite Cloud', async () => {
    const res = await fetch('https://cloud.appwrite.io/v1/ping', { headers: { 'X-Appwrite-Project': 'not-a-project', 'X-Appwrite-Key': 'standard_not-a-real-key' } });
    expect(res.status).toBe(401);
  }, 30_000);

  it('pings the project and lists its databases', async () => {
    if (!env.APPWRITE_ENDPOINT || !env.APPWRITE_PROJECT_ID || !env.APPWRITE_API_KEY) throw new Error('Set APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_API_KEY for the live check');
    const headers = { Accept: 'application/json', 'X-Appwrite-Project': env.APPWRITE_PROJECT_ID, 'X-Appwrite-Key': env.APPWRITE_API_KEY };
    const ping = await fetch(`${env.APPWRITE_ENDPOINT}/ping`, { headers });
    expect(ping.status).toBe(200);
    const limit = encodeURIComponent(JSON.stringify({ method: 'limit', values: [1] }));
    const dbs = await fetch(`${env.APPWRITE_ENDPOINT}/tablesdb?queries[]=${limit}`, { headers });
    // 404 on a self-hosted server before 1.8, where only /databases exists.
    expect([200, 404]).toContain(dbs.status);
    const legacy = await fetch(`${env.APPWRITE_ENDPOINT}/databases?queries[]=${limit}`, { headers });
    expect(legacy.status).toBe(200);
  }, 60_000);
});
