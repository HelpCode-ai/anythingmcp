import * as adapter from './deutsche-bahn.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Two-layer verification for the deutsche-bahn adapter:
 *
 *   1. Static — always runs. Locks in the int.bahn.de upstream (so a future
 *      refactor doesn't silently regress back to v6.db.transport.rest, the
 *      community proxy that started returning 503s and motivated this rewrite),
 *      the five expected tools, and the journeys body shape (POST to
 *      /angebote/fahrplan with the German-enterprise field names DB's website
 *      uses internally).
 *
 *   2. Live — opt-in. Hits int.bahn.de for real and asserts response shape.
 *      Run with:  RUN_DB_LIVE=1 npx jest src/adapters/de/deutsche-bahn.live.spec.ts
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
    endpointMapping: {
      method: string;
      path: string;
      queryParams?: Record<string, string>;
      bodyMapping?: Record<string, unknown>;
    };
  }>;
};

describe('deutsche-bahn adapter — static spec conformance', () => {
  it('targets bahn.de directly (not the deprecated v6.db.transport.rest proxy)', () => {
    expect(a.slug).toBe('deutsche-bahn');
    expect(a.connector.baseUrl).toBe('https://int.bahn.de/web/api');
    expect(a.connector.baseUrl).not.toContain('v6.db.transport.rest');
    expect(a.connector.authType).toBe('NONE');
    expect(a.requiredEnvVars).toEqual([]);
  });

  it('sends Accept-Language=de-DE and a real User-Agent (Akamai rejects axios-default UA on int.bahn.de)', () => {
    expect(a.connector.headers?.['Accept-Language']).toBe('de-DE');
    expect(a.connector.headers?.['User-Agent']).toMatch(/anythingmcp/i);
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

  it('search/departures/arrivals use the int.bahn.de v2-style endpoints', () => {
    const byName = (n: string) => a.tools.find((t) => t.name === n)!;
    expect(byName('db_search_locations').endpointMapping.path).toBe(
      '/reiseloesung/orte',
    );
    expect(byName('db_get_departures').endpointMapping.path).toBe(
      '/reiseloesung/abfahrten',
    );
    expect(byName('db_get_arrivals').endpointMapping.path).toBe(
      '/reiseloesung/ankuenfte',
    );
    // departures/arrivals pass the IBNR as ortExtId (not as a path segment)
    expect(
      byName('db_get_departures').endpointMapping.queryParams?.ortExtId,
    ).toBe('$id');
    expect(
      byName('db_get_arrivals').endpointMapping.queryParams?.ortExtId,
    ).toBe('$id');
  });

  it('journeys POSTs the German-enterprise body to /angebote/fahrplan', () => {
    const j = a.tools.find((t) => t.name === 'db_get_journeys')!;
    expect(j.endpointMapping.method).toBe('POST');
    expect(j.endpointMapping.path).toBe('/angebote/fahrplan');
    const body = j.endpointMapping.bodyMapping!;
    // The lid wrapper is what bahn.de actually expects — searches return the
    // IBNR as extId; the journeys endpoint wants it boxed into the location
    // identifier format `A=1@L=<ibnr>@`. Locking it in here so nobody passes
    // the bare IBNR and gets a silent 422.
    expect(body.abfahrtsHalt).toBe('A=1@L=${from}@');
    expect(body.ankunftsHalt).toBe('A=1@L=${to}@');
    expect(body.anfrageZeitpunkt).toBe('$when');
    // Required scalar fields the API enforces (422 otherwise — verified live)
    expect(body.reisende).toBeDefined();
    expect(body.klasse).toBe('KLASSE_2');
    expect(body.produktgattungen).toEqual(
      expect.arrayContaining(['ICE', 'REGIONAL', 'SBAHN']),
    );
  });
});

const maybe = process.env.RUN_DB_LIVE ? describe : describe.skip;

maybe('deutsche-bahn adapter — live smoke test', () => {
  const oauth = {} as unknown as OAuth2TokenService;
  const login = {} as unknown as LoginTokenService;
  const engine = new RestEngine(oauth, login);

  const cfg = {
    baseUrl: a.connector.baseUrl,
    authType: 'NONE',
    headers: a.connector.headers,
  };

  it('search_locations: returns Freiburg(Breisgau) Hbf with IBNR 8000107', async () => {
    const res = (await engine.execute(
      cfg,
      a.tools.find((t) => t.name === 'db_search_locations')!.endpointMapping,
      { query: 'Freiburg/Breisgau Hbf', limit: 3 },
    )) as Array<{ extId: string; name: string; products: string[] }>;
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBeGreaterThan(0);
    const fr = res.find((r) => r.extId === '8000107');
    expect(fr).toBeDefined();
    expect(fr!.name).toContain('Freiburg');
    expect(fr!.products).toEqual(expect.arrayContaining(['ICE']));
  }, 30000);

  it('get_departures: returns entries[] with verkehrmittel + terminus', async () => {
    const res = (await engine.execute(
      cfg,
      a.tools.find((t) => t.name === 'db_get_departures')!.endpointMapping,
      { id: '8000107' },
    )) as { entries: Array<{ verkehrmittel: unknown; terminus: string }> };
    expect(res.entries).toBeDefined();
    expect(res.entries.length).toBeGreaterThan(0);
    expect(res.entries[0].verkehrmittel).toBeDefined();
    expect(typeof res.entries[0].terminus).toBe('string');
  }, 30000);

  it('get_arrivals: returns entries[] for Berlin Hbf', async () => {
    const res = (await engine.execute(
      cfg,
      a.tools.find((t) => t.name === 'db_get_arrivals')!.endpointMapping,
      { id: '8011160' },
    )) as { entries: unknown[] };
    expect(res.entries).toBeDefined();
    expect(res.entries.length).toBeGreaterThan(0);
  }, 30000);

  it('get_journeys: Freiburg → Berlin returns at least one verbindung', async () => {
    // Use tomorrow 08:00 Berlin to avoid edge cases around past/future of "now"
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const yyyy = tomorrow.getFullYear();
    const mm = String(tomorrow.getMonth() + 1).padStart(2, '0');
    const dd = String(tomorrow.getDate()).padStart(2, '0');
    const whenLocal = `${yyyy}-${mm}-${dd}T08:00:00`;

    const res = (await engine.execute(
      cfg,
      a.tools.find((t) => t.name === 'db_get_journeys')!.endpointMapping,
      {
        from: '8000107',
        to: '8011160',
        when: whenLocal,
        direction: 'ABFAHRT',
        maxTransfers: -1,
        minTransferTime: 0,
        fastOnly: true,
        bike: false,
      },
    )) as { verbindungen: unknown[] };
    expect(res.verbindungen).toBeDefined();
    expect(res.verbindungen.length).toBeGreaterThan(0);
  }, 60000);
});
