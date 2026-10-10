import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as adapterJson from './supabase.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Static checks and request-shape checks against a local server always run.
 * The live block runs every read tool through the real RestEngine against the
 * Supabase Management API:
 *   SUPABASE_ACCESS_TOKEN=sbp_... [SUPABASE_PROJECT_REF=abcdefghijklmnopqrst] \
 *     npx jest src/adapters/intl/supabase.live.spec.ts
 * Without SUPABASE_PROJECT_REF the first ACTIVE_HEALTHY project is used.
 * SUPABASE_LIVE_WRITE=1 (needs SUPABASE_PROJECT_REF, a throwaway project)
 * also creates a table public.anythingmcp_test_<time> with supabase_execute_sql,
 * inserts and updates a row, reads it back read-only, and drops the table in
 * `finally`.
 */

type Mapping = { method: string; path: string; encodePathParams?: boolean; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  annotations?: Record<string, boolean>;
  parameters: { properties?: Record<string, { default?: unknown }>; required?: string[] };
  endpointMapping: Mapping;
  responseMapping?: Record<string, unknown>;
};
const a = adapterJson as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind: string; secret?: boolean; pattern?: string }>;
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
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
const SQL_READS = ['supabase_describe_table', 'supabase_list_extensions', 'supabase_list_schemas', 'supabase_list_tables', 'supabase_run_read_only_sql'];
const READ_ONLY_PATH = '/v1/projects/{project_ref}/database/query/read-only';

describe('supabase adapter: static spec conformance', () => {
  it('is unlisted until verified against a real account', () => {
    expect(a.unlisted).toBe(true);
  });

  it('calls the Management API with the personal access token as Bearer', () => {
    expect(a.connector.baseUrl).toBe('https://api.supabase.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{SUPABASE_ACCESS_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['SUPABASE_ACCESS_TOKEN']);
    expect(a.envVarMeta.SUPABASE_ACCESS_TOKEN.secret).toBe(true);
    const token = new RegExp(a.envVarMeta.SUPABASE_ACCESS_TOKEN.pattern!);
    expect(token.test('sbp_' + '0'.repeat(40))).toBe(true);
    expect(token.test('Bearer sbp_0123')).toBe(false);
    expect(token.test('eyJhbGciOiJIUzI1NiJ9.service_role')).toBe(false);
  });

  it('probes with the project list, which needs no argument', () => {
    expect(a.probe.tool).toBe('supabase_list_projects');
    expect(tool('supabase_list_projects').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/v1/projects');
  });

  it('prefixes every tool with supabase_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^supabase_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('is read-only except for supabase_execute_sql, which installs switched off and destructive', () => {
    const writes = a.tools.filter((t) => !annotationsOf(t).readOnlyHint).map((t) => t.name);
    expect(writes).toEqual(['supabase_execute_sql']);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['supabase_execute_sql']);
    expect(annotationsOf(tool('supabase_execute_sql')).destructiveHint).toBe(true);
    expect(tool('supabase_execute_sql').description).toMatch(/confirm/i);
    for (const t of a.tools.filter((x) => x.endpointMapping.method !== 'GET')) {
      if (t.name === 'supabase_execute_sql') continue;
      expect(`${t.name} ${t.endpointMapping.method} ${t.endpointMapping.path}`).toBe(`${t.name} POST ${READ_ONLY_PATH}`);
    }
    expect(a.tools.filter((t) => t.endpointMapping.path === READ_ONLY_PATH).map((t) => t.name).sort()).toEqual(SQL_READS);
  });

  it('schema-qualifies every catalog reference in its own SQL, as the read-only endpoint requires', () => {
    for (const name of SQL_READS.filter((n) => n !== 'supabase_run_read_only_sql')) {
      const sql = String(tool(name).endpointMapping.bodyMapping!.query);
      const unqualified = [...sql.matchAll(/\b(from|join)\s+([a-z_]+)(?!\.)\b/gi)].map((m) => m[2]);
      expect(`${name}: ${unqualified.join(',')}`).toBe(`${name}: `);
    }
  });

  it('lists API keys without reveal and keeps only public key values', () => {
    expect(tool('supabase_list_api_keys').endpointMapping.queryParams).toEqual({ reveal: 'false' });
    const raw = [
      { id: '1', name: 'anon', type: 'legacy', api_key: 'eyJ.anon', prefix: null },
      { id: '2', name: 'service_role', type: 'legacy', api_key: 'eyJ.service', prefix: null },
      { id: '3', name: 'default', type: 'publishable', api_key: 'sb_publishable_abc', prefix: 'sb_publishable_abc' },
      { id: '4', name: 'default', type: 'secret', api_key: 'sb_secret_ab········', prefix: 'sb_secret_ab' },
    ];
    const out = applyResponseTransform(raw, tool('supabase_list_api_keys').responseMapping).value as Array<{ name: string; api_key: string | null }>;
    expect(out.map((k) => [k.name, k.api_key])).toEqual([
      ['anon', 'eyJ.anon'],
      ['service_role', null],
      ['default', 'sb_publishable_abc'],
      ['default', null],
    ]);
    // A shape the expression cannot read is an error, never the raw answer.
    const odd = applyResponseTransform({ unexpected: 'eyJ.service' }, tool('supabase_list_api_keys').responseMapping);
    expect(odd.value).not.toEqual({ unexpected: 'eyJ.service' });
  });

  it('only points the model at tools that exist, documents setup and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bsupabase_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bsupabase_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(8);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions).toContain('https://supabase.com/dashboard/account/tokens');
    expect(a.instructions).toContain('Read-only setup');
    expect(a.instructions).toMatch(/last minute/);
    expect(JSON.stringify(adapterJson)).not.toMatch(/[–—]/);
    expect(JSON.stringify(adapterJson)).not.toContain('logs.all');
  });
});

describe('supabase adapter: requests through the real engine', () => {
  let server: http.Server;
  let origin: string;
  const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.setHeader('Content-Type', 'application/json');
        res.end('[]');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => (seen.length = 0));

  const run = (name: string, params: Record<string, unknown>) =>
    engine().execute(
      { baseUrl: origin, authType: 'BEARER_TOKEN', authConfig: { token: 'sbp_test' }, headers: a.connector.headers },
      tool(name).endpointMapping,
      applySchemaDefaults(tool(name).parameters, params),
    );

  it('runs read-only SQL with bound parameters on the read-only endpoint', async () => {
    await run('supabase_run_read_only_sql', { project_ref: 'abcdefghijklmnopqrst', query: 'select * from public.orders where id = $1', parameters: [7] });
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/v1/projects/abcdefghijklmnopqrst/database/query/read-only');
    expect(seen[0].headers.authorization).toBe('Bearer sbp_test');
    expect(JSON.parse(seen[0].body)).toEqual({ query: 'select * from public.orders where id = $1', parameters: [7] });
  });

  it('lists tables of the given schemas as one bound parameter, public by default', async () => {
    await run('supabase_list_tables', { project_ref: 'abcdefghijklmnopqrst' });
    const sent = JSON.parse(seen[0].body);
    expect(sent.parameters).toEqual(['public']);
    expect(sent.query).toContain('string_to_array($1');
    await run('supabase_describe_table', { project_ref: 'abcdefghijklmnopqrst', table: 'Orders' });
    expect(JSON.parse(seen[1].body).parameters).toEqual(['public', 'Orders']);
  });

  it('checks health of the default services as repeated keys', async () => {
    await run('supabase_get_project_health', { project_ref: 'abcdefghijklmnopqrst' });
    const url = new URL(seen[0].url!, origin);
    expect(url.pathname).toBe('/v1/projects/abcdefghijklmnopqrst/health');
    expect(url.searchParams.getAll('services')).toEqual(['db', 'auth', 'rest', 'realtime', 'storage']);
  });

  it('queries logs on the current endpoint with the SQL and the range', async () => {
    await run('supabase_query_logs', { project_ref: 'abcdefghijklmnopqrst', sql: "select timestamp from logs where source = 'edge_logs' limit 5", iso_timestamp_start: '2026-10-10T08:00:00Z', iso_timestamp_end: '2026-10-10T09:00:00Z' });
    const url = new URL(seen[0].url!, origin);
    expect(url.pathname).toBe('/v1/projects/abcdefghijklmnopqrst/analytics/endpoints/logs');
    expect(url.searchParams.get('sql')).toBe("select timestamp from logs where source = 'edge_logs' limit 5");
    expect(url.searchParams.get('iso_timestamp_start')).toBe('2026-10-10T08:00:00Z');
  });

  it('asks for API keys with reveal=false', async () => {
    await run('supabase_list_api_keys', { project_ref: 'abcdefghijklmnopqrst' });
    expect(seen[0].url).toBe('/v1/projects/abcdefghijklmnopqrst/api-keys?reveal=false');
  });
});

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('supabase adapter: live Management API', () => {
  const config = () => ({ baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: TOKEN as string }, headers: a.connector.headers });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    engine().execute(config(), tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params));
  const status = (e: any) => e?.response?.status;

  let ref = process.env.SUPABASE_PROJECT_REF;

  beforeAll(async () => {
    if (ref) return;
    const projects = await run('supabase_list_projects');
    ref = projects.find((p: { status: string }) => p.status === 'ACTIVE_HEALTHY')?.ref;
  }, 30000);

  it('reads projects, organizations, the project and its health', async () => {
    const projects = await run('supabase_list_projects');
    expect(Array.isArray(projects)).toBe(true);
    const orgs = await run('supabase_list_organizations');
    expect(Array.isArray(orgs)).toBe(true);
    if (orgs[0]) expect((await run('supabase_get_organization', { organization_slug: orgs[0].slug })).name).toBeDefined();
    expect(ref).toBeDefined();
    expect((await run('supabase_get_project', { project_ref: ref })).ref).toBe(ref);
    const health = await run('supabase_get_project_health', { project_ref: ref });
    expect(health.map((s: { name: string }) => s.name).sort()).toEqual(['auth', 'db', 'realtime', 'rest', 'storage']);
  }, 60000);

  it('runs read-only SQL, lists schemas, tables, a table, extensions, migrations, backups and types', async () => {
    const rows = await run('supabase_run_read_only_sql', { project_ref: ref, query: 'select $1::int + 1 as two', parameters: [1] });
    expect(rows).toEqual([{ two: 2 }]);
    await expect(run('supabase_run_read_only_sql', { project_ref: ref, query: 'create table public.anythingmcp_never (id int)' })).rejects.toBeDefined();
    const schemas = await run('supabase_list_schemas', { project_ref: ref });
    expect(schemas.map((s: { schema: string }) => s.schema)).toEqual(expect.arrayContaining(['public', 'auth']));
    const tables = await run('supabase_list_tables', { project_ref: ref, schemas: 'public,auth' });
    expect(tables.some((t: { schema: string; name: string }) => t.schema === 'auth' && t.name === 'users')).toBe(true);
    const users = await run('supabase_describe_table', { project_ref: ref, schema: 'auth', table: 'users' });
    expect(users[0].columns.some((c: { name: string }) => c.name === 'email')).toBe(true);
    expect(users[0].constraints.some((c: { type: string }) => c.type === 'primary key')).toBe(true);
    expect((await run('supabase_list_extensions', { project_ref: ref })).some((e: { name: string }) => e.name === 'plpgsql')).toBe(true);
    expect(Array.isArray(await run('supabase_list_migrations', { project_ref: ref }))).toBe(true);
    expect(await run('supabase_list_backups', { project_ref: ref })).toHaveProperty('backups');
    expect(typeof (await run('supabase_generate_typescript_types', { project_ref: ref })).types).toBe('string');
  }, 90000);

  it('reads Edge Functions, storage buckets and API keys without secret values', async () => {
    const fns = await run('supabase_list_edge_functions', { project_ref: ref });
    expect(Array.isArray(fns)).toBe(true);
    if (fns[0]) expect((await run('supabase_get_edge_function', { project_ref: ref, function_slug: fns[0].slug })).slug).toBe(fns[0].slug);
    expect(Array.isArray(await run('supabase_list_storage_buckets', { project_ref: ref }))).toBe(true);
    const raw = await run('supabase_list_api_keys', { project_ref: ref });
    const shaped = applyResponseTransform(raw, tool('supabase_list_api_keys').responseMapping);
    expect(shaped.applied).toBe(true);
    for (const k of shaped.value as Array<{ name: string; type: string; api_key: string | null }>) {
      if (k.type !== 'publishable' && k.name !== 'anon') expect(k.api_key).toBeNull();
    }
  }, 60000);

  it('queries logs and API usage, and runs both advisors', async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 60 * 60 * 1000);
    const logs = await run('supabase_query_logs', {
      project_ref: ref,
      sql: "select timestamp, event_message from logs where source = 'edge_logs' order by timestamp desc limit 5",
      iso_timestamp_start: start.toISOString().replace(/\.\d+Z$/, 'Z'),
      iso_timestamp_end: end.toISOString().replace(/\.\d+Z$/, 'Z'),
    });
    expect(logs).toHaveProperty('result');
    expect(await run('supabase_get_api_usage', { project_ref: ref })).toHaveProperty('result');
    expect(Array.isArray((await run('supabase_get_security_advisors', { project_ref: ref })).lints)).toBe(true);
    expect(Array.isArray((await run('supabase_get_performance_advisors', { project_ref: ref })).lints)).toBe(true);
  }, 60000);

  it('lists branches (a paid feature: a free project may refuse)', async () => {
    const branches = await run('supabase_list_branches', { project_ref: ref }).catch((e) => e);
    if (Array.isArray(branches)) {
      if (branches[0]) expect((await run('supabase_get_branch', { project_ref: ref, branch_name: branches[0].name })).name).toBe(branches[0].name);
    } else {
      expect([400, 402, 403, 404, 422]).toContain(status(branches));
    }
  }, 30000);

  it('a wrong token is a 401', async () => {
    await expect(
      engine().execute({ ...config(), authConfig: { token: 'sbp_wrong' } }, tool('supabase_list_projects').endpointMapping, {}),
    ).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (process.env.SUPABASE_LIVE_WRITE === '1' && process.env.SUPABASE_PROJECT_REF ? it : it.skip)(
    'creates a test table, writes and changes a row, reads it back, and drops the table',
    async () => {
      const table = `anythingmcp_test_${Date.now()}`;
      let created = false;
      try {
        await run('supabase_execute_sql', { project_ref: ref, query: `create table public.${table} (id int primary key, note text)` });
        created = true;
        await run('supabase_execute_sql', { project_ref: ref, query: `insert into public.${table} (id, note) values ($1, $2)`, parameters: [1, 'AnythingMCP test'] });
        await run('supabase_execute_sql', { project_ref: ref, query: `update public.${table} set note = $1 where id = 1`, parameters: ['AnythingMCP test (updated)'] });
        const rows = await run('supabase_run_read_only_sql', { project_ref: ref, query: `select note from public.${table} where id = 1` });
        expect(rows).toEqual([{ note: 'AnythingMCP test (updated)' }]);
        const described = await run('supabase_describe_table', { project_ref: ref, table });
        expect(described[0].columns.map((c: { name: string }) => c.name)).toEqual(['id', 'note']);
      } finally {
        if (created) await run('supabase_execute_sql', { project_ref: ref, query: `drop table if exists public.${table}` });
      }
    },
    120000,
  );
});
