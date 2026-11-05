import * as adapter from './yandex-metrica.json';

/**
 * Yandex Metrica API (yandex.com/dev/metrika/en/): host https://api-metrika.yandex.net,
 * OAuth token sent as "Authorization: OAuth <token>", Management API under /management/v1,
 * Reporting API under /stat/v1/data, Logs API under /management/v1/counter/{counterId}/logrequest(s).
 * Live part: YANDEX_METRICA_TOKEN=y0_... RUN_YANDEX_METRICA_LIVE=1 npx jest src/adapters/intl/yandex-metrica
 * (reads the counters, the goals of the first one and a 7-day visits report).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean }>;
  probe?: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { type: string; baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
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
const PREFIX = 'yandex_metrica_';
const WRITES = ['yandex_metrica_create_log_request', 'yandex_metrica_cancel_log_request', 'yandex_metrica_clean_log_request'];
const SWITCHED_OFF = ['yandex_metrica_clean_log_request'];

describe('yandex-metrica adapter: static spec conformance', () => {
  it('sends the token as "Authorization: OAuth" to api-metrika.yandex.net', () => {
    expect(a.requiredEnvVars).toEqual(['YANDEX_METRICA_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://api-metrika.yandex.net');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'OAuth {{YANDEX_METRICA_TOKEN}}' });
    expect(a.envVarMeta?.YANDEX_METRICA_TOKEN.secret).toBe(true);
    const re = new RegExp(a.envVarMeta?.YANDEX_METRICA_TOKEN.pattern ?? '');
    expect(re.test('y0_AgAAAABkZXZlbG9wZXJfdG9rZW5fZXhhbXBsZQ')).toBe(true);
    expect(re.test('OAuth y0_AgAAAABkZXZlbG9wZXJfdG9rZW5fZXhhbXBsZQ')).toBe(false);
    expect(a.probe?.tool).toBe('yandex_metrica_list_counters');
  });

  it('maps the Management API routes', () => {
    expect(tool('yandex_metrica_list_counters').endpointMapping).toMatchObject({ method: 'GET', path: '/management/v1/counters', queryParams: { search_string: '$search_string', per_page: '$per_page', offset: '$offset' } });
    expect(tool('yandex_metrica_get_counter').endpointMapping.path).toBe('/management/v1/counter/{counterId}');
    expect(tool('yandex_metrica_list_goals').endpointMapping).toMatchObject({ path: '/management/v1/counter/{counterId}/goals', queryParams: { useDeleted: '$useDeleted' } });
    expect(tool('yandex_metrica_get_goal').endpointMapping.path).toBe('/management/v1/counter/{counterId}/goal/{goalId}');
    expect(tool('yandex_metrica_list_filters').endpointMapping.path).toBe('/management/v1/counter/{counterId}/filters');
    expect(tool('yandex_metrica_list_operations').endpointMapping.path).toBe('/management/v1/counter/{counterId}/operations');
    expect(tool('yandex_metrica_list_segments').endpointMapping.path).toBe('/management/v1/counter/{counterId}/apisegment/segments');
    expect(tool('yandex_metrica_list_grants').endpointMapping.path).toBe('/management/v1/counter/{counterId}/grants');
    expect(tool('yandex_metrica_list_labels').endpointMapping.path).toBe('/management/v1/labels');
  });

  it('maps the Reporting API routes with ids, metrics, dimensions, dates and filters', () => {
    const paths: Record<string, string> = {
      yandex_metrica_get_report: '/stat/v1/data',
      yandex_metrica_get_report_by_time: '/stat/v1/data/bytime',
      yandex_metrica_get_drilldown: '/stat/v1/data/drilldown',
      yandex_metrica_compare_segments: '/stat/v1/data/comparison',
    };
    for (const [n, p] of Object.entries(paths)) {
      expect(tool(n).endpointMapping).toMatchObject({ method: 'GET', path: p, queryParams: { ids: '$ids', metrics: '$metrics', dimensions: '$dimensions', preset: '$preset' } });
      expect(tool(n).parameters?.required).toEqual(['ids']);
    }
    expect(tool('yandex_metrica_get_report').endpointMapping.queryParams).toMatchObject({ date1: '$date1', date2: '$date2', filters: '$filters', sort: '$sort', limit: '$limit', offset: '$offset' });
    expect(tool('yandex_metrica_get_report_by_time').endpointMapping.queryParams).toMatchObject({ group: '$group', top_keys: '$top_keys' });
    expect(tool('yandex_metrica_get_drilldown').endpointMapping.queryParams).toMatchObject({ parent_id: '$parent_id' });
    expect(tool('yandex_metrica_compare_segments').endpointMapping.queryParams).toMatchObject({ date1_a: '$date1_a', date2_b: '$date2_b', filters_a: '$filters_a', filters_b: '$filters_b' });
    expect(tool('yandex_metrica_compare_segments').endpointMapping.queryParams?.date1).toBeUndefined();
  });

  it('maps the Logs API routes', () => {
    const base = '/management/v1/counter/{counterId}';
    expect(tool('yandex_metrica_evaluate_log_request').endpointMapping).toEqual({ method: 'GET', path: `${base}/logrequests/evaluate`, queryParams: { date1: '$date1', date2: '$date2', fields: '$fields', source: '$source' } });
    expect(tool('yandex_metrica_create_log_request').endpointMapping).toEqual({ method: 'POST', path: `${base}/logrequests`, queryParams: { date1: '$date1', date2: '$date2', fields: '$fields', source: '$source', attribution: '$attribution' } });
    expect(tool('yandex_metrica_list_log_requests').endpointMapping.path).toBe(`${base}/logrequests`);
    expect(tool('yandex_metrica_get_log_request').endpointMapping.path).toBe(`${base}/logrequest/{requestId}`);
    expect(tool('yandex_metrica_download_log_part').endpointMapping.path).toBe(`${base}/logrequest/{requestId}/part/{partNumber}/download`);
    expect(tool('yandex_metrica_cancel_log_request').endpointMapping).toMatchObject({ method: 'POST', path: `${base}/logrequest/{requestId}/cancel` });
    expect(tool('yandex_metrica_clean_log_request').endpointMapping).toMatchObject({ method: 'POST', path: `${base}/logrequest/{requestId}/clean` });
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

  it('writes are annotated, clean is installed switched off; everything else is a read-only GET', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...SWITCHED_OFF].sort());
    for (const n of WRITES) expect(`${n}:${tool(n).annotations?.readOnlyHint}`).toBe(`${n}:false`);
    for (const t of a.tools) {
      if (WRITES.includes(t.name)) continue;
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.enabled).toBeUndefined();
    }
  });

  it('documents every tool in the instructions and has no em dash', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const env = process.env;
const live = env.RUN_YANDEX_METRICA_LIVE === '1' && env.YANDEX_METRICA_TOKEN ? describe : describe.skip;
live('yandex-metrica adapter: live (read-only)', () => {
  const headers = { Accept: 'application/json', Authorization: `OAuth ${env.YANDEX_METRICA_TOKEN}` };
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return res.json() as Promise<Record<string, unknown>>;
  };
  it('reads counters, goals and a visits report', async () => {
    const list = (await get('/management/v1/counters?per_page=5')) as { counters: { id: number }[] };
    expect(Array.isArray(list.counters)).toBe(true);
    if (!list.counters.length) return;
    const id = list.counters[0].id;
    expect(Array.isArray((await get(`/management/v1/counter/${id}/goals`)).goals)).toBe(true);
    const report = await get(`/stat/v1/data?ids=${id}&metrics=ym:s:visits&dimensions=ym:s:lastTrafficSource&date1=7daysAgo&date2=yesterday`);
    expect(Array.isArray(report.data)).toBe(true);
  }, 60_000);
});
