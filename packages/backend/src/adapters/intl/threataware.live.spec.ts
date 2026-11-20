import * as adapter from './threataware.json';

/**
 * ThreatAware public API v1 adapter (read-only: the API accepts GET only).
 *
 * Static checks always run: the per-portal base URL, the X-ThreatAware-ApiKey
 * header, every tool's method and path against the API reference, the paging
 * parameters and the variable patterns.
 * https://docs.threataware.com/api-reference/overview
 *
 * Live checks run only with RUN_THREATAWARE_LIVE=1 plus THREATAWARE_CLOUD_ID and
 * THREATAWARE_API_KEY. They read one device and the Vitals list. Nothing is
 * written (the API has no write calls).
 *
 *   RUN_THREATAWARE_LIVE=1 THREATAWARE_CLOUD_ID=... THREATAWARE_API_KEY=... \
 *     npx jest src/adapters/intl/threataware.live.spec.ts
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

const PREFIX = 'threataware_';
// Method and path of every tool, as the vendor documents them.
const ROUTES: Record<string, [string, string]> = {
  threataware_list_devices: ['GET', '/devices'],
  threataware_list_users: ['GET', '/users'],
  threataware_list_alerts: ['GET', '/alerts'],
  threataware_list_inventory: ['GET', '/inventory'],
  threataware_list_vitals: ['GET', '/vitals'],
  threataware_list_portal_users: ['GET', '/settings/usermanagement/users'],
  threataware_list_roles: ['GET', '/settings/usermanagement/roles'],
  threataware_list_teams: ['GET', '/settings/usermanagement/teams'],
};
const REQUIRED: Record<string, string[]> = {
  threataware_list_inventory: ['system_name'],
};
// Installed switched off: an administrator turns them on per connector.
const SWITCHED_OFF: string[] = [];
// Writes that are on at install.
const WRITES: string[] = [];
// POST requests that only read (searches and log queries).
const READ_POSTS: string[] = [];

describe('threataware adapter: static contract', () => {
  it('declares the catalog envelope, the base URL and the authentication', () => {
    expect(a.slug).toBe('threataware');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('monitoring');
    expect(a.icon).toBe('threataware');
    expect(a.requiredEnvVars).toEqual(['THREATAWARE_CLOUD_ID', 'THREATAWARE_API_KEY']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://{{THREATAWARE_CLOUD_ID}}.threataware.com/public-api/v1');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-ThreatAware-ApiKey', apiKey: '{{THREATAWARE_API_KEY}}' });
    for (const name of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) {
      expect(`${name}:${Boolean(a.envVarMeta[name]?.help)}`).toBe(`${name}:true`);
      expect(`${name}:${a.envVarMeta[name]?.secret === true}`).toBe(`${name}:${(['THREATAWARE_API_KEY'] as string[]).includes(name)}`);
    }
    // An optional variable in a connector header would be sent as the literal placeholder.
    for (const name of a.optionalEnvVars ?? []) expect(JSON.stringify(a.connector.headers ?? {})).not.toContain(name);
  });

  it('checks the credentials with a cheap read and explains the usual refusals', () => {
    expect(a.probe).toEqual({ tool: 'threataware_list_devices', params: { limit: 1 } });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const key of ['400', '401', '403', '404', 'rate_limited', 'unreachable']) expect(`${key}:${Boolean(a.verifyHints[key])}`).toBe(`${key}:true`);
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


  it('is read-only and always sends a limit, because the API returns everything without one', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(t.endpointMapping.queryParams).toMatchObject({ offset: '$offset', limit: '$limit' });
      const limit = (t.parameters?.properties?.limit ?? {}) as unknown as { default?: number; minimum?: number };
      expect(`${t.name}:${typeof limit.default}`).toBe(`${t.name}:number`);
      expect(limit.minimum).toBe(1);
    }
    expect(tool('threataware_list_alerts').endpointMapping.queryParams).toEqual({ filter: '$filter', systemName: '$system_name', offset: '$offset', limit: '$limit' });
    expect(tool('threataware_list_inventory').endpointMapping.queryParams).toEqual({ systemName: '$system_name', type: '$type', offset: '$offset', limit: '$limit' });
    expect(tool('threataware_list_vitals').endpointMapping.queryParams).toEqual({ tag: '$tag', archiveDate: '$archive_date', offset: '$offset', limit: '$limit' });
  });

  it('accepts a Cloud ID and a two-UUID key, and refuses a full address', () => {
    const cloud = new RegExp(a.envVarMeta.THREATAWARE_CLOUD_ID.pattern ?? '');
    for (const ok of ['acme-corp', 'acme', 'Acme2']) expect(`${ok}:${cloud.test(ok)}`).toBe(`${ok}:true`);
    for (const bad of ['https://acme-corp.threataware.com', 'acme-corp.threataware.com', 'acme corp', '']) expect(`${bad}:${cloud.test(bad)}`).toBe(`${bad}:false`);
    const key = new RegExp(a.envVarMeta.THREATAWARE_API_KEY.pattern ?? '');
    expect(key.test('55b736f9-994c-2cca-af80-83c19d3c6705-8604c319-260d-42ed-a670-c9cc8d1acabd')).toBe(true);
    for (const bad of ['', 'has space 55b736f9-994c-2cca-af80-83c19d3c6705', 'short']) expect(`${bad}:${key.test(bad)}`).toBe(`${bad}:false`);
    expect(a.connector.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'AnythingMCP' });
    // A wrong key is answered with 400, not 401.
    expect(a.verifyHints['400']).toContain('expired');
  });
});

const env = process.env;
const live = env.RUN_THREATAWARE_LIVE === '1' && env.THREATAWARE_CLOUD_ID && env.THREATAWARE_API_KEY ? describe : describe.skip;
live('threataware adapter: live (read-only)', () => {
  const base = `https://${env.THREATAWARE_CLOUD_ID}.threataware.com/public-api/v1`;
  const headers = { Accept: 'application/json', 'X-ThreatAware-ApiKey': String(env.THREATAWARE_API_KEY) };

  it('reads one device and the Vitals list', async () => {
    const devices = await fetch(`${base}/devices?limit=1`, { headers });
    expect(devices.status).toBe(200);
    const body = (await devices.json()) as { data: unknown[]; total: number; success: boolean };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    const vitals = await fetch(`${base}/vitals?limit=5`, { headers });
    expect(vitals.status).toBe(200);
  }, 60_000);

  it('refuses a request without a key', async () => {
    const res = await fetch(`${base}/devices?limit=1`, { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(401);
  }, 30_000);
});
