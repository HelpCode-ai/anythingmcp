import * as adapter from './dchub.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Two layers of verification for the DC Hub adapter:
 *
 *   1. Static — always runs. Pins the thing that makes this connector unusual:
 *      the API key is OPTIONAL. Twelve of the sixteen tools answer without
 *      credentials, so DCHUB_API_KEY lives in optionalEnvVars and
 *      requiredEnvVars is empty (an empty X-API-Key header is accepted by DC
 *      Hub on the keyless endpoints — verified live, 200). If anyone later
 *      moves the variable into requiredEnvVars, the install stops being one
 *      click and the reason to ship this adapter mostly goes away, so it is
 *      worth failing a test over. Also pins that the four endpoints which DO
 *      need a key say so in their own description, because that is the only
 *      place the model can read it.
 *
 *   2. Live — skipped unless RUN_DCHUB_LIVE is set. Calls the real API with no
 *      credentials and asserts, for EVERY tool, that the ones we advertise as
 *      keyless really are and the gated ones really are gated.
 *
 *      The original version of this file only exercised three endpoints that
 *      happened to work, which is why the adapter shipped claiming fourteen
 *      keyless tools when four of them answer 403. A live test that only
 *      visits the passing cases cannot catch that, so this one enumerates the
 *      whole surface from a single table.
 *
 *   Run live with:  RUN_DCHUB_LIVE=1 npx jest src/adapters/intl/dchub.live.spec.ts
 */

type Tool = {
  name: string;
  description: string;
  endpointMapping: { method: string; path: string };
};

const a = adapter as unknown as {
  description: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: { headerName: string; apiKey: string };
  };
  tools: Tool[];
};

/**
 * What each tool actually does without credentials, verified against the live
 * API on 2026-09-20. Not copied from DC Hub's spec: the spec declared
 * `dchub_facility_detail` as gated when it in fact answers 200 with a redacted
 * body, and declared nothing for `dchub_pipeline` and `dchub_energy_prices`
 * when both answer 403.
 *
 *   'open'     — 200 with real data, no key.
 *   'gated'    — 403; a free developer key unlocks it.
 *   'paid'     — 403 `plan_required`; only a paid Pro key unlocks it.
 *   'redacted' — 200, but the body carries `_gated: true`.
 */
const ANON_BEHAVIOUR: Record<string, 'open' | 'gated' | 'paid' | 'redacted'> = {
  dchub_stats: 'open',
  dchub_search_facilities: 'open',
  dchub_facility_detail: 'redacted',
  dchub_list_markets: 'open',
  dchub_compare_markets: 'open',
  dchub_market_dcpi: 'open',
  dchub_ai_capacity_index: 'open',
  dchub_interconnection_queue: 'open',
  dchub_pipeline: 'gated',
  dchub_transactions: 'open',
  dchub_news: 'open',
  dchub_site_score: 'paid',
  dchub_grid_fuel_mix: 'gated',
  dchub_energy_prices: 'gated',
  dchub_analyze_parcel: 'open',
  dchub_rank_sites: 'open',
};

/** Every tool that cannot be used on an unkeyed install must say so itself. */
const KEYED_TOOLS = Object.entries(ANON_BEHAVIOUR)
  .filter(([, b]) => b === 'gated' || b === 'paid')
  .map(([name]) => name);

describe('dchub adapter — static spec conformance', () => {
  it('keeps the API key optional so the connector installs in one click', () => {
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.optionalEnvVars).toEqual(['DCHUB_API_KEY']);
  });

  it('sends the key as the X-API-Key header the spec declares', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('X-API-Key');
    expect(a.connector.authConfig.apiKey).toBe('{{DCHUB_API_KEY}}');
    expect(a.connector.baseUrl).toBe('https://dchub.cloud');
  });

  it('tells the model, in the tool description, which tools need a key', () => {
    for (const name of KEYED_TOOLS) {
      const tool = a.tools.find((t) => t.name === name);
      expect(tool).toBeDefined();
      expect(tool!.description).toMatch(/requires an? (api key|paid)/i);
      expect(tool!.description).toContain('DCHUB_API_KEY');
    }
  });

  it('warns that the redacted tool answers 200 rather than failing', () => {
    // The dangerous shape: it does not error, so a model reports a gated
    // record as the full one unless the description says to check `_gated`.
    const tool = a.tools.find((t) => t.name === 'dchub_facility_detail')!;
    expect(tool.description).toMatch(/does NOT fail/);
    expect(tool.description).toContain('_gated');
  });

  it('does not bake a facility count into catalogue copy', () => {
    // DC Hub asked for this: the numbers move weekly and they cannot edit
    // our listing. Live figures come from dchub_stats instead.
    expect(a.description).not.toMatch(/[\d,]{4,}\+?\s*(facilities|data ?centres|data ?centers)/i);
  });

  it('covers all sixteen published operations, and nothing invented', () => {
    const mapped = a.tools
      .map((t) => `${t.endpointMapping.method} ${t.endpointMapping.path}`)
      .sort();
    expect(mapped).toEqual(
      [
        'GET /api/grid/fuel-mix',
        'GET /api/energy/prices/{state}',
        'GET /api/news',
        'GET /api/site-score',
        'GET /api/v1/ai-capacity-index',
        'GET /api/v1/dcpi/scores/{market_slug}',
        'GET /api/v1/facilities',
        'GET /api/v1/facilities/{facility_id}',
        'GET /api/v1/interconnection-queue/refined',
        'GET /api/v1/markets',
        'GET /api/v1/markets/compare',
        'GET /api/v1/pipeline',
        'GET /api/v1/stats',
        'GET /api/v1/transactions',
        'POST /api/v1/analyze-parcel',
        'POST /api/v1/rank-sites',
      ].sort(),
    );
  });

  it('writes nothing: only the two analysis endpoints POST, and they are computations', () => {
    const writes = a.tools.filter((t) => t.endpointMapping.method !== 'GET');
    expect(writes.map((t) => t.name).sort()).toEqual([
      'dchub_analyze_parcel',
      'dchub_rank_sites',
    ]);
    for (const tool of writes) {
      expect(tool.description).toMatch(/stores nothing/i);
    }
  });

  it('prefixes every tool name with dchub_', () => {
    expect(a.tools).toHaveLength(16);
    for (const tool of a.tools) {
      expect(tool.name.startsWith('dchub_')).toBe(true);
    }
  });
});

const live = process.env.RUN_DCHUB_LIVE ? describe : describe.skip;

/** Arguments good enough to get a real answer out of each tool. */
const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  dchub_facility_detail: { facility_id: '11342' },
  dchub_market_dcpi: { market_slug: 'northern-virginia' },
  dchub_compare_markets: { markets: 'northern-virginia,phoenix' },
  dchub_grid_fuel_mix: { iso: 'PJM' },
  dchub_energy_prices: { state: 'VA' },
  dchub_site_score: { lat: 39.0, lon: -77.4 },
  dchub_analyze_parcel: {
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-77.5, 39.0],
          [-77.4, 39.0],
          [-77.4, 39.1],
          [-77.5, 39.1],
          [-77.5, 39.0],
        ],
      ],
    },
  },
  // `objectives` must be non-empty and candidates use `lng`, not `lon` —
  // both are 400s from the real API, not schema guesses.
  dchub_rank_sites: {
    candidates: [{ id: 'a', lat: 39.0, lng: -77.4, mw: 100 }],
    objectives: { mw: 1 },
  },
};

live('dchub adapter — live API, no credentials', () => {
  const engine = new RestEngine(
    {} as unknown as OAuth2TokenService,
    {} as unknown as LoginTokenService,
  );
  // Deliberately NONE, not an empty API_KEY: this asserts the endpoints are
  // keyless, not that DC Hub tolerates a blank header.
  const config = { baseUrl: 'https://dchub.cloud', authType: 'NONE' };

  /** Runs a tool anonymously and reports status plus body, never throwing. */
  async function callAnonymously(tool: Tool) {
    try {
      const body = await engine.execute(
        config,
        tool.endpointMapping,
        SAMPLE_ARGS[tool.name] ?? {},
      );
      return { status: 200, body: body as Record<string, unknown> };
    } catch (err) {
      const e = err as { status?: number; response?: { status?: number } };
      return { status: e.status ?? e.response?.status ?? 0, body: {} };
    }
  }

  for (const tool of (adapter as unknown as { tools: Tool[] }).tools) {
    const expected = ANON_BEHAVIOUR[tool.name];

    it(`${tool.name} is ${expected} without a key`, async () => {
      const { status, body } = await callAnonymously(tool);

      if (expected === 'open') {
        expect(status).toBe(200);
        // An "open" tool that starts answering with a gated body is the
        // regression this catches: it still returns 200, so only the
        // marker distinguishes it.
        expect(body._gated).toBeFalsy();
        expect(body.tier_signal).not.toBe('preview');
      } else if (expected === 'redacted') {
        expect(status).toBe(200);
        expect(body._gated).toBe(true);
      } else {
        // gated | paid — both refuse, and the adapter must have said so.
        expect(status).toBe(403);
        const description = tool.description;
        expect(description).toContain('DCHUB_API_KEY');
      }
    }, 30000);
  }
});
