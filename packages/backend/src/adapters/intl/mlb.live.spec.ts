import * as adapter from './mlb.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

const a = adapter as unknown as {
  requiredEnvVars: string[];
  connector: { baseUrl: string; authType: string };
  instructions: string;
  tools: Array<{
    name: string;
    useProxy?: boolean;
    parameters: { properties: Record<string, unknown>; required?: string[] };
    endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
    responseMapping?: { transform: { mode: string; expression: string } };
  }>;
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

describe('mlb adapter: static spec conformance', () => {
  it('is keyless on statsapi.mlb.com', () => {
    expect(a.connector.baseUrl).toBe('https://statsapi.mlb.com');
    expect(a.connector.authType).toBe('NONE');
    expect(a.requiredEnvVars).toEqual([]);
  });

  it('is read-only and states MLB terms of use', () => {
    for (const t of a.tools) expect(t.endpointMapping.method).toBe('GET');
    expect(a.instructions).toContain('non-commercial');
  });

  // statsapi.mlb.com answers 406 to uncached requests from datacenter addresses.
  it('routes every tool through the instance proxy', () => {
    for (const t of a.tools) expect(`${t.name}:${t.useProxy}`).toBe(`${t.name}:true`);
  });

  it('every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = new Set<string>();
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      for (const v of Object.values(m.queryParams ?? {})) used.add(String(v).replace(/^\$/, ''));
      for (const p of Object.keys(t.parameters.properties)) expect(`${t.name}:${p}:${used.has(p)}`).toBe(`${t.name}:${p}:true`);
    }
  });

  it('uses the v1.1 live feed and full team names in standings', () => {
    expect(tool('mlb_get_game').endpointMapping.path).toBe('/api/v1.1/game/{game_pk}/feed/live');
    expect(tool('mlb_get_standings').endpointMapping.queryParams?.hydrate).toBe('team,division,league');
  });

  it('every transform compiles', () => {
    for (const t of a.tools) {
      const out = applyResponseTransform({}, t.responseMapping);
      expect(`${t.name}:${out.error ?? 'ok'}`).toBe(`${t.name}:ok`);
    }
  });

  it('keeps batters in batting order in the box score', () => {
    const side = (name: string) => ({
      team: { name },
      teamStats: { batting: { runs: 3 }, pitching: { strikeOuts: 7 } },
      players: {
        ID2: { person: { id: 2, fullName: 'Second' }, battingOrder: '200', position: { abbreviation: '1B' }, stats: { batting: { summary: '1-4' }, pitching: {} } },
        ID1: { person: { id: 1, fullName: 'First' }, battingOrder: '100', position: { abbreviation: 'DH' }, stats: { batting: { summary: '2-5' }, pitching: {} } },
        ID3: { person: { id: 3, fullName: 'Pitcher' }, position: { abbreviation: 'P' }, stats: { batting: {}, pitching: { summary: '6.0 IP, 1 ER', numberOfPitches: 95 } } },
      },
      info: [],
    });
    const out = applyResponseTransform({ teams: { away: side('A'), home: side('B') }, officials: [], info: [] }, tool('mlb_get_boxscore').responseMapping);
    const away = (out.value as any).away;
    expect(away.batters.map((b: any) => b.name)).toEqual(['First', 'Second']);
    expect(away.pitchers.map((p: any) => p.name)).toEqual(['Pitcher']);
  });
});

// Public endpoint, no key. From a datacenter address MLB may answer 406 (see instructions).
// RUN_MLB_LIVE=1 npx jest src/adapters/intl/mlb.live.spec.ts
const live = process.env.RUN_MLB_LIVE === '1' ? describe : describe.skip;
live('mlb adapter: live, keyless', () => {
  it('lists the 30 MLB teams', async () => {
    const res = await fetch(`${a.connector.baseUrl}/api/v1/teams?sportId=1`);
    expect(res.status).toBe(200);
    const teams = applyResponseTransform(await res.json(), tool('mlb_list_teams').responseMapping).value as any[];
    expect(teams.length).toBe(30);
  });
});
