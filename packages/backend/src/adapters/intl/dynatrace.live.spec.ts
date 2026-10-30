import * as adapter from './dynatrace.json';

/**
 * Dynatrace Environment API v2 (docs.dynatrace.com/docs/dynatrace-api/environment-api;
 * the OpenAPI document is served inside each environment's API explorer and
 * mirrored as a Postman collection in pahofmann/dynatrace-postman-collections,
 * specs/environment-v2.json): base <environment>/api/v2 where the environment
 * is https://<id>.live.dynatrace.com (SaaS) or https://<domain>/e/<id>
 * (Managed), header `Authorization: Api-Token <dt0c01 token>`, cursor paging
 * with nextPageKey (every other parameter left out on later pages),
 * selectors such as entitySelector=type("HOST").
 * Paths checked on 30 Oct 2026 against that collection and a live SaaS host
 * (an unknown route answers 404, a known one 401 without a valid token).
 * Live part (reads only: problems, entity types, metrics, events, SLOs,
 * settings schemas):
 *   DYNATRACE_ENVIRONMENT_URL=https://abc12345.live.dynatrace.com DYNATRACE_API_TOKEN=dt0c01... \
 *   RUN_DYNATRACE_LIVE=1 npx jest src/adapters/intl/dynatrace
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; maximum?: number; default?: unknown; type?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  icon: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string>; healthcheckPath?: string };
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
const PREFIX = 'dynatrace_';
const WRITES = ['dynatrace_add_problem_comment', 'dynatrace_close_problem', 'dynatrace_add_tags', 'dynatrace_ingest_event'];
const OFF = ['dynatrace_close_problem'];

describe('dynatrace adapter: static spec conformance', () => {
  it('sends the access token as Api-Token to the environment API v2', () => {
    expect(a.slug).toBe('dynatrace');
    expect(a.category).toBe('monitoring');
    expect(a.icon).toBe('dynatrace');
    expect(a.requiredEnvVars).toEqual(['DYNATRACE_ENVIRONMENT_URL', 'DYNATRACE_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('{{DYNATRACE_ENVIRONMENT_URL}}/api/v2');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'Api-Token {{DYNATRACE_API_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/problems?pageSize=1');
    expect(a.envVarMeta?.DYNATRACE_API_TOKEN.secret).toBe(true);
    const token = new RegExp(a.envVarMeta?.DYNATRACE_API_TOKEN.pattern ?? '');
    expect(token.test(`dt0c01.${'A'.repeat(24)}.${'B'.repeat(64)}`)).toBe(true);
    expect(token.test('Api-Token dt0c01.ABC.DEF')).toBe(false);
    expect(token.test('dt0s16.ABC.DEF')).toBe(false);
    const url = new RegExp(a.envVarMeta?.DYNATRACE_ENVIRONMENT_URL.pattern ?? '');
    expect(url.test('https://abc12345.live.dynatrace.com')).toBe(true);
    expect(url.test('https://dynatrace.example.com/e/1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d')).toBe(true);
    expect(url.test('https://abc12345.apps.dynatrace.com')).toBe(false);
    expect(url.test('https://abc12345.live.dynatrace.com/api/v2')).toBe(false);
    expect(url.test('https://abc12345.live.dynatrace.com/')).toBe(false);
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith('/')).toBe(true);
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith('/api')).toBe(false);
  });

  it('maps problems, entities and tags with selectors and nextPageKey paging', () => {
    expect(tool('dynatrace_list_problems').endpointMapping).toEqual({
      method: 'GET',
      path: '/problems',
      queryParams: { problemSelector: '$problem_selector', entitySelector: '$entity_selector', from: '$from', to: '$to', fields: '$fields', sort: '$sort', pageSize: '$page_size', nextPageKey: '$next_page_key' },
    });
    expect(tool('dynatrace_list_problems').parameters?.properties?.page_size.maximum).toBe(500);
    expect(tool('dynatrace_get_problem').endpointMapping).toEqual({ method: 'GET', path: '/problems/{problem_id}', queryParams: { fields: '$fields' } });
    expect(tool('dynatrace_list_problem_comments').endpointMapping.path).toBe('/problems/{problem_id}/comments');
    expect(tool('dynatrace_add_problem_comment').endpointMapping).toEqual({ method: 'POST', path: '/problems/{problem_id}/comments', bodyMapping: { message: '$message', context: '$context' } });
    expect(tool('dynatrace_close_problem').endpointMapping).toEqual({ method: 'POST', path: '/problems/{problem_id}/close', bodyMapping: { message: '$message' } });
    expect(tool('dynatrace_list_entities').endpointMapping).toEqual({
      method: 'GET',
      path: '/entities',
      queryParams: { entitySelector: '$entity_selector', from: '$from', to: '$to', fields: '$fields', sort: '$sort', pageSize: '$page_size', nextPageKey: '$next_page_key' },
    });
    expect(tool('dynatrace_get_entity').endpointMapping.path).toBe('/entities/{entity_id}');
    expect(tool('dynatrace_list_entity_types').endpointMapping.path).toBe('/entityTypes');
    expect(tool('dynatrace_get_entity_type').endpointMapping.path).toBe('/entityTypes/{type}');
    expect(tool('dynatrace_list_tags').endpointMapping).toEqual({ method: 'GET', path: '/tags', queryParams: { entitySelector: '$entity_selector', from: '$from', to: '$to' } });
    expect(tool('dynatrace_add_tags').endpointMapping).toEqual({ method: 'POST', path: '/tags', queryParams: { entitySelector: '$entity_selector', from: '$from', to: '$to' }, bodyMapping: { tags: '$tags' } });
    expect(tool('dynatrace_add_tags').parameters?.required).toEqual(['entity_selector', 'tags']);
  });

  it('maps metrics, logs, events, security problems, SLOs, settings and the audit log', () => {
    expect(tool('dynatrace_list_metrics').endpointMapping.queryParams).toMatchObject({ text: '$text', metricSelector: '$metric_selector', writtenSince: '$written_since' });
    expect(tool('dynatrace_get_metric').endpointMapping.path).toBe('/metrics/{metric_key}');
    expect(tool('dynatrace_query_metrics').endpointMapping).toEqual({
      method: 'GET',
      path: '/metrics/query',
      queryParams: { metricSelector: '$metric_selector', from: '$from', to: '$to', resolution: '$resolution', entitySelector: '$entity_selector', mzSelector: '$mz_selector' },
    });
    expect(tool('dynatrace_query_metrics').parameters?.required).toEqual(['metric_selector']);
    expect(tool('dynatrace_search_logs').endpointMapping).toEqual({ method: 'GET', path: '/logs/search', queryParams: { query: '$query', from: '$from', to: '$to', limit: '$limit', sort: '$sort', nextSliceKey: '$next_slice_key' } });
    expect(tool('dynatrace_search_logs').parameters?.properties?.limit.maximum).toBe(1000);
    expect(tool('dynatrace_aggregate_logs').endpointMapping.queryParams).toMatchObject({ groupBy: '$group_by', timeBuckets: '$time_buckets', maxGroupValues: '$max_group_values' });
    expect(tool('dynatrace_aggregate_logs').parameters?.properties?.group_by.type).toBe('array');
    expect(tool('dynatrace_list_events').endpointMapping.queryParams).toMatchObject({ eventSelector: '$event_selector', entitySelector: '$entity_selector' });
    expect(tool('dynatrace_get_event').endpointMapping.path).toBe('/events/{event_id}');
    expect(tool('dynatrace_list_event_types').endpointMapping.path).toBe('/eventTypes');
    expect(tool('dynatrace_ingest_event').endpointMapping).toEqual({
      method: 'POST',
      path: '/events/ingest',
      bodyMapping: { eventType: '$event_type', title: '$title', entitySelector: '$entity_selector', startTime: '$start_time', endTime: '$end_time', timeout: '$timeout', properties: '$properties' },
    });
    expect(tool('dynatrace_ingest_event').parameters?.properties?.event_type.enum).toContain('CUSTOM_DEPLOYMENT');
    expect(tool('dynatrace_ingest_event').parameters?.properties?.event_type.enum).toContain('RESOURCE_CONTENTION_EVENT');
    expect(tool('dynatrace_list_security_problems').endpointMapping.queryParams).toMatchObject({ securityProblemSelector: '$security_problem_selector' });
    expect(tool('dynatrace_get_security_problem').endpointMapping.path).toBe('/securityProblems/{security_problem_id}');
    expect(tool('dynatrace_list_slos').endpointMapping.queryParams).toMatchObject({ sloSelector: '$slo_selector', evaluate: '$evaluate', timeFrame: '$time_frame', enabledSlos: '$enabled_slos' });
    expect(tool('dynatrace_get_slo').endpointMapping.path).toBe('/slo/{slo_id}');
    expect(tool('dynatrace_list_settings_schemas').endpointMapping).toEqual({ method: 'GET', path: '/settings/schemas' });
    expect(tool('dynatrace_get_settings_schema').endpointMapping).toEqual({ method: 'GET', path: '/settings/schemas/{schema_id}', queryParams: { schemaVersion: '$schema_version' } });
    expect(tool('dynatrace_list_settings_objects').endpointMapping.queryParams).toMatchObject({ schemaIds: '$schema_ids', scopes: '$scopes', filter: '$filter' });
    expect(tool('dynatrace_get_settings_object').endpointMapping.path).toBe('/settings/objects/{object_id}');
    expect(tool('dynatrace_list_audit_logs').endpointMapping.path).toBe('/auditlogs');
    // Settings stay read-only: no write reaches /settings.
    for (const t of a.tools.filter((x) => x.endpointMapping.path.startsWith('/settings'))) expect(t.endpointMapping.method).toBe('GET');
  });

  it('flags every write and switches off closing a problem', () => {
    for (const t of a.tools) {
      const write = t.endpointMapping.method !== 'GET';
      expect(`${t.name}:${write}`).toBe(`${t.name}:${WRITES.includes(t.name)}`);
      expect(`${t.name}:${t.annotations?.readOnlyHint === false}`).toBe(`${t.name}:${write}`);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:${OFF.includes(t.name) ? false : undefined}`);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(OFF);
    expect(tool('dynatrace_close_problem').annotations?.destructiveHint).toBe(true);
    for (const n of ['dynatrace_add_problem_comment', 'dynatrace_add_tags', 'dynatrace_ingest_event']) expect(tool(n).annotations?.destructiveHint).toBe(false);
    expect(a.instructions).toContain('**Switched off at install**: `dynatrace_close_problem`; it cannot be undone, so an admin switches it on when the team needs it.');
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
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
    expect(a.probe.tool).toBe('dynatrace_list_problems');
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const env = process.env.DYNATRACE_ENVIRONMENT_URL;
const live = process.env.RUN_DYNATRACE_LIVE === '1' && env && process.env.DYNATRACE_API_TOKEN ? describe : describe.skip;
live('dynatrace adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${env}/api/v2${path}`, { headers: { Authorization: `Api-Token ${process.env.DYNATRACE_API_TOKEN}`, Accept: 'application/json' } });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads problems, entity types, metrics, events, SLOs and settings schemas', async () => {
    const problems = (await get('/problems?pageSize=5&from=now-7d')).problems as Array<{ problemId: string }>;
    expect(Array.isArray(problems)).toBe(true);
    if (problems[0]) expect(await get(`/problems/${problems[0].problemId}`)).toHaveProperty('problemId', problems[0].problemId);
    expect(await get('/entityTypes?pageSize=5')).toHaveProperty('types');
    expect(await get('/entities?entitySelector=type(%22HOST%22)&pageSize=5')).toHaveProperty('entities');
    expect(await get('/metrics?text=cpu&pageSize=5')).toHaveProperty('metrics');
    expect(await get('/metrics/query?metricSelector=builtin:host.cpu.usage:avg&resolution=Inf')).toHaveProperty('result');
    expect(await get('/events?pageSize=5')).toHaveProperty('events');
    expect(await get('/slo?pageSize=5')).toHaveProperty('slo');
    expect(await get('/settings/schemas')).toHaveProperty('items');
  }, 120_000);
});
