import * as adapter from './intruder.json';

/**
 * Intruder API v1 adapter.
 *
 * Static checks always run: the bearer token, every tool's method and path
 * against Intruder's published OpenAPI document (https://api.intruder.io/v1/swagger.json,
 * paths below /v1 and always ending in a slash), the write bodies, and which
 * tools install switched off (adding and deleting targets, removing a tag,
 * cancelling a scan, snoozing an occurrence).
 * https://developers.intruder.io/docs/welcome
 *
 * Live checks run only with RUN_INTRUDER_LIVE=1. Without a token they confirm
 * that the API refuses a wrong one; with INTRUDER_ACCESS_TOKEN they read the
 * licences and one page of issues and targets. Nothing is written.
 *
 *   RUN_INTRUDER_LIVE=1 INTRUDER_ACCESS_TOKEN=... npx jest src/adapters/intl/intruder.live.spec.ts
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

const PREFIX = 'intruder_';
// Method and path of every tool, as the vendor documents them.
const ROUTES: Record<string, [string, string]> = {
  intruder_check_health: ['GET', '/health/'],
  intruder_list_issues: ['GET', '/issues/'],
  intruder_list_issue_occurrences: ['GET', '/issues/{issue_id}/occurrences/'],
  intruder_list_issue_targets: ['GET', '/issues/{issue_id}/targets/'],
  intruder_get_occurrence_scanner_output: ['GET', '/issues/{issue_id}/occurrences/{occurrence_id}/scanner_output/'],
  intruder_list_occurrence_comments: ['GET', '/issues/{issue_id}/occurrences/{occurrence_id}/comments/'],
  intruder_add_occurrence_comment: ['POST', '/issues/{issue_id}/occurrences/{occurrence_id}/comments/'],
  intruder_snooze_occurrence: ['POST', '/issues/{issue_id}/occurrences/{occurrence_id}/snooze/'],
  intruder_list_fixed_occurrences: ['GET', '/occurrences/fixed/'],
  intruder_list_targets: ['GET', '/targets/'],
  intruder_create_target: ['POST', '/targets/'],
  intruder_delete_target: ['DELETE', '/targets/{target_id}/'],
  intruder_list_tags: ['GET', '/tags/'],
  intruder_add_target_tag: ['POST', '/targets/{target_id}/tags/'],
  intruder_remove_target_tag: ['DELETE', '/targets/{target_id}/tags/{name}/'],
  intruder_list_scans: ['GET', '/scans/'],
  intruder_get_scan: ['GET', '/scans/{scan_id}/'],
  intruder_start_scan: ['POST', '/scans/'],
  intruder_cancel_scan: ['POST', '/scans/{scan_id}/cancel/'],
  intruder_list_scan_schedules: ['GET', '/scans/schedules/'],
  intruder_list_licenses: ['GET', '/licenses/'],
  intruder_list_network_services: ['GET', '/attack-surface/services/'],
  intruder_list_ai_pentests: ['GET', '/ai-pentests/'],
  intruder_get_ai_pentest: ['GET', '/ai-pentests/{ai_pentest_id}/'],
  intruder_list_ai_pentest_findings: ['GET', '/ai-pentests/{ai_pentest_id}/findings/'],
};
const REQUIRED: Record<string, string[]> = {
  intruder_list_issue_occurrences: ['issue_id'],
  intruder_list_issue_targets: ['issue_id'],
  intruder_get_occurrence_scanner_output: ['issue_id', 'occurrence_id'],
  intruder_list_occurrence_comments: ['issue_id', 'occurrence_id'],
  intruder_add_occurrence_comment: ['issue_id', 'occurrence_id', 'content'],
  intruder_snooze_occurrence: ['issue_id', 'occurrence_id', 'reason', 'duration_type'],
  intruder_create_target: ['address'],
  intruder_delete_target: ['target_id'],
  intruder_add_target_tag: ['target_id', 'name'],
  intruder_remove_target_tag: ['target_id', 'name'],
  intruder_get_scan: ['scan_id'],
  intruder_cancel_scan: ['scan_id'],
  intruder_get_ai_pentest: ['ai_pentest_id'],
  intruder_list_ai_pentest_findings: ['ai_pentest_id'],
};
// Installed switched off: an administrator turns them on per connector.
const SWITCHED_OFF: string[] = ['intruder_snooze_occurrence', 'intruder_create_target', 'intruder_delete_target', 'intruder_remove_target_tag', 'intruder_cancel_scan'];
// Writes that are on at install.
const WRITES: string[] = ['intruder_add_occurrence_comment', 'intruder_add_target_tag', 'intruder_start_scan'];
// POST requests that only read (searches and log queries).
const READ_POSTS: string[] = [];

describe('intruder adapter: static contract', () => {
  it('declares the catalog envelope, the base URL and the authentication', () => {
    expect(a.slug).toBe('intruder');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('monitoring');
    expect(a.icon).toBe('intruder');
    expect(a.requiredEnvVars).toEqual(['INTRUDER_ACCESS_TOKEN']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://api.intruder.io/v1');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{INTRUDER_ACCESS_TOKEN}}' });
    for (const name of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) {
      expect(`${name}:${Boolean(a.envVarMeta[name]?.help)}`).toBe(`${name}:true`);
      expect(`${name}:${a.envVarMeta[name]?.secret === true}`).toBe(`${name}:${(['INTRUDER_ACCESS_TOKEN'] as string[]).includes(name)}`);
    }
    // An optional variable in a connector header would be sent as the literal placeholder.
    for (const name of a.optionalEnvVars ?? []) expect(JSON.stringify(a.connector.headers ?? {})).not.toContain(name);
  });

  it('checks the credentials with a cheap read and explains the usual refusals', () => {
    expect(a.probe).toEqual({ tool: 'intruder_list_licenses', params: { limit: 1 } });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const key of ['401', '403', '404', 'rate_limited']) expect(`${key}:${Boolean(a.verifyHints[key])}`).toBe(`${key}:true`);
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


  it('ends every path with a slash and pages lists with limit and offset', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.path.endsWith('/')}`).toBe(`${t.name}:true`);
      const props = t.parameters?.properties ?? {};
      if ('limit' in props) expect(t.endpointMapping.queryParams).toMatchObject({ limit: '$limit', offset: '$offset' });
    }
    // The health call answers 200 with any token, so it cannot be the setup check.
    expect(a.probe.tool).not.toBe('intruder_check_health');
  });

  it('builds the write bodies as Intruder documents them', () => {
    expect(tool('intruder_start_scan').endpointMapping.bodyMapping).toEqual({
      target_addresses: '$target_addresses',
      tag_names: '$tag_names',
      name: '$name',
      throttled: '$throttled',
      web_ports_only: '$web_ports_only',
    });
    expect(tool('intruder_add_occurrence_comment').endpointMapping.bodyMapping).toEqual({ content: '$content' });
    expect(tool('intruder_add_target_tag').endpointMapping.bodyMapping).toEqual({ name: '$name' });
    expect(tool('intruder_create_target').endpointMapping.bodyMapping).toEqual({ address: '$address', tags: '$tags' });
    expect(tool('intruder_snooze_occurrence').endpointMapping.bodyMapping).toEqual({ reason: '$reason', details: '$details', duration_type: '$duration_type', duration: '$duration' });
    // No tool handles target credentials, API schemas, bulk imports, schedules or paid release tests.
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/authentications|api_schemas|bulk|release-tests/);
    expect(a.tools.filter((t) => t.endpointMapping.path.startsWith('/scans/schedules')).map((t) => t.endpointMapping.method)).toEqual(['GET']);
  });

  it('accepts a bare token and refuses one pasted with Bearer', () => {
    const token = new RegExp(a.envVarMeta.INTRUDER_ACCESS_TOKEN.pattern ?? '');
    expect(token.test('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0')).toBe(true);
    for (const bad of ['', 'Bearer a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', 'has space a1b2c3d4e5f6a7b8', 'short']) expect(`${bad}:${token.test(bad)}`).toBe(`${bad}:false`);
  });
});

const env = process.env;
const base = 'https://api.intruder.io/v1';
(env.RUN_INTRUDER_LIVE === '1' ? describe : describe.skip)('intruder adapter: live (read-only)', () => {
  it('refuses a wrong token on a protected call', async () => {
    const res = await fetch(`${base}/licenses/`, { headers: { Accept: 'application/json', Authorization: 'Bearer not-a-real-token-0123456789' } });
    expect(res.status).toBe(401);
  }, 30_000);

  it('reads licences, issues and targets', async () => {
    if (!env.INTRUDER_ACCESS_TOKEN) throw new Error('Set INTRUDER_ACCESS_TOKEN for the live check');
    const headers = { Accept: 'application/json', Authorization: `Bearer ${env.INTRUDER_ACCESS_TOKEN}` };
    for (const path of ['/licenses/?limit=1', '/issues/?limit=2', '/targets/?limit=2']) {
      const res = await fetch(`${base}${path}`, { headers });
      expect(`${path}:${res.status}`).toBe(`${path}:200`);
      const body = (await res.json()) as { count: number; results: unknown[] };
      expect(Array.isArray(body.results)).toBe(true);
    }
  }, 60_000);
});
