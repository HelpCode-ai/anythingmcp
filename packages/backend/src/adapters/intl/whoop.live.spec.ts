import * as adapter from './whoop.json';

/**
 * WHOOP Developer API v2 (developer.whoop.com, OpenAPI at
 * api.prod.whoop.com/developer/doc/openapi.json): base
 * https://api.prod.whoop.com/developer, OAuth 2.0 authorization code with the
 * `offline` scope for refresh tokens, collections paged with limit (max 25)
 * and nextToken. Read-only.
 * Live part (reads only: profile, body measurement, the latest cycle with its
 * recovery and sleep, recoveries, sleeps and workouts), with an access token
 * from an authorization of a WHOOP app with the scopes in the instructions:
 *   WHOOP_ACCESS_TOKEN=... RUN_WHOOP_LIVE=1 npx jest src/adapters/intl/whoop
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { type?: string; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; healthcheckPath: string };
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
const PREFIX = 'whoop_';
const PAGE = { limit: '$limit', start: '$start', end: '$end', nextToken: '$next_token' };

describe('whoop adapter: static spec conformance', () => {
  it('signs in with OAuth 2.0 authorization code at WHOOP, with the read scopes and offline', () => {
    expect(a.requiredEnvVars).toEqual(['WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET']);
    expect(a.connector.baseUrl).toBe('https://api.prod.whoop.com/developer');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{WHOOP_CLIENT_ID}}',
      clientSecret: '{{WHOOP_CLIENT_SECRET}}',
      authorizationUrl: 'https://api.prod.whoop.com/oauth/oauth2/auth',
      tokenUrl: 'https://api.prod.whoop.com/oauth/oauth2/token',
      tokenAuthMethod: 'client_secret_post',
      scopes: 'read:recovery read:cycles read:workout read:sleep read:profile read:body_measurement offline',
    });
    expect(a.envVarMeta?.WHOOP_CLIENT_SECRET.secret).toBe(true);
    expect(a.connector.healthcheckPath).toBe('/v2/user/profile/basic');
  });

  it('maps the user and cycle endpoints of the v2 API', () => {
    expect(tool('whoop_get_profile').endpointMapping).toEqual({ method: 'GET', path: '/v2/user/profile/basic' });
    expect(tool('whoop_get_body_measurement').endpointMapping).toEqual({ method: 'GET', path: '/v2/user/measurement/body' });
    expect(tool('whoop_list_cycles').endpointMapping).toEqual({ method: 'GET', path: '/v2/cycle', queryParams: PAGE });
    expect(tool('whoop_get_cycle').endpointMapping).toEqual({ method: 'GET', path: '/v2/cycle/{cycle_id}' });
    expect(tool('whoop_get_cycle_sleep').endpointMapping).toEqual({ method: 'GET', path: '/v2/cycle/{cycle_id}/sleep' });
    expect(tool('whoop_get_cycle_recovery').endpointMapping).toEqual({ method: 'GET', path: '/v2/cycle/{cycle_id}/recovery' });
    expect(tool('whoop_get_cycle').parameters?.properties?.cycle_id.type).toBe('integer');
  });

  it('maps recovery, sleep and workout collections with the documented paging', () => {
    expect(tool('whoop_list_recoveries').endpointMapping).toEqual({ method: 'GET', path: '/v2/recovery', queryParams: PAGE });
    expect(tool('whoop_list_sleeps').endpointMapping).toEqual({ method: 'GET', path: '/v2/activity/sleep', queryParams: PAGE });
    expect(tool('whoop_get_sleep').endpointMapping).toEqual({ method: 'GET', path: '/v2/activity/sleep/{sleep_id}' });
    expect(tool('whoop_list_workouts').endpointMapping).toEqual({ method: 'GET', path: '/v2/activity/workout', queryParams: PAGE });
    expect(tool('whoop_get_workout').endpointMapping).toEqual({ method: 'GET', path: '/v2/activity/workout/{workout_id}' });
    for (const t of a.tools.filter((x) => x.name.startsWith('whoop_list_'))) expect(t.parameters?.properties?.limit.maximum).toBe(25);
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

  it('is read-only: every tool is a GET, none is switched off, no revoke', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(t.endpointMapping.path).toMatch(/^\/v2\//);
      expect(t.endpointMapping.path).not.toMatch(/partner|user\/access/);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      expect(t.annotations?.readOnlyHint === false).toBe(false);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_WHOOP_LIVE === '1' && process.env.WHOOP_ACCESS_TOKEN ? describe : describe.skip;
live('whoop adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${process.env.WHOOP_ACCESS_TOKEN}`, Accept: 'application/json' },
    });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads the profile, body measurement, cycles with recovery and sleep, sleeps and workouts', async () => {
    expect(typeof (await get('/v2/user/profile/basic')).user_id).toBe('number');
    expect(typeof (await get('/v2/user/measurement/body')).max_heart_rate).toBe('number');
    const cycles = (await get('/v2/cycle?limit=2')).records as Array<{ id: number }>;
    expect(Array.isArray(cycles)).toBe(true);
    if (cycles[0]) expect((await get(`/v2/cycle/${cycles[0].id}`)).id).toBe(cycles[0].id);
    expect(Array.isArray((await get('/v2/recovery?limit=1')).records)).toBe(true);
    const sleeps = (await get('/v2/activity/sleep?limit=1')).records as Array<{ id: string }>;
    if (sleeps[0]) expect((await get(`/v2/activity/sleep/${sleeps[0].id}`)).id).toBe(sleeps[0].id);
    const workouts = (await get('/v2/activity/workout?limit=1')).records as Array<{ id: string }>;
    if (workouts[0]) expect((await get(`/v2/activity/workout/${workouts[0].id}`)).id).toBe(workouts[0].id);
  }, 60_000);
});
