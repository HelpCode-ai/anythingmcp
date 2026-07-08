import * as adapter from './deutsche-bahn.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Two-layer verification for the deutsche-bahn adapter:
 *
 *   1. Static — always runs. Locks in the db-rest upstream schema. The connector
 *      ships pointing at the public db-rest (v6.db.transport.rest) so self-hosters
 *      use it as-is; AnythingMCP Cloud transparently rewrites the host to an
 *      internal self-hosted db-rest (see DynamicMcpTools.resolveInternalBaseUrl).
 *      This guards against a regression back to the int.bahn.de schema (Akamai
 *      403) or the bare v6 proxy without the db-rest endpoints.
 *
 *   2. Live — opt-in. Hits the public db-rest for real and asserts response shape.
 *      Run with:  RUN_DB_LIVE=1 npx jest src/adapters/de/deutsche-bahn.live.spec.ts
 *      (The public instance is best-effort and may return 503; cloud uses the
 *      internal instance instead.)
 */

const a = adapter as unknown as {
  slug: string;
  category: string;
  requiredEnvVars: string[];
  connector: {
    baseUrl: string;
    authType: string;
    headers?: Record<string, string>;
  };
  tools: Array<{
    name: string;
    useProxy?: boolean;
    endpointMapping: {
      method: string;
      path: string;
      queryParams?: Record<string, string>;
      bodyMapping?: Record<string, unknown>;
    };
  }>;
};

describe('deutsche-bahn adapter — static spec conformance', () => {
  it('targets the db-rest schema (public default), not int.bahn.de', () => {
    expect(a.slug).toBe('deutsche-bahn');
    expect(a.connector.baseUrl).toBe('https://v6.db.transport.rest');
    expect(a.connector.baseUrl).not.toContain('int.bahn.de');
    expect(a.connector.authType).toBe('NONE');
    expect(a.requiredEnvVars).toEqual([]);
  });

  it('does not route through the anti-bot proxy (db-rest needs no unblocker)', () => {
    expect(a.tools.some((t) => t.useProxy === true)).toBe(false);
  });

  // The shipped adapter pins `dbnav` — the profile that resolves from a normal
  // (residential) self-host IP. AnythingMCP Cloud overrides it to `dbweb` at
  // runtime (see resolveDbRestProfile), because over the cloud's Zyte egress
  // Deutsche Bahn blocks the `dbnav` mobile endpoints (Method Not Allowed /
  // OPS_BLOCKED) while the `dbweb` web-API endpoints work. Self-host must stay
  // on `dbnav`, so this contract is locked here.
  it('pins the dbnav profile on every tool (self-host default; cloud overrides to dbweb at runtime)', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.queryParams?.profile).toBe('dbnav');
    }
  });

  it('exposes the five timetable tools', () => {
    expect(a.tools).toHaveLength(5);
    const names = a.tools.map((t) => t.name);
    expect(names).toEqual([
      'db_search_locations',
      'db_get_stop',
      'db_get_departures',
      'db_get_arrivals',
      'db_get_journeys',
    ]);
  });

  it('uses the db-rest REST endpoints', () => {
    const byName = (n: string) => a.tools.find((t) => t.name === n)!;
    expect(byName('db_search_locations').endpointMapping.path).toBe('/locations');
    expect(byName('db_get_stop').endpointMapping.path).toBe('/stops/{id}');
    expect(byName('db_get_departures').endpointMapping.path).toBe(
      '/stops/{id}/departures',
    );
    expect(byName('db_get_arrivals').endpointMapping.path).toBe(
      '/stops/{id}/arrivals',
    );
  });

  it('journeys is a GET to /journeys with from/to query params', () => {
    const j = a.tools.find((t) => t.name === 'db_get_journeys')!;
    expect(j.endpointMapping.method).toBe('GET');
    expect(j.endpointMapping.path).toBe('/journeys');
    expect(j.endpointMapping.queryParams?.from).toBe('$from');
    expect(j.endpointMapping.queryParams?.to).toBe('$to');
    expect(j.endpointMapping.queryParams?.departure).toBe('$departure');
    expect(j.endpointMapping.queryParams?.arrival).toBe('$arrival');
  });
});

const maybe = process.env.RUN_DB_LIVE ? describe : describe.skip;

maybe('deutsche-bahn adapter — live smoke test (public db-rest)', () => {
  const oauth = {} as unknown as OAuth2TokenService;
  const login = {} as unknown as LoginTokenService;
  const engine = new RestEngine(oauth, login);

  const cfg = {
    baseUrl: a.connector.baseUrl,
    authType: 'NONE',
    headers: a.connector.headers,
  };

  it('search_locations: returns Freiburg(Breisgau) Hbf with id 8000107', async () => {
    const res = (await engine.execute(
      cfg,
      a.tools.find((t) => t.name === 'db_search_locations')!.endpointMapping,
      { query: 'Freiburg(Breisgau) Hbf', limit: 3 },
    )) as Array<{ id: string; name: string }>;
    expect(Array.isArray(res)).toBe(true);
    const fr = res.find((r) => r.id === '8000107');
    expect(fr).toBeDefined();
    expect(fr!.name).toContain('Freiburg');
  }, 30000);

  it('get_departures: returns departures[] with line + direction', async () => {
    const res = (await engine.execute(
      cfg,
      a.tools.find((t) => t.name === 'db_get_departures')!.endpointMapping,
      { id: '8000107', duration: 30 },
    )) as { departures: Array<{ line: unknown; direction: string }> };
    expect(res.departures).toBeDefined();
    expect(res.departures.length).toBeGreaterThan(0);
    expect(res.departures[0].line).toBeDefined();
  }, 30000);

  it('get_journeys: Freiburg → Berlin returns at least one journey', async () => {
    const res = (await engine.execute(
      cfg,
      a.tools.find((t) => t.name === 'db_get_journeys')!.endpointMapping,
      { from: '8000107', to: '8011160', results: 2 },
    )) as { journeys: unknown[] };
    expect(res.journeys).toBeDefined();
    expect(res.journeys.length).toBeGreaterThan(0);
  }, 60000);
});
