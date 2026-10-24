import * as adapter from './netskope.json';
import { assertNoResponseBodyError } from '../../connectors/engines/response-error.util';
/**
 * Netskope REST API v2 (docs.netskope.com: REST API v2 overview, datasearch and dataexport pages;
 * endpoint paths as used by Netskope's own MIT-licensed Python SDK, github.com/netskopeoss/netskope-py-sdk):
 * https://<tenant>.goskope.com/api/v2/..., token in the Netskope-Api-Token header with per-endpoint Read privilege.
 * Live part: NETSKOPE_TENANT=... NETSKOPE_API_TOKEN=... RUN_NETSKOPE_LIVE=1 npx jest src/adapters/intl/netskope
 * (reads only: a count of the last day's alerts).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe?: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { type: string; baseUrl: string; authType: string; authConfig?: Record<string, any>; headers?: Record<string, string>; config?: Record<string, any> };
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
const PREFIX = 'netskope_';
const WRITES: string[] = [];
const SWITCHED_OFF: string[] = [];

describe('netskope adapter: static spec conformance', () => {

  it('sends the token in Netskope-Api-Token to the tenant host', () => {
    expect(a.requiredEnvVars).toEqual(['NETSKOPE_TENANT', 'NETSKOPE_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://{{NETSKOPE_TENANT}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Netskope-Api-Token', apiKey: '{{NETSKOPE_API_TOKEN}}' });
    expect(a.envVarMeta?.NETSKOPE_API_TOKEN.secret).toBe(true);
    const host = new RegExp(a.envVarMeta?.NETSKOPE_TENANT.pattern ?? '');
    expect(host.test('example.goskope.com')).toBe(true);
    expect(host.test('example.eu.goskope.com')).toBe(true);
    expect(host.test('https://example.goskope.com')).toBe(false);
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith('/api/v2/')).toBe(true);
    expect(a.probe).toEqual({ tool: 'netskope_search_alerts', params: { limit: 1 } });
  });

  it('maps the datasearch endpoints with the documented query parameters', () => {
    const q = { query: '$query', fields: '$fields', starttime: '$starttime', endtime: '$endtime', limit: '$limit', offset: '$offset', groupbys: '$groupbys', orderbys: '$orderbys' };
    expect(tool('netskope_search_alerts').endpointMapping).toEqual({ method: 'GET', path: '/api/v2/events/datasearch/alert', queryParams: q });
    expect(tool('netskope_search_events').endpointMapping).toEqual({ method: 'GET', path: '/api/v2/events/datasearch/{event_type}', queryParams: q });
    expect((tool('netskope_search_events').parameters?.properties?.event_type as { enum: string[] }).enum).toEqual(['application', 'page', 'network', 'incident', 'clientstatus', 'epdlp']);
    expect(tool('netskope_list_audit_events').endpointMapping).toMatchObject({ path: '/api/v2/events/data/audit', queryParams: { type: '$type', starttime: '$starttime' } });
  });

  it('maps users, apps, URL lists and Private Access reads', () => {
    expect(tool('netskope_get_user_risk_score').endpointMapping).toEqual({ method: 'POST', path: '/api/v2/ubadatasvc/user/uci', bodyMapping: { user: '$user', fromTime: '$from_time' } });
    expect(tool('netskope_get_user_risk_score').annotations?.readOnlyHint).toBe(true);
    expect(tool('netskope_lookup_cloud_app').endpointMapping).toMatchObject({ path: '/api/v2/services/cci/app', queryParams: { apps: '$app_name', ccl: '$ccl' } });
    expect(tool('netskope_list_url_lists').endpointMapping.path).toBe('/api/v2/policy/urllist');
    expect(tool('netskope_get_url_list').endpointMapping.path).toBe('/api/v2/policy/urllist/{list_id}');
    expect(tool('netskope_list_publishers').endpointMapping.path).toBe('/api/v2/infrastructure/publishers');
    expect(tool('netskope_list_private_apps').endpointMapping.path).toBe('/api/v2/steering/apps/private');
    expect(tool('netskope_list_scim_users').endpointMapping).toEqual({ method: 'GET', path: '/api/v2/scim/Users', queryParams: { filter: '$filter', startIndex: '$startIndex', count: '$count' } });
    expect(tool('netskope_list_scim_groups').endpointMapping.path).toBe('/api/v2/scim/Groups');
  });

  it('is read-only: no dataexport iterators (they move a shared cursor) and no writes', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.path).not.toMatch(/dataexport/);
      expect(['GET', 'POST']).toContain(t.endpointMapping.method);
      if (t.endpointMapping.method === 'POST') expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('turns a FAILED datasearch execution into a failed call', () => {
    const rules = (a.connector.config as { errorWhen: unknown }).errorWhen;
    expect(() => assertNoResponseBodyError({ result: [], status: { execution: 'FAILED', message: 'invalid field foo', status_code: 400 } }, rules)).toThrow(/invalid field foo/);
    expect(() => assertNoResponseBodyError({ result: [{ count_total: 3 }], status: { execution: 'SUCCESS', count: 1 } }, rules)).not.toThrow();
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      if (t.endpointMapping.method === 'static') continue;
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('writes are annotated, the risky ones installed switched off; reads are GET or marked read-only', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...SWITCHED_OFF].sort());
    for (const n of WRITES) expect(`${n}:${tool(n).annotations?.readOnlyHint}`).toBe(`${n}:false`);
    for (const t of a.tools) {
      if (WRITES.includes(t.name)) continue;
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      if (!['GET', 'static'].includes(t.endpointMapping.method) && !t.endpointMapping.method.startsWith('odata_')) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
    }
  });

  it('documents every tool in the instructions, marks secrets and has no em dash', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    for (const [name, meta] of Object.entries(a.envVarMeta ?? {})) if (/PASSWORD|SECRET|TOKEN/.test(name) || name.endsWith('_KEY')) expect(`${name}:${meta.secret}`).toBe(`${name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
    if (a.probe) {
      const probe = tool(a.probe.tool);
      expect(probe.annotations?.readOnlyHint === false).toBe(false);
      expect(probe.parameters?.required ?? []).toEqual([]);
    }
  });
});

const live = process.env.RUN_NETSKOPE_LIVE === '1' && process.env.NETSKOPE_TENANT && process.env.NETSKOPE_API_TOKEN ? describe : describe.skip;
live('netskope adapter: live (read-only)', () => {
  it('counts the alerts of the last day', async () => {
    const end = Math.floor(Date.now() / 1000);
    const url = `https://${process.env.NETSKOPE_TENANT}/api/v2/events/datasearch/alert?starttime=${end - 86_400}&endtime=${end}&fields=count_total:count(_id)`;
    const body = (await (await fetch(url, { headers: { 'Netskope-Api-Token': process.env.NETSKOPE_API_TOKEN as string } })).json()) as { status: { execution: string }; result: unknown[] };
    expect(body.status.execution).toBe('SUCCESS');
    expect(Array.isArray(body.result)).toBe(true);
  }, 60_000);
});
