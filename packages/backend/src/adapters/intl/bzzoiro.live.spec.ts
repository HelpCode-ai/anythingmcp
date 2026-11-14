import axios from 'axios';
import * as adapter from './bzzoiro.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Bzzoiro Sports Data adapter (football, API v2).
 *
 * Static checks always run: base URL and token auth (`Authorization: Token
 * <key>`, securityScheme tokenAuth in https://sports.bzzoiro.com/api/schema/),
 * env vars, tool names, every argument a mapping reads is declared, read-only
 * hints, that no tool deals with market prices, and the requests a few tools
 * build through the real RestEngine (axios mocked). Paths follow the public
 * OpenAPI schema and https://sports.bzzoiro.com/docs/football/.
 *
 * Live checks run only with RUN_BZZOIRO_LIVE=1. Without a key they confirm
 * the API refuses an anonymous call with 401; with BZZOIRO_API_KEY they read
 * leagues, live matches and one league's standings:
 *
 *   RUN_BZZOIRO_LIVE=1 BZZOIRO_API_KEY=... npx jest src/adapters/intl/bzzoiro.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
    AxiosHeaders: actual.AxiosHeaders,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  responseMapping?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  icon: string;
  description: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta?: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe?: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({
    name: entry.name,
    connectorType: 'REST',
    endpointMapping: entry.endpointMapping,
    annotations: entry.annotations,
  });
// Every argument a mapping reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (entry: Tool) => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (/^\$\w+$/.test(v)) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};

const ENV: Record<string, string> = {
  BZZOIRO_API_KEY: '9f2c4e1a7b3d5f6081a2c3e4d5f60718293a4b5c',
};
const stubLogin = {} as LoginTokenService;

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, stubLogin).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: cfg.headers,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];

describe('bzzoiro adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('uses the v2 base URL and sends the key as Authorization: Token', () => {
    expect(a.slug).toBe('bzzoiro');
    expect(a.category).toBe('sports');
    expect(a.icon).toBe('bzzoiro');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://sports.bzzoiro.com/api/v2');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'Token {{BZZOIRO_API_KEY}}' });
    expect(a.requiredEnvVars).toEqual(['BZZOIRO_API_KEY']);
    expect(a.envVarMeta?.BZZOIRO_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    const pattern = new RegExp(a.envVarMeta!.BZZOIRO_API_KEY.pattern!);
    expect(pattern.test(ENV.BZZOIRO_API_KEY)).toBe(true);
    for (const bad of ['', 'short', `Token ${ENV.BZZOIRO_API_KEY}`, 'https://sports.bzzoiro.com']) {
      expect(pattern.test(bad)).toBe(false);
    }
    for (const status of ['401', '403', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.probe).toEqual({ tool: 'bzzoiro_list_leagues', params: { limit: 5 } });
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^bzzoiro_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(declared.has(arg) || envNames.has(arg)).toBe(true);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(40);
    }
  });

  it('only reads, and every tool stays on the football v2 paths', () => {
    for (const entry of a.tools) {
      expect(entry.endpointMapping.method).toBe('GET');
      expect(annotationsOf(entry).readOnlyHint).toBe(true);
      expect(entry.endpointMapping.path).toMatch(/^\/(leagues|events|teams|players|managers|broadcasts)\//);
      expect(entry.enabled).not.toBe(false);
    }
  });

  it('leaves out every market-price, bookmaker and prediction-market endpoint and word', () => {
    const forbidden = /\b(odds|bookmakers?|bet|bets|betting|wager\w*|polymarket|tipsters?|tips?|stakes?)\b/i;
    for (const entry of a.tools) {
      expect(entry.name).not.toMatch(forbidden);
      expect(entry.description).not.toMatch(forbidden);
      expect(entry.endpointMapping.path).not.toMatch(/odds|bookmaker|polymarket|tipster|wom/);
      for (const p of Object.values(entry.parameters.properties ?? {})) expect(p.description ?? '').not.toMatch(forbidden);
    }
    expect(a.instructions).not.toMatch(forbidden);
    expect(a.description).not.toMatch(forbidden);
  });

  it('names every tool in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('builds the documented requests', async () => {
    mockedAxios.mockResolvedValue({ status: 200, data: {}, headers: {} });

    await call('bzzoiro_list_leagues', { country: 'England', limit: 5 });
    expect(sent().url).toBe('https://sports.bzzoiro.com/api/v2/leagues/');
    expect(String(sent().method).toUpperCase()).toBe('GET');
    expect(sent().params).toEqual({ country: 'England', limit: 5 });
    expect(sent().headers.Authorization).toBe(`Token ${ENV.BZZOIRO_API_KEY}`);

    await call('bzzoiro_list_matches', { league_id: 1, date_from: '2026-08-01', date_to: '2026-08-07', status: 'finished' });
    expect(sent().url).toBe('https://sports.bzzoiro.com/api/v2/events/');
    expect(sent().params).toEqual({ league_id: 1, date_from: '2026-08-01', date_to: '2026-08-07', status: 'finished' });

    await call('bzzoiro_get_league_leaders', { league_id: 1, stat: 'scorers', limit: 10 });
    expect(sent().url).toBe('https://sports.bzzoiro.com/api/v2/leagues/1/top/scorers/');
    expect(sent().params).toEqual({ stat: 'scorers', limit: 10 });

    await call('bzzoiro_get_standings', { league_id: 3, season_id: 77 });
    expect(sent().url).toBe('https://sports.bzzoiro.com/api/v2/leagues/3/standings/');
    expect(sent().params).toEqual({ season_id: 77 });

    await call('bzzoiro_list_team_fixtures', { team_id: 42 });
    expect(sent().url).toBe('https://sports.bzzoiro.com/api/v2/teams/42/fixtures/');

    await call('bzzoiro_get_match_incidents', { match_id: 9001 });
    expect(sent().url).toBe('https://sports.bzzoiro.com/api/v2/events/9001/incidents/');

    await call('bzzoiro_list_broadcasts', { match_id: 9001, country_code: 'GB' });
    expect(sent().url).toBe('https://sports.bzzoiro.com/api/v2/broadcasts/');
    expect(sent().params).toEqual({ event_id: 9001, country_code: 'GB' });

    await call('bzzoiro_get_match_outlook', { match_id: 9001 });
    expect(sent().url).toBe('https://sports.bzzoiro.com/api/v2/events/9001/prediction/');
  });

  it('keeps the match outlook to result probabilities, expected goals and the likely score', () => {
    const body = {
      id: 5,
      created_at: '2026-08-01T10:00:00Z',
      event: { id: 9001, home_team: 'A', away_team: 'B', event_date: '2026-08-02T14:00:00Z' },
      markets: {
        match_result: { prob_home: 52.1, prob_draw: 25.4, prob_away: 22.5, predicted: 'H' },
        expected_goals: { home: 1.6, away: 0.9 },
        over_under: { prob_over_25: 51 },
        btts: { prob_yes: 48 },
        score: { most_likely: '1-0' },
        draw_no_bet: { prob_home: 70 },
        corners: { prob_over_95: 40 },
      },
      recommendations: {},
      model: { confidence: 0.521, version: 'dc-blend-v1' },
    };
    const mapping = tool('bzzoiro_get_match_outlook').responseMapping as never;
    expect(applyResponseTransform(body, mapping).value).toEqual({
      id: 5,
      created_at: '2026-08-01T10:00:00Z',
      match: body.event,
      result_probabilities: body.markets.match_result,
      expected_goals: body.markets.expected_goals,
      most_likely_score: '1-0',
      confidence: 0.521,
      model_version: 'dc-blend-v1',
    });
    const managers = applyResponseTransform(
      { count: 1, results: [{ id: 1, name: 'X', wins: 3, btts_pct: 50, over_25_pct: 60 }] },
      tool('bzzoiro_list_managers').responseMapping as never,
    ).value;
    expect(managers).toEqual({ count: 1, results: [{ id: 1, name: 'X', wins: 3 }] });
  });
});

// Opt-in: RUN_BZZOIRO_LIVE=1. The refusal check needs no key; the reads need BZZOIRO_API_KEY.
const live = process.env.RUN_BZZOIRO_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('Bzzoiro: live', () => {
  const base = 'https://sports.bzzoiro.com/api/v2';

  it('refuses an anonymous call with 401', async () => {
    const response = await liveFetch.get(`${base}/leagues/`, { validateStatus: () => true });
    expect(response.status).toBe(401);
  });

  it('reads leagues, live matches and one standings table with a real key', async () => {
    const key = process.env.BZZOIRO_API_KEY;
    if (!key) throw new Error('Set BZZOIRO_API_KEY for the authenticated live check');
    const headers = { Authorization: `Token ${key}`, Accept: 'application/json' };
    const leagues = await liveFetch.get(`${base}/leagues/`, { headers, params: { limit: 5 }, validateStatus: () => true });
    expect(leagues.status).toBe(200);
    expect(Array.isArray(leagues.data.results)).toBe(true);
    const liveNow = await liveFetch.get(`${base}/events/live/`, { headers, validateStatus: () => true });
    expect(liveNow.status).toBe(200);
    const first = leagues.data.results[0];
    if (!first) return;
    const table = await liveFetch.get(`${base}/leagues/${first.id}/standings/`, { headers, validateStatus: () => true });
    expect([200, 404]).toContain(table.status);
  });
});
