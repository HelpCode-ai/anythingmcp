import * as adapter from './clay.json';

/**
 * Clay Public API (developers.clay.com, OpenAPI at developers.clay.com/openapi.json):
 * base https://api.clay.com/public/v0, clay-api-key header, async routine runs polled
 * through a results endpoint, stateful search iterators (has_more), cursor paging.
 * Live part (reads only: user, credit balance, search query reference):
 *   CLAY_API_KEY=... RUN_CLAY_LIVE=1 npx jest src/adapters/intl/clay
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown> };
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
const PREFIX = 'clay_';

describe('clay adapter: static spec conformance', () => {
  it('authenticates with the clay-api-key header on the v0 public API', () => {
    expect(a.requiredEnvVars).toEqual(['CLAY_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.clay.com/public/v0');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'clay-api-key', apiKey: '{{CLAY_API_KEY}}' });
    expect(a.envVarMeta.CLAY_API_KEY.secret).toBe(true);
  });

  it('maps search, table, routine and run endpoints as in the OpenAPI file', () => {
    expect(tool('clay_get_me').endpointMapping).toEqual({ method: 'GET', path: '/me' });
    expect(tool('clay_get_credit_balance').endpointMapping).toEqual({ method: 'GET', path: '/credits/balance' });
    expect(tool('clay_get_search_query_reference').endpointMapping).toEqual({ method: 'GET', path: '/search/query-mode/reference' });
    expect(tool('clay_create_search').endpointMapping).toEqual({ method: 'POST', path: '/search/query-mode', bodyMapping: { query: '$query' } });
    expect(tool('clay_get_search_results').endpointMapping).toEqual({ method: 'POST', path: '/search/query-mode/{search_id}/run', bodyMapping: { limit: '$limit' } });
    expect(tool('clay_query_tables').endpointMapping).toEqual({ method: 'POST', path: '/tables/query', bodyMapping: { query: '$query', limit: '$limit', cursor: '$cursor' } });
    expect(tool('clay_run_routine').endpointMapping).toEqual({ method: 'POST', path: '/routines/{routine_id}/run', bodyMapping: { items: '$items', webhook_id: '$webhook_id' } });
    expect(tool('clay_get_run_results').endpointMapping).toEqual({ method: 'GET', path: '/routines/run/{routine_run_id}/results', queryParams: { limit: '$limit', cursor: '$cursor' } });
    expect(tool('clay_get_batch_run_results').endpointMapping).toEqual({ method: 'GET', path: '/routines/run-batch/{routine_run_id}/results' });
    expect(tool('clay_get_runs_query_reference').endpointMapping).toEqual({ method: 'GET', path: '/workflows/runs/query/reference' });
    expect(tool('clay_query_workflow_runs').endpointMapping).toEqual({ method: 'POST', path: '/workflows/runs/query', bodyMapping: { query: '$query', limit: '$limit', cursor: '$cursor' } });
    expect(tool('clay_privacy_delete_people').endpointMapping).toEqual({ method: 'POST', path: '/audiences/privacy-delete', bodyMapping: { person_identifiers: '$person_identifiers', dry_run: '$dry_run' } });
    expect(tool('clay_get_privacy_deletion_status').endpointMapping.path).toBe('/audiences/privacy-delete/{job_id}');
    // The deprecated filters-mode search and the presigned-upload batch start are left out.
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/filters-mode|upload-url|run-batch\/start/);
  });

  it('marks POST reads read-only, credit spending as a write, and privacy deletion destructive and off', () => {
    for (const n of ['clay_create_search', 'clay_get_search_results', 'clay_query_tables', 'clay_query_workflow_runs']) expect(`${n}:${tool(n).annotations?.readOnlyHint}`).toBe(`${n}:true`);
    expect(tool('clay_run_routine').annotations?.readOnlyHint).toBeUndefined();
    expect(tool('clay_privacy_delete_people').annotations).toEqual({ destructiveHint: true });
    expect(tool('clay_privacy_delete_people').enabled).toBe(false);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['clay_privacy_delete_people']);
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
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

const live = process.env.RUN_CLAY_LIVE === '1' && process.env.CLAY_API_KEY ? describe : describe.skip;
live('clay adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { 'clay-api-key': process.env.CLAY_API_KEY as string, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  };
  it('reads the user, the credit balance and the search query reference', async () => {
    expect(await get('/me')).toBeTruthy();
    expect(await get('/credits/balance')).toBeTruthy();
    expect(JSON.stringify(await get('/search/query-mode/reference'))).toMatch(/select/i);
  }, 60_000);
});
