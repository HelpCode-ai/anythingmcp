import axios from 'axios';
import * as adapter from './sportsapipro.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * SportsAPI Pro adapter (Football V2).
 *
 * Static checks always run: base URL (https://api.sportsapipro.com/v2/football,
 * the path-based front door of the published OpenAPI spec
 * https://docs.sportsapipro.com/openapi-football-v2.json) and the `x-api-key`
 * header, env vars, tool names, every argument a mapping reads is declared,
 * read-only hints, that no tool deals with market prices or generated match
 * commentary, and the requests a few tools build through the real RestEngine
 * (axios mocked). Paths follow https://docs.sportsapipro.com/api-reference/football-v2/overview.
 *
 * Live checks run only with RUN_SPORTSAPIPRO_LIVE=1. Without a key they
 * confirm the API refuses an anonymous call with 401; with SPORTSAPIPRO_API_KEY
 * they read the account status, live matches and a search (3 requests of the
 * daily quota):
 *
 *   RUN_SPORTSAPIPRO_LIVE=1 SPORTSAPIPRO_API_KEY=... npx jest src/adapters/intl/sportsapipro.live.spec.ts
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
  SPORTSAPIPRO_API_KEY: 'sap_live_4f8a2c1e9b7d3a5f6c0e',
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
const BASE = 'https://api.sportsapipro.com/v2/football';

describe('sportsapipro adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('uses the Football V2 base URL and the x-api-key header', () => {
    expect(a.slug).toBe('sportsapipro');
    expect(a.category).toBe('sports');
    expect(a.icon).toBe('sportsapipro');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'x-api-key', apiKey: '{{SPORTSAPIPRO_API_KEY}}' });
    expect(a.requiredEnvVars).toEqual(['SPORTSAPIPRO_API_KEY']);
    expect(a.envVarMeta?.SPORTSAPIPRO_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    const pattern = new RegExp(a.envVarMeta!.SPORTSAPIPRO_API_KEY.pattern!);
    expect(pattern.test(ENV.SPORTSAPIPRO_API_KEY)).toBe(true);
    for (const bad of ['', 'short', `x-api-key: ${ENV.SPORTSAPIPRO_API_KEY}`, 'https://api.sportsapipro.com']) {
      expect(pattern.test(bad)).toBe(false);
    }
    for (const status of ['401', '403', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.probe).toEqual({ tool: 'sportsapipro_get_account_status' });
    expect(tool('sportsapipro_get_account_status').parameters.required ?? []).toEqual([]);
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^sportsapipro_[a-z0-9_]+$/);
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

  it('only reads', () => {
    for (const entry of a.tools) {
      expect(entry.endpointMapping.method).toBe('GET');
      expect(annotationsOf(entry).readOnlyHint).toBe(true);
      expect(entry.enabled).not.toBe(false);
    }
  });

  it('leaves out every market-price endpoint, the generated insights and their wording', () => {
    const forbidden = /\b(odds|bookmakers?|bet|bets|betting|wager\w*|polymarket|tipsters?|tips?|stakes?)\b/i;
    for (const entry of a.tools) {
      expect(entry.name).not.toMatch(forbidden);
      expect(entry.description).not.toMatch(forbidden);
      expect(entry.endpointMapping.path).not.toMatch(/odds|ai-insights|winning|streaks/);
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
    mockedAxios.mockResolvedValue({ status: 200, data: { success: true }, headers: {} });

    await call('sportsapipro_get_account_status', {});
    expect(sent().url).toBe(`${BASE}/status`);
    expect(String(sent().method).toUpperCase()).toBe('GET');
    expect(sent().headers['x-api-key']).toBe(ENV.SPORTSAPIPRO_API_KEY);

    await call('sportsapipro_search', { q: 'arsenal' });
    expect(sent().url).toBe(`${BASE}/search`);
    expect(sent().params).toEqual({ q: 'arsenal' });

    await call('sportsapipro_get_standings', { tournament_id: 17, season_id: 76986 });
    expect(sent().url).toBe(`${BASE}/tournament/17/season/76986/standings`);

    await call('sportsapipro_get_top_players', { tournament_id: 35, season_id: 97464 });
    expect(sent().url).toBe(`${BASE}/tournament/35/season/97464/top-players`);
    expect(sent().params).toEqual({ type: 'overall' });

    await call('sportsapipro_list_team_matches', { team_id: 2561 });
    expect(sent().url).toBe(`${BASE}/teams/2561/events/next/0`);
    await call('sportsapipro_list_team_matches', { team_id: 2561, direction: 'last', page: 1 });
    expect(sent().url).toBe(`${BASE}/teams/2561/events/last/1`);

    await call('sportsapipro_list_season_matches', { tournament_id: 17, season_id: 76986, direction: 'last' });
    expect(sent().url).toBe(`${BASE}/tournament/17/season/76986/events/last/0`);

    await call('sportsapipro_list_matches_by_date', { date: '2026-03-15' });
    expect(sent().url).toBe(`${BASE}/schedule/2026-03-15`);

    await call('sportsapipro_get_match_incidents', { match_id: 16434052 });
    expect(sent().url).toBe(`${BASE}/match/16434052/incidents`);

    await call('sportsapipro_get_manager_career', { manager_id: 811325 });
    expect(sent().url).toBe(`${BASE}/managers/811325/career-history`);
  });
});

// Opt-in: RUN_SPORTSAPIPRO_LIVE=1. The refusal check needs no key; the reads need SPORTSAPIPRO_API_KEY.
const live = process.env.RUN_SPORTSAPIPRO_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('SportsAPI Pro: live', () => {
  it('refuses an anonymous call with 401', async () => {
    const response = await liveFetch.get(`${BASE}/live`, { validateStatus: () => true });
    expect(response.status).toBe(401);
    expect(response.data).toMatchObject({ success: false });
  });

  it('reads the account status, live matches and a search with a real key', async () => {
    const key = process.env.SPORTSAPIPRO_API_KEY;
    if (!key) throw new Error('Set SPORTSAPIPRO_API_KEY for the authenticated live check');
    const headers = { 'x-api-key': key, Accept: 'application/json' };
    const status = await liveFetch.get(`${BASE}/status`, { headers, validateStatus: () => true });
    expect(status.status).toBe(200);
    expect(status.data).toMatchObject({ success: true });
    const liveNow = await liveFetch.get(`${BASE}/live`, { headers, validateStatus: () => true });
    expect(liveNow.status).toBe(200);
    const search = await liveFetch.get(`${BASE}/search`, { headers, params: { q: 'arsenal' }, validateStatus: () => true });
    expect(search.status).toBe(200);
  });
});
