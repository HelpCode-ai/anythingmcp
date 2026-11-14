import * as adapter from './clickhouse.json';

/**
 * ClickHouse HTTP interface (clickhouse.com/docs/interfaces/http): SQL in the POST body,
 * settings and query parameters ({name:Type} filled from param_name) in the URL, HTTP
 * Basic auth. Every tool sends readonly=1 so the server refuses writes and DDL.
 * Live part (reads only). Without CLICKHOUSE_URL it uses ClickHouse's public playground
 * (https://play.clickhouse.com, user play, no password):
 *   RUN_CLICKHOUSE_LIVE=1 npx jest src/adapters/intl/clickhouse.live
 *   CLICKHOUSE_URL=... CLICKHOUSE_USER=... CLICKHOUSE_PASSWORD=... RUN_CLICKHOUSE_LIVE=1 npx jest src/adapters/intl/clickhouse.live
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: { __raw?: string }; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { secret?: boolean }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string>; healthcheckPath?: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: "$arg" values in the URL and the body.
const used = (t: Tool) => {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(t.endpointMapping.queryParams ?? {});
  walk(t.endpointMapping.bodyMapping ?? {});
  return out;
};
// ClickHouse query parameters written in the SQL: {name:Type}.
const sqlParams = (sql: string) => [...sql.matchAll(/\{(\w+):\w+\}/g)].map((m) => m[1]);
const PREFIX = 'clickhouse_';

describe('clickhouse adapter: static spec conformance', () => {
  it('signs in with Basic auth against the HTTP interface address', () => {
    expect(a.requiredEnvVars).toEqual(['CLICKHOUSE_URL', 'CLICKHOUSE_USER', 'CLICKHOUSE_PASSWORD']);
    expect(a.connector.baseUrl).toBe('{{CLICKHOUSE_URL}}');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{CLICKHOUSE_USER}}', password: '{{CLICKHOUSE_PASSWORD}}' });
    expect(a.connector.healthcheckPath).toBe('/ping');
    expect(a.envVarMeta?.CLICKHOUSE_PASSWORD.secret).toBe(true);
  });

  it('sends every statement as a POST body with readonly=1 and nothing else that changes a setting', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      expect(`${t.name}:${m.method} ${m.path}`).toBe(`${t.name}:POST /`);
      expect(m.queryParams?.readonly).toBe('1');
      // Only default_format, database and param_* go next to readonly: a readonly=1 user
      // may not change other settings (max_result_rows etc. answer Code 164).
      for (const k of Object.keys(m.queryParams ?? {})) expect(['readonly', 'default_format', 'database'].includes(k) || k.startsWith('param_')).toBe(true);
      expect(typeof m.bodyMapping?.__raw).toBe('string');
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('passes the free query through and fixes the metadata statements', () => {
    expect(tool('clickhouse_query').endpointMapping).toEqual({ method: 'POST', path: '/', queryParams: { readonly: '1', default_format: '$format', database: '$database' }, bodyMapping: { __raw: '$query' } });
    expect(tool('clickhouse_query').parameters?.properties?.format.default).toBe('JSON');
    expect(tool('clickhouse_list_databases').endpointMapping.bodyMapping?.__raw).toBe('SELECT name, engine, comment FROM system.databases ORDER BY name');
    expect(tool('clickhouse_list_tables').endpointMapping.bodyMapping?.__raw).toContain('FROM system.tables WHERE database = {database:String}');
    expect(tool('clickhouse_describe_table').endpointMapping.bodyMapping?.__raw).toContain('FROM system.columns WHERE database = {database:String} AND table = {table:String}');
    expect(tool('clickhouse_table_sizes').endpointMapping.bodyMapping?.__raw).toContain('FROM system.parts WHERE active');
    expect(tool('clickhouse_running_queries').endpointMapping.bodyMapping?.__raw).toContain('FROM system.processes');
    expect(tool('clickhouse_recent_queries').endpointMapping.bodyMapping?.__raw).toContain('toIntervalMinute({minutes:UInt32})');
  });

  it('binds every {name:Type} placeholder through param_name, never by string interpolation', () => {
    for (const t of a.tools) {
      const sql = t.endpointMapping.bodyMapping?.__raw ?? '';
      if (sql === '$query') continue;
      expect(sql).not.toMatch(/\$/);
      const bound = Object.keys(t.endpointMapping.queryParams ?? {}).filter((k) => k.startsWith('param_')).map((k) => k.slice(6)).sort();
      expect(`${t.name}:${[...new Set(sqlParams(sql))].sort().join(',')}`).toBe(`${t.name}:${bound.join(',')}`);
      // Optional placeholders need a default, or ClickHouse answers "Substitution is not set".
      for (const p of bound) {
        const required = t.parameters?.required?.includes(p) ?? false;
        expect(`${t.name}:${p}:${required || t.parameters?.properties?.[p]?.default !== undefined}`).toBe(`${t.name}:${p}:true`);
      }
    }
  });

  it('every tool is prefixed and every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      expect(t.enabled).toBeUndefined();
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_CLICKHOUSE_LIVE === '1' ? describe : describe.skip;
live('clickhouse adapter: live (read-only)', () => {
  const base = process.env.CLICKHOUSE_URL ?? 'https://play.clickhouse.com';
  const user = process.env.CLICKHOUSE_URL ? (process.env.CLICKHOUSE_USER ?? 'default') : 'play';
  const password = process.env.CLICKHOUSE_URL ? (process.env.CLICKHOUSE_PASSWORD ?? '') : '';
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  // Runs a tool the way the engine builds it: SQL body, fixed URL settings, param_* from the arguments.
  const run = async (name: string, args: Record<string, string> = {}) => {
    const t = tool(name);
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(t.endpointMapping.queryParams ?? {})) {
      const val = typeof v === 'string' && v.startsWith('$') ? (args[v.slice(1)] ?? (t.parameters?.properties?.[v.slice(1)]?.default as string | undefined)) : v;
      if (val !== undefined) q.set(k, String(val));
    }
    const raw = t.endpointMapping.bodyMapping?.__raw ?? '';
    const res = await fetch(`${base}/?${q}`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'text/plain; charset=utf-8' }, body: raw === '$query' ? args.query : raw });
    const text = await res.text();
    expect(`${res.status} ${text.slice(0, 200)}`).toMatch(/^200 /);
    return JSON.parse(text) as { data: Array<Record<string, unknown>>; rows: number };
  };
  it('reads server info, databases, tables, columns and a query result', async () => {
    expect(Number((await run('clickhouse_server_info')).data[0].readonly)).toBeGreaterThan(0);
    const dbs = (await run('clickhouse_list_databases')).data.map((r) => r.name);
    expect(dbs).toContain('system');
    // The playground user sees no system tables, so list the tables of a user database.
    const db = String(dbs.find((n) => n !== 'system' && n !== 'INFORMATION_SCHEMA' && n !== 'information_schema'));
    const tables = (await run('clickhouse_list_tables', { database: db })).data;
    expect(tables.length).toBeGreaterThan(0);
    const columns = (await run('clickhouse_describe_table', { database: db, table: String(tables[0].name) })).data;
    expect(columns.length).toBeGreaterThan(0);
    expect(columns[0]).toHaveProperty('type');
    expect((await run('clickhouse_query', { query: 'SELECT arrayJoin([1, 2, 3]) AS n' })).rows).toBe(3);
  }, 60_000);
});
