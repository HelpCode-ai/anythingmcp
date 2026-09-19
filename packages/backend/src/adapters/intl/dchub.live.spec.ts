import * as adapter from './dchub.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Two layers of verification for the DC Hub adapter:
 *
 *   1. Static — always runs. Pins the thing that makes this connector unusual:
 *      the API key is OPTIONAL. Fourteen of the sixteen tools answer without
 *      credentials, so DCHUB_API_KEY lives in optionalEnvVars and
 *      requiredEnvVars is empty (an empty X-API-Key header is accepted by DC
 *      Hub on the keyless endpoints — verified live, 200). If anyone later
 *      moves the variable into requiredEnvVars, the install stops being one
 *      click and the reason to ship this adapter mostly goes away, so it is
 *      worth failing a test over. Also pins that the two endpoints which DO
 *      need a key say so in their own description, because that is the only
 *      place the model can read it.
 *
 *   2. Live — skipped unless RUN_DCHUB_LIVE is set. Calls the real API with no
 *      credentials at all and asserts the keyless endpoints really are keyless.
 *
 *   Run live with:  RUN_DCHUB_LIVE=1 npx jest src/adapters/intl/dchub.live.spec.ts
 */

type Tool = {
  name: string;
  description: string;
  endpointMapping: { method: string; path: string };
};

const a = adapter as unknown as {
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: { headerName: string; apiKey: string };
  };
  tools: Tool[];
};

/** The two operations DC Hub's spec gates behind the apiKey scheme. */
const KEYED_TOOLS = ['dchub_facility_detail', 'dchub_grid_fuel_mix'];

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

  it('tells the model, in the tool description, which two tools need a key', () => {
    for (const name of KEYED_TOOLS) {
      const tool = a.tools.find((t) => t.name === name);
      expect(tool).toBeDefined();
      expect(tool!.description).toMatch(/requires an api key/i);
      expect(tool!.description).toContain('DCHUB_API_KEY');
    }
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

live('dchub adapter — live API, no credentials', () => {
  const engine = new RestEngine(
    {} as unknown as OAuth2TokenService,
    {} as unknown as LoginTokenService,
  );
  // Deliberately NONE, not an empty API_KEY: this asserts the endpoints are
  // keyless, not that DC Hub tolerates a blank header.
  const config = { baseUrl: 'https://dchub.cloud', authType: 'NONE' };

  it('returns platform statistics without a key', async () => {
    const res = (await engine.execute(config, { method: 'GET', path: '/api/v1/stats' }, {})) as Record<
      string,
      unknown
    >;
    expect(res).toBeDefined();
    expect(typeof res).toBe('object');
  }, 30000);

  it('lists markets without a key', async () => {
    const res = (await engine.execute(config, { method: 'GET', path: '/api/v1/markets' }, {})) as unknown;
    expect(res).toBeDefined();
  }, 30000);

  it('scores a market without a key (Northern Virginia)', async () => {
    const res = (await engine.execute(
      config,
      { method: 'GET', path: '/api/v1/dcpi/scores/{market_slug}' },
      { market_slug: 'northern-virginia' },
    )) as Record<string, unknown>;
    expect(res).toBeDefined();
  }, 30000);
});
