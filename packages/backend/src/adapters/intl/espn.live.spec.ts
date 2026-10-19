import * as adapter from './espn.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

const a = adapter as unknown as {
  requiredEnvVars: string[];
  connector: { baseUrl: string; authType: string };
  probe: { tool: string; params: Record<string, unknown> };
  tools: Array<{
    name: string;
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

describe('espn adapter: static spec conformance', () => {
  it('is keyless on site.api.espn.com', () => {
    expect(a.connector.baseUrl).toBe('https://site.api.espn.com');
    expect(a.connector.authType).toBe('NONE');
    expect(a.requiredEnvVars).toEqual([]);
  });

  it('is read-only', () => {
    for (const t of a.tools) expect(t.endpointMapping.method).toBe('GET');
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

  it('reads standings from /apis/v2, everything else from the site API', () => {
    expect(tool('espn_get_standings').endpointMapping.path).toBe('/apis/v2/sports/{sport}/{league}/standings');
    for (const t of a.tools.filter((x) => x.name !== 'espn_get_standings')) {
      expect(t.endpointMapping.path.startsWith('/apis/site/v2/sports/{sport}/{league}')).toBe(true);
    }
  });

  it('every transform compiles', () => {
    for (const t of a.tools) {
      const out = applyResponseTransform({}, t.responseMapping);
      expect(`${t.name}:${out.error ?? 'ok'}`).toBe(`${t.name}:ok`);
    }
  });

  it('flattens grouped (NFL) and flat (NBA, soccer) rosters alike', () => {
    const grouped = { team: { displayName: 'A' }, athletes: [{ position: 'offense', items: [{ id: '1', displayName: 'P1' }] }] };
    const flat = { team: { displayName: 'B' }, athletes: [{ id: '2', displayName: 'P2' }] };
    const t = tool('espn_get_team_roster');
    expect((applyResponseTransform(grouped, t.responseMapping).value as any).athletes.map((x: any) => x.name)).toEqual(['P1']);
    expect((applyResponseTransform(flat, t.responseMapping).value as any).athletes.map((x: any) => x.name)).toEqual(['P2']);
  });

  it('shapes a scoreboard game', () => {
    const raw = {
      leagues: [{ name: 'National Football League', season: { displayName: '2026' } }],
      week: { number: 6 },
      events: [
        {
          id: '401873008',
          name: 'Washington Commanders at San Francisco 49ers',
          date: '2026-10-20T00:15Z',
          status: { displayClock: '0:00', period: 0, type: { description: 'Scheduled', state: 'pre', completed: false } },
          competitions: [
            {
              venue: { fullName: "Levi's Stadium" },
              competitors: [{ homeAway: 'home', score: '0', team: { id: '25', displayName: 'San Francisco 49ers', abbreviation: 'SF' }, records: [{ summary: '5-0' }] }],
              odds: [{ provider: { name: 'DraftKings' }, details: 'SF -7.5', overUnder: 51.5 }],
            },
          ],
        },
      ],
    };
    const out = applyResponseTransform(raw, tool('espn_get_scoreboard').responseMapping);
    expect(out.applied).toBe(true);
    const ev = (out.value as any).events[0];
    expect(ev).toMatchObject({ id: '401873008', status: 'Scheduled', venue: "Levi's Stadium", odds: { details: 'SF -7.5' } });
    expect(ev.competitors[0]).toMatchObject({ team: 'San Francisco 49ers', homeAway: 'home', record: '5-0' });
  });
});

// Public endpoint, no key: RUN_ESPN_LIVE=1 npx jest src/adapters/intl/espn.live.spec.ts
const live = process.env.RUN_ESPN_LIVE === '1' ? describe : describe.skip;
live('espn adapter: live, keyless', () => {
  it('reads the NFL scoreboard and team list', async () => {
    const sb = await fetch(`${a.connector.baseUrl}/apis/site/v2/sports/football/nfl/scoreboard`);
    expect(sb.status).toBe(200);
    const shaped = applyResponseTransform(await sb.json(), tool('espn_get_scoreboard').responseMapping);
    expect(Array.isArray((shaped.value as any).events)).toBe(true);
    const teams = await fetch(`${a.connector.baseUrl}/apis/site/v2/sports/football/nfl/teams`);
    const list = applyResponseTransform(await teams.json(), tool('espn_list_teams').responseMapping).value as any[];
    expect(list.some((t) => t.abbreviation === 'KC')).toBe(true);
  });
});
