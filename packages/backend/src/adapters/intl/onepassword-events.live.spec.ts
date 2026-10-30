import * as adapter from './onepassword-events.json';

/**
 * 1Password Events API (www.1password.dev/events-api/reference, OpenAPI at
 * i.1password.com/media/1password-events-reporting/1password-events-api_1.4.1.yaml):
 * regional hosts events.1password.com / .ent.1password.com / .ca / .eu, Bearer token
 * of an Events Reporting integration, v2 endpoints. The list endpoints are POST reads
 * with a cursor or a reset cursor (limit, start_time, end_time) in the JSON body.
 * Live part (reads only: introspect and one page of sign-in attempts):
 *   ONEPASSWORD_EVENTS_URL=https://events.1password.com ONEPASSWORD_EVENTS_TOKEN=... \
 *   RUN_ONEPASSWORD_EVENTS_LIVE=1 npx jest src/adapters/intl/onepassword-events
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
  icon: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; healthcheckPath?: string };
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
const PREFIX = 'onepassword_events_';
const LISTS = ['onepassword_events_list_signin_attempts', 'onepassword_events_list_item_usages', 'onepassword_events_list_audit_events'];

describe('onepassword-events adapter: static spec conformance', () => {
  it('starts the slug with a letter, so the generated catalog import is a valid identifier', () => {
    expect(a.slug).toBe('onepassword-events');
    expect(a.icon).toBe('1password');
  });

  it('authenticates with the bearer token against the regional events host', () => {
    expect(a.requiredEnvVars).toEqual(['ONEPASSWORD_EVENTS_URL', 'ONEPASSWORD_EVENTS_TOKEN']);
    expect(a.connector.baseUrl).toBe('{{ONEPASSWORD_EVENTS_URL}}');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{ONEPASSWORD_EVENTS_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/api/v2/auth/introspect');
    expect(a.envVarMeta.ONEPASSWORD_EVENTS_TOKEN.secret).toBe(true);
    const host = new RegExp(a.envVarMeta.ONEPASSWORD_EVENTS_URL.pattern as string);
    for (const ok of ['https://events.1password.com', 'https://events.ent.1password.com', 'https://events.1password.ca', 'https://events.1password.eu']) expect(host.test(ok)).toBe(true);
    for (const bad of ['https://events.1password.com/', 'https://1password.com', 'http://events.1password.com', 'https://events.example.com']) expect(host.test(bad)).toBe(false);
    const jwt = new RegExp(a.envVarMeta.ONEPASSWORD_EVENTS_TOKEN.pattern as string);
    expect(jwt.test('eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln')).toBe(true);
    expect(jwt.test('Bearer eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln')).toBe(false);
  });

  it('maps introspect and the three v2 cursor endpoints with the documented body fields', () => {
    expect(tool('onepassword_events_introspect').endpointMapping).toEqual({ method: 'GET', path: '/api/v2/auth/introspect' });
    const body = { cursor: '$cursor', limit: '$limit', start_time: '$start_time', end_time: '$end_time' };
    expect(tool('onepassword_events_list_signin_attempts').endpointMapping).toEqual({ method: 'POST', path: '/api/v2/signinattempts', bodyMapping: body });
    expect(tool('onepassword_events_list_item_usages').endpointMapping).toEqual({ method: 'POST', path: '/api/v2/itemusages', bodyMapping: body });
    expect(tool('onepassword_events_list_audit_events').endpointMapping).toEqual({ method: 'POST', path: '/api/v2/auditevents', bodyMapping: body });
  });

  it('is read-only: the POST reads are marked readOnlyHint, nothing is switched off', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(['onepassword_events_introspect', ...LISTS].sort());
    for (const name of LISTS) expect(`${name}:${tool(name).annotations?.readOnlyHint}`).toBe(`${name}:true`);
    for (const t of a.tools) {
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      expect(['GET', 'POST']).toContain(t.endpointMapping.method);
      expect(t.annotations?.readOnlyHint === false).toBe(false);
    }
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

  it('probes with introspect and documents every tool, the paging and the absence of secret values', () => {
    expect(a.probe.tool).toBe('onepassword_events_introspect');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).toContain('has_more');
    expect(a.instructions).toContain('never return passwords');
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_ONEPASSWORD_EVENTS_LIVE === '1' && process.env.ONEPASSWORD_EVENTS_TOKEN && process.env.ONEPASSWORD_EVENTS_URL ? describe : describe.skip;
live('onepassword-events adapter: live (read-only)', () => {
  const base = process.env.ONEPASSWORD_EVENTS_URL as string;
  const headers = { Authorization: `Bearer ${process.env.ONEPASSWORD_EVENTS_TOKEN}`, Accept: 'application/json', 'Content-Type': 'application/json' };
  it('introspects the token and reads one page of each feature it has', async () => {
    const res = await fetch(`${base}/api/v2/auth/introspect`, { headers });
    expect(res.status).toBe(200);
    const intro = (await res.json()) as { features: string[]; account_uuid?: string };
    expect(Array.isArray(intro.features)).toBe(true);
    const start = new Date(Date.now() - 24 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    for (const feature of intro.features) {
      const page = await fetch(`${base}/api/v2/${feature}`, { method: 'POST', headers, body: JSON.stringify({ limit: 1, start_time: start }) });
      expect(page.status).toBe(200);
      const body = (await page.json()) as { cursor: string; has_more: boolean; items: unknown[] };
      expect(typeof body.cursor).toBe('string');
      expect(Array.isArray(body.items)).toBe(true);
    }
  }, 60_000);
});
