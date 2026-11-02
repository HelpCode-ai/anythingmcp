import * as adapter from './football-charts.json';

/**
 * Football Charts Developer API v1 (https://www.football-charts.com/developers).
 * Keyless calls work at 100 requests/day per IP; an optional free key (fc_...) goes in X-API-Key.
 * Live part: RUN_FOOTBALL_CHARTS_LIVE=1 [FOOTBALL_CHARTS_API_KEY=...] npx jest src/adapters/intl/football-charts
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: {
    properties?: Record<string, { default?: unknown; enum?: unknown[]; maximum?: number; minimum?: number; type?: string }>;
    required?: string[];
  };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, unknown>;
  };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};

const a = adapter as unknown as {
  slug: string;
  name: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string; link?: string }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};

const KEY = 'FOOTBALL_CHARTS_API_KEY';
const PREFIX = 'football_charts_';

const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) if (p !== KEY) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};

describe('football-charts adapter: static spec conformance', () => {
  it('calls the v1 REST API without required credentials and sends the optional key in X-API-Key', () => {
    expect(a.slug).toBe('football-charts');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('sports');
    expect(a.icon).toBe('football-charts');
    expect(a.docsUrl).toBe('https://www.football-charts.com/developers');
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.optionalEnvVars).toEqual([KEY]);
    expect(a.connector.baseUrl).toBe('https://footballcharts-backend.onrender.com/api/v1');
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.envVarMeta?.[KEY]).toMatchObject({
      kind: 'credential',
      secret: true,
      link: 'https://www.football-charts.com/developers',
    });
    const pattern = new RegExp(a.envVarMeta?.[KEY].pattern as string);
    expect(pattern.test('fc_0123456789abcdef0123456789')).toBe(true);
    expect(pattern.test('invalid key with spaces')).toBe(false);
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.headers?.['X-API-Key']}`).toBe(`${t.name}:\${${KEY}}`);
    }
  });

  it('maps the documented v1 endpoints', () => {
    const routes: Record<string, [string, string]> = {
      football_charts_list_leagues: ['GET', '/leagues/'],
      football_charts_get_league_table: ['GET', '/leagues/{league}/table/'],
      football_charts_get_results: ['GET', '/leagues/{league}/results/'],
      football_charts_get_fixtures: ['GET', '/leagues/{league}/fixtures/'],
      football_charts_get_season_projection: ['GET', '/leagues/{league}/projection/'],
      football_charts_get_goal_timing: ['GET', '/leagues/{league}/goal-timing/'],
      football_charts_list_teams: ['GET', '/leagues/{league}/teams/'],
      football_charts_get_team: ['GET', '/leagues/{league}/teams/{team}/'],
      football_charts_get_match: ['GET', '/matches/{slug}/'],
      football_charts_get_track_record: ['GET', '/track-record/'],
    };
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(routes).sort());
    for (const [name, [method, path]] of Object.entries(routes)) {
      expect(tool(name).endpointMapping).toMatchObject({ method, path });
    }
  });

  it('every tool is prefixed, read-only, and every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      expect(t.endpointMapping.method).toBe('GET');
      expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
      expect(`${t.name}:${t.annotations?.destructiveHint}`).toBe(`${t.name}:undefined`);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) {
        expect(t.parameters?.required).toContain(p);
      }
    }
  });

  it('probes with football_charts_list_leagues and documents every tool in instructions without em-dashes', () => {
    expect(a.probe.tool).toBe('football_charts_list_leagues');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) {
      expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    }
    expect(a.instructions).toContain(KEY);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_FOOTBALL_CHARTS_LIVE === '1' ? describe : describe.skip;
live('football-charts adapter: live, keyless', () => {
  it('lists 98 leagues anonymously', async () => {
    const res = await fetch(`${a.connector.baseUrl}/leagues/`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; leagues: Array<{ league: string }> };
    expect(body.count).toBeGreaterThanOrEqual(90);
    expect(body.leagues.some((l) => l.league === 'premier')).toBe(true);
  });
});
