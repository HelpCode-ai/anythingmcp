import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service';
import * as adapter from './meest.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Meest adapter (Meest Open API v3.0 at api.meest.com/v3.0/openAPI).
 *
 * Static checks always run: the sign-in (POST /auth with login and password,
 * token from result.token, sent in the token header), the error rules for
 * answers with status Error, every tool's method and path against Meest's
 * Swagger document (wiki.meest-group.com/api/files/openAPI_ua.json, read
 * Nov 2026), the search and price bodies, the contract id default, and that
 * creating and deleting parcels install switched off.
 *
 * Live checks run only with RUN_MEEST_LIVE=1. Without credentials they
 * confirm a wrong login is refused; with MEEST_USERNAME and MEEST_PASSWORD
 * they read the branch types. Reads only. Not run for the first version: no
 * Meest contract was available.
 *
 *   RUN_MEEST_LIVE=1 MEEST_USERNAME=... MEEST_PASSWORD=... \
 *     npx jest src/adapters/intl/meest.live.spec.ts
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

type Param = { type?: string; description?: string; pattern?: string; enum?: unknown[]; default?: unknown; items?: Param };
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, Param>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: unknown;
    headers?: Record<string, string>;
    envDefaults?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  description: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string; link?: string; help?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
    headers?: Record<string, string>;
    config?: Record<string, unknown>;
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({ name: entry.name, connectorType: 'REST', endpointMapping: entry.endpointMapping, annotations: entry.annotations } as never);
const used = (entry: Tool) => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (/^\$\w+$/.test(v)) out.add(v.slice(1));
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
const outsideBackticks = (text: string) => text.replace(/`[^`]*`/g, '');

// Method and path of every tool, from the vendor's documentation (see above).
const ROUTES: Record<string, [string, string]> = {
  meest_track_parcel: ['GET', '/tracking/{track_number}'],
  meest_get_parcel_status: ['GET', '/parcelStatus/{parcel_id}'],
  meest_get_parcel: ['GET', '/getParcel/{parcel}/{search_mode}/objectData'],
  meest_list_parcels_by_date: ['GET', '/parcelsList/{date}'],
  meest_list_tracking_by_date: ['GET', '/trackingByDate/{date}'],
  meest_list_delivered_parcels: ['GET', '/trackingDelivered/{date_from}/{date_to}/{page}'],
  meest_list_registers_by_date: ['GET', '/registersList/{date}'],
  meest_search_branches: ['POST', '/branchSearch'],
  meest_find_nearest_branches: ['GET', '/branchSearchGeo/{latitude}/{longitude}/{radius}'],
  meest_list_branch_types: ['GET', '/branchTypes'],
  meest_search_cities: ['POST', '/citySearch'],
  meest_search_cities_by_zip: ['GET', '/zipCodeSearch/{zip_code}'],
  meest_search_addresses: ['POST', '/addressSearch'],
  meest_calculate: ['POST', '/calculate'],
  meest_get_sticker: ['GET', '/print/sticker100/{print_value}'],
  meest_get_contract: ['GET', '/contractClientInfo/{contract_id}'],
  meest_list_special_conditions: ['GET', '/specConditions'],
  meest_create_parcel: ['POST', '/parcel'],
  meest_delete_parcel: ['DELETE', '/parcel/{parcel_id}'],
};
// Tools that change spend, buy, cancel or delete: installed switched off.
const OFF = ['meest_create_parcel', 'meest_delete_parcel'];
// POST tools that only read (searches, reports, price estimates).
const READ_POSTS = [
  'meest_calculate',
  'meest_search_addresses',
  'meest_search_branches',
  'meest_search_cities',
];

// Built at runtime so no literal looks like a real credential.
const ENV: Record<string, string> = {
  MEEST_USERNAME: 'api-login-7',
  MEEST_PASSWORD: ['Pw', 'z'.repeat(12), '1'].join(''),
  MEEST_CONTRACT_ID: ['a123b4c5', '6d78', '90e1', '23f4', '5a67bc890123'].join('-'),
};

const FAKE_TOKEN = ['tok', 'x'.repeat(28)].join('');
const stubLogin = () => {
  const bundle = async () => ({ token: FAKE_TOKEN, expiresAt: Date.now() + 3_600_000 });
  return { getToken: bundle, forceRelogin: bundle } as unknown as LoginTokenService;
};
// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping as never,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, stubLogin()).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig ?? {}, ENV),
      headers: cfg.headers,
      config: a.connector.config,
    } as never,
    endpointMapping as never,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (data: unknown = {}, status = 200) =>
  mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

describe('meest adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('has the catalog envelope', () => {
    expect(a.slug).toBe('meest');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('logistics');
    expect(a.icon).toBe('meest');
    expect(a.docsUrl).toBe('https://wiki.meest-group.com/api/ua/v3.0/openAPI');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://api.meest.com/v3.0/openAPI');
    expect(a.connector.headers).toMatchObject({ Accept: 'application/json', 'User-Agent': 'AnythingMCP' });
  });

  it('describes every variable and accepts well-formed values', () => {
    const vars = [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])];
    expect(Object.keys(a.envVarMeta).sort()).toEqual([...vars].sort());
    for (const name of vars) {
      const meta = a.envVarMeta[name];
      expect(meta.help).toBeTruthy();
      expect(meta.link).toMatch(/^https:\/\//);
      if (meta.pattern) {
        expect(new RegExp(meta.pattern).test(ENV[name])).toBe(true);
        expect(new RegExp(meta.pattern).test('')).toBe(false);
      }
    }
  });

  it('maps every tool to its documented method and path', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const entry of a.tools) {
      expect([entry.name, entry.endpointMapping.method, entry.endpointMapping.path]).toEqual([entry.name, ...ROUTES[entry.name]]);
    }
  });

  it('installs the spending, buying, cancelling and deleting tools switched off', () => {
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual([...OFF].sort());
    for (const name of OFF) expect(tool(name).endpointMapping.method).not.toBe('GET');
  });

  it('marks reads read-only and nothing else', () => {
    for (const entry of a.tools) {
      const read = entry.endpointMapping.method === 'GET' || READ_POSTS.includes(entry.name);
      expect([entry.name, annotationsOf(entry).readOnlyHint === true]).toEqual([entry.name, read]);
    }
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^meest_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)?.tools ?? []) expect(mine.has(other.name)).toBe(false);
    }
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect([entry.name, arg, declared.has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const [param, variable] of Object.entries(entry.endpointMapping.envDefaults ?? {})) {
        expect(declared.has(param)).toBe(true);
        expect(entry.parameters.required ?? []).not.toContain(param);
        expect(a.optionalEnvVars ?? []).toContain(variable);
      }
      expect(entry.description.length).toBeGreaterThan(40);
      for (const prop of Object.values(entry.parameters.properties ?? {})) {
        expect(prop.description).toBeTruthy();
        if (prop.pattern) expect(prop.pattern).not.toMatch(/\\[1-9]/);
      }
    }
  });

  it('keeps the texts free of MDX characters and names every tool in the instructions', () => {
    expect(a.instructions.startsWith('## ')).toBe(true);
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    const texts = [a.description, a.instructions, a.prerequisites, ...Object.values(a.verifyHints)];
    for (const entry of a.tools) {
      texts.push(entry.description);
      for (const prop of Object.values(entry.parameters.properties ?? {})) texts.push(prop.description ?? '');
    }
    for (const text of texts) expect(outsideBackticks(text)).not.toMatch(/[{}<]/);
  });

  it('probes with a cheap read and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'meest_list_branch_types', params: {} });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).enabled).not.toBe(false);
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('signs in with login and password and reads the token from result.token', async () => {
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toMatchObject({
      loginUrl: 'https://api.meest.com/v3.0/openAPI/auth',
      loginMethod: 'POST',
      tokenJsonPath: 'result.token',
      headerName: 'token',
      headerTemplate: '${token}',
      refreshOn401: true,
    });
    const config = { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService;
    mockedAxios.mockResolvedValueOnce({
      status: 200,
      data: { status: 'OK', info: {}, result: { token: 'meest-token-1', refresh_token: 'r', expiresIn: 86400 } },
      headers: {},
    });
    const auth = interpolateDeep(a.connector.authConfig ?? {}, ENV) as never;
    const bundle = await new LoginTokenService({} as PrismaService, config).getToken(auth);
    const login = sent();
    expect(String(login.method).toUpperCase()).toBe('POST');
    expect(login.url).toBe('https://api.meest.com/v3.0/openAPI/auth');
    expect(login.data).toEqual({ username: ENV.MEEST_USERNAME, password: ENV.MEEST_PASSWORD });
    expect(bundle.token).toBe('meest-token-1');
  });

  it('turns an answer with status Error into a failed call', () => {
    const rules = (a.connector.config?.errorWhen ?? []) as Array<{ path: string; matches?: string; status: number }>;
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.path).toBe('status');
      expect(new RegExp(rule.matches ?? '', 'i').test('Error')).toBe(true);
      expect(new RegExp(rule.matches ?? '', 'i').test('OK')).toBe(false);
    }
  });

  it('tracks with the token header', async () => {
    ok({ status: 'OK', result: [] });
    await call('meest_track_parcel', { track_number: '711-2550636' });
    const req = sent();
    expect(req.url).toBe('https://api.meest.com/v3.0/openAPI/tracking/711-2550636');
    expect(header(req, 'token')).toBe(FAKE_TOKEN);
    expect(header(req, 'Authorization')).toBeUndefined();
  });

  it('searches branches and localities with Meest filter names', async () => {
    ok({ status: 'OK', result: [] });
    await call('meest_search_branches', { city: 'Льв%', branch_number: '01' });
    expect(sent().url).toBe('https://api.meest.com/v3.0/openAPI/branchSearch');
    expect(sent().data).toEqual({ filters: { cityDescr: 'Льв%', branchNumber: '01' } });

    ok({ status: 'OK', result: [] });
    await call('meest_search_cities', { city: 'Львів' });
    expect(sent().data).toEqual({ filters: { cityDescr: 'Львів', countryID: 'c35b6195-4ea3-11de-8591-001d600938f8' } });
  });

  it('encodes the date and time of the delivered parcels in the path', async () => {
    ok({ status: 'OK', result: [] });
    await call('meest_list_delivered_parcels', { date_from: '2026-11-01 00:00:00', date_to: '2026-11-01 02:00:00' });
    expect(sent().url).toBe(
      'https://api.meest.com/v3.0/openAPI/trackingDelivered/2026-11-01%2000%3A00%3A00/2026-11-01%2002%3A00%3A00/1',
    );
  });

  it('uses the contract id of the connector by default for price, label and contract', async () => {
    for (const name of ['meest_calculate', 'meest_get_sticker', 'meest_get_contract']) {
      expect(tool(name).endpointMapping.envDefaults).toEqual({ contract_id: 'MEEST_CONTRACT_ID' });
    }
    ok({ status: 'OK', result: [] });
    await call('meest_calculate', { contract_id: ENV.MEEST_CONTRACT_ID, sender_branch_id: '0d161467-ffac-11e8-80d9-1c98ec135261', receiver_branch_id: '0d161467-ffac-11e8-80d9-1c98ec135262', weight: 2.5 });
    expect(sent().data).toEqual({
      contractID: ENV.MEEST_CONTRACT_ID,
      sender: { service: 'Branch', branchID: '0d161467-ffac-11e8-80d9-1c98ec135261' },
      receiver: { service: 'Branch', branchID: '0d161467-ffac-11e8-80d9-1c98ec135262' },
      placesItems: [{ quantity: 1, weight: 2.5 }],
    });

    ok({});
    await call('meest_get_sticker', { print_value: '711-2550636', contract_id: ENV.MEEST_CONTRACT_ID });
    expect(sent().url).toBe('https://api.meest.com/v3.0/openAPI/print/sticker100/711-2550636');
    expect(sent().params).toEqual({ agent: ENV.MEEST_CONTRACT_ID });
  });
});

// Opt-in: RUN_MEEST_LIVE=1. The refusal check needs no account; the read
// needs MEEST_USERNAME and MEEST_PASSWORD. Nothing is written.
const live = process.env.RUN_MEEST_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('meest: live', () => {
  const signIn = (username: string, password: string) =>
    liveFetch.post('https://api.meest.com/v3.0/openAPI/auth', { username, password }, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      validateStatus: () => true,
    });

  it('refuses a wrong login', async () => {
    const response = await signIn('not-a-login', 'not-a-password');
    expect(response.status !== 200 || String(response.data?.status).toLowerCase() === 'error').toBe(true);
  });

  it('reads the branch types', async () => {
    const username = process.env.MEEST_USERNAME;
    const password = process.env.MEEST_PASSWORD;
    if (!username || !password) throw new Error('Set MEEST_USERNAME and MEEST_PASSWORD for the live check');
    const login = await signIn(username, password);
    expect(login.status).toBe(200);
    const response = await liveFetch.get('https://api.meest.com/v3.0/openAPI/branchTypes', {
      headers: { token: login.data.result.token, Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
    expect(String(response.data.status).toLowerCase()).toBe('ok');
  });
});
