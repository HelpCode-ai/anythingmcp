import * as adapter from './deutsche-bahn.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { compile as jmespathCompile } from '@jmespath-community/jmespath';

/**
 * Two-layer verification for the deutsche-bahn adapter:
 *
 *   1. Static — always runs. Locks in the MOTIS API contract the adapter
 *      targets (/api/v1/geocode, /stoptimes, /plan) and that every tool ships
 *      a compiling JMESPath response mapping. Guards against a regression to
 *      the db-rest / bahn.de path, which Deutsche Bahn blocks from datacenter
 *      IPs, and against a typo in a mapping silently returning raw 12 KB boards
 *      (fallbackToRaw hides that in production).
 *
 *   2. Live — opt-in. Runs the real tools against a MOTIS instance and checks
 *      the mapped shapes, including that live data is actually flowing.
 *      Run with:  DB_LIVE_MOTIS_URL=http://localhost:8080 npx jest src/adapters/de/deutsche-bahn.live.spec.ts
 *      (deploy/motis builds one; the cloud's is http://motis:8080 inside the
 *      stack.)
 */

const a = adapter as unknown as {
  slug: string;
  category: string;
  requiredEnvVars: string[];
  connector: {
    baseUrl: string;
    authType: string;
    headers?: Record<string, string>;
    healthcheckPath?: string;
  };
  tools: Array<{
    name: string;
    useProxy?: boolean;
    endpointMapping: {
      method: string;
      path: string;
      queryParams?: Record<string, string>;
    };
    responseMapping?: { transform?: { mode?: string; expression?: string } };
  }>;
};

describe('deutsche-bahn adapter — static spec conformance', () => {
  it('targets a MOTIS instance the operator provides, not bahn.de or db-rest', () => {
    expect(a.slug).toBe('deutsche-bahn');
    expect(a.connector.baseUrl).toBe('{{MOTIS_URL}}');
    expect(a.requiredEnvVars).toEqual(['MOTIS_URL']);
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.healthcheckPath).toBe('/');
    expect(JSON.stringify(adapter)).not.toMatch(/transport\.rest|int\.bahn\.de|db-rest|IBNR/);
  });

  it('does not route through the anti-bot proxy (open data needs no unblocker)', () => {
    expect(a.tools.some((t) => t.useProxy === true)).toBe(false);
  });

  it('exposes the five timetable tools against the MOTIS v1 API', () => {
    const byName = (n: string) => a.tools.find((t) => t.name === n)!;
    expect(a.tools.map((t) => t.name)).toEqual([
      'db_search_locations',
      'db_get_stop',
      'db_get_departures',
      'db_get_arrivals',
      'db_get_journeys',
    ]);
    for (const t of a.tools) expect(t.endpointMapping.method).toBe('GET');
    expect(byName('db_search_locations').endpointMapping.path).toBe('/api/v1/geocode');
    expect(byName('db_search_locations').endpointMapping.queryParams?.type).toBe('STOP');
    expect(byName('db_get_stop').endpointMapping.path).toBe('/api/v1/stoptimes');
    expect(byName('db_get_departures').endpointMapping.path).toBe('/api/v1/stoptimes');
    expect(byName('db_get_departures').endpointMapping.queryParams?.arriveBy).toBe('false');
    expect(byName('db_get_arrivals').endpointMapping.queryParams?.arriveBy).toBe('true');
    const j = byName('db_get_journeys');
    expect(j.endpointMapping.path).toBe('/api/v1/plan');
    expect(j.endpointMapping.queryParams?.fromPlace).toBe('$from');
    expect(j.endpointMapping.queryParams?.toPlace).toBe('$to');
    expect(j.endpointMapping.queryParams?.arriveBy).toBe('$arrive_by');
  });

  it('every tool ships a JMESPath mapping that compiles', () => {
    for (const t of a.tools) {
      const tf = t.responseMapping?.transform;
      expect(tf?.mode).toBe('jmespath');
      expect(() => jmespathCompile(tf!.expression!)).not.toThrow();
    }
  });
});

const MOTIS_URL = process.env.DB_LIVE_MOTIS_URL;
const maybe = MOTIS_URL ? describe : describe.skip;

maybe('deutsche-bahn adapter — live smoke test against MOTIS', () => {
  const oauth = {} as unknown as OAuth2TokenService;
  const login = {} as unknown as LoginTokenService;
  const engine = new RestEngine(oauth, login);

  const cfg = {
    baseUrl: MOTIS_URL!,
    authType: 'NONE',
    headers: a.connector.headers,
  };
  const tool = (n: string) => a.tools.find((t) => t.name === n)!;
  const run = async (n: string, params: Record<string, unknown>) => {
    const raw = await engine.execute(cfg, tool(n).endpointMapping as any, params);
    const out = applyResponseTransform(raw, tool(n).responseMapping);
    expect(out.applied).toBe(true);
    return out.value as any;
  };

  let freiburg: string;
  let berlin: string;

  it('search_locations: Freiburg Hbf resolves to Freiburg Hauptbahnhof first', async () => {
    const res = await run('db_search_locations', { query: 'Freiburg Hbf' });
    expect(Array.isArray(res)).toBe(true);
    expect(res[0].name).toMatch(/Freiburg/);
    expect(Object.keys(res[0]).sort()).toEqual(['id', 'lat', 'lon', 'modes', 'name']);
    freiburg = res[0].id;
    berlin = (await run('db_search_locations', { query: 'Berlin Hbf' }))[0].id;
  }, 30000);

  it('get_stop: returns the station by id', async () => {
    const res = await run('db_get_stop', { id: freiburg });
    expect(res.id).toBe(freiburg);
    expect(res.name).toMatch(/Freiburg/);
  }, 30000);

  it('get_departures: a compact board with live data on at least one row', async () => {
    const res = await run('db_get_departures', { id: freiburg, n: 20 });
    expect(res.stop).toMatch(/Freiburg/);
    expect(res.departures.length).toBeGreaterThan(0);
    const row = res.departures[0];
    expect(typeof row.line).toBe('string');
    expect(row.scheduledDeparture).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The GTFS-RT feed is polled every two minutes; a board with no live rows
    // means the feed is not being applied, which is the regression to catch.
    expect(res.departures.some((d: any) => d.realTime === true)).toBe(true);
    expect(JSON.stringify(res).length).toBeLessThan(8000);
  }, 30000);

  it('get_arrivals: carries the origin of each train', async () => {
    const res = await run('db_get_arrivals', { id: freiburg, n: 5 });
    expect(res.arrivals.length).toBeGreaterThan(0);
    expect(typeof res.arrivals[0].origin).toBe('string');
    expect(res.arrivals[0].scheduledArrival).toMatch(/^\d{4}/);
  }, 30000);

  it('get_journeys: Freiburg → Berlin has a long-distance leg', async () => {
    const res = await run('db_get_journeys', { from: freiburg, to: berlin, results: 2 });
    expect(res.length).toBeGreaterThan(0);
    const it0 = res[0];
    expect(typeof it0.durationMinutes).toBe('number');
    expect(it0.legs.some((l: any) => /^(ICE|IC|EC|ECE)\b/.test(l.line ?? ''))).toBe(true);
  }, 60000);
});
