import * as adapter from './trybe.json';

/**
 * Trybe Brand API v1 (OpenAPI 3.1 at https://api.jointrybe.com/v1/openapi.json; base URL
 * https://api.jointrybe.com/v1; brand API key sent as Authorization: Bearer tk_live_...).
 * Reads creators, creator performance and submissions; the three review actions install switched off.
 * Live part: TRYBE_API_KEY=tk_live_... RUN_TRYBE_LIVE=1 npx jest src/adapters/intl/trybe
 * (reads only: creators, creator performance, submissions).
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
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
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
const PREFIX = 'trybe_';
const WRITES: string[] = ['trybe_approve_submission', 'trybe_reject_submission', 'trybe_request_submission_revision'];

describe('trybe adapter: static spec conformance', () => {
  it('sends the brand key as Bearer to the documented base URL', () => {
    expect(a.requiredEnvVars).toEqual(['TRYBE_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.jointrybe.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{TRYBE_API_KEY}}' });
    expect(a.envVarMeta?.TRYBE_API_KEY.secret).toBe(true);
    expect(new RegExp(a.envVarMeta?.TRYBE_API_KEY.pattern as string).test('tk_live_abc123')).toBe(true);
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith('/v1/')).toBe(true);
  });

  it('maps the documented routes', () => {
    expect(tool('trybe_list_creators').endpointMapping).toMatchObject({ method: 'GET', path: '/v1/creators', queryParams: { limit: '$limit', after: '$after', before: '$before', sample_obligation: '$sample_obligation' } });
    expect(tool('trybe_get_creator').endpointMapping).toMatchObject({ method: 'GET', path: '/v1/creators/{creator_id}' });
    expect(tool('trybe_get_creator_performance').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/v1/creator-performance',
      queryParams: { start_date: '$start_date', end_date: '$end_date', creator_id: '$creator_id', sort_by: '$sort_by', program_id: '$program_id', managed_by: '$managed_by', active_only: '$active_only', platforms: '$platforms', limit: '$limit', after: '$after', before: '$before' },
    });
    expect(tool('trybe_list_submissions').endpointMapping).toMatchObject({ method: 'GET', path: '/v1/submissions', queryParams: { status: '$status', creator_id: '$creator_id', query: '$query', transcript_language: '$transcript_language' } });
    expect(tool('trybe_get_submission').endpointMapping).toMatchObject({ method: 'GET', path: '/v1/submissions/{submission_id}', queryParams: { platforms: '$platforms' } });
    expect(tool('trybe_approve_submission').endpointMapping).toMatchObject({ method: 'POST', path: '/v1/submissions/{submission_id}/approve', bodyMapping: { comment: '$comment' } });
    expect(tool('trybe_reject_submission').endpointMapping).toMatchObject({ method: 'POST', path: '/v1/submissions/{submission_id}/reject', bodyMapping: { comment: '$comment' } });
    expect(tool('trybe_request_submission_revision').endpointMapping).toMatchObject({ method: 'POST', path: '/v1/submissions/{submission_id}/request-revision', bodyMapping: { comment: '$comment' } });
    expect(tool('trybe_request_submission_revision').parameters?.required).toEqual(['submission_id', 'comment']);
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

  it('writes are annotated and installed switched off; reads are GET or marked read-only', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...WRITES].sort());
    for (const t of a.tools) {
      if (t.annotations?.readOnlyHint === false) continue;
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      if (t.endpointMapping.method !== 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
    }
    for (const n of WRITES) expect(tool(n).annotations?.readOnlyHint).toBe(false);
    for (const t of a.tools) expect(t.endpointMapping.method).not.toBe('DELETE');
  });

  it('probes with a parameter-free read tool and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});


const live = process.env.RUN_TRYBE_LIVE === '1' && process.env.TRYBE_API_KEY ? describe : describe.skip;
live('trybe adapter: live (read-only)', () => {
  const headers = { Authorization: `Bearer ${process.env.TRYBE_API_KEY ?? ''}`, Accept: 'application/json' };
  const base = `${a.connector.baseUrl}/v1`;
  it('reads creators, creator performance and submissions', async () => {
    const creators = (await (await fetch(`${base}/creators?limit=1`, { headers })).json()) as { object: string; data: unknown[] };
    expect(creators.object).toBe('list');
    expect(Array.isArray(creators.data)).toBe(true);
    const perf = (await (await fetch(`${base}/creator-performance?limit=1`, { headers })).json()) as { object: string; data: unknown[] };
    expect(perf.object).toBe('list');
    const subs = (await (await fetch(`${base}/submissions?limit=1`, { headers })).json()) as { object: string; data: unknown[] };
    expect(Array.isArray(subs.data)).toBe(true);
  }, 60_000);
});
