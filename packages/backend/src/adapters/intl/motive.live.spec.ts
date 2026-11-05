import axios from 'axios';
import * as adapter from './motive.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Motive (formerly KeepTruckin) fleet adapter, read-only.
 *
 * Static checks always run: the company API key goes in X-Api-Key to
 * https://api.gomotive.com, every tool is a GET, every argument a mapping
 * reads is declared, array filters use the bracketed `name[]` keys the
 * reference documents, and the optional X-Time-Zone / X-Metric-Units
 * headers are only sent when asked for. Paths follow the public reference:
 * https://developer.gomotive.com/reference
 *
 *   GET /v1/vehicles, /v1/vehicles/{id}, /v1/vehicles/lookup
 *   GET /v2/vehicle_locations, /v2/vehicle_locations/{id}, /v3/vehicle_locations
 *   GET /v1/driver_locations, /v1/users, /v1/users/{id}
 *   GET /v1/available_time, /v1/logs, /v1/hos_violations
 *   GET /v1/ifta/trips, /v1/ifta/summary, /v1/fuel_purchases
 *   GET /v2/inspection_reports, /v2/driver_performance_events
 *   GET /v1/fault_codes, /v1/driving_periods
 *   GET /v1/assets, /v1/asset_locations, /v1/groups
 *
 * Live checks run only with RUN_MOTIVE_LIVE=1. Without a key they confirm a
 * wrong key is refused with 401; with MOTIVE_API_KEY they read one page of
 * vehicles, vehicle locations and users:
 *
 *   RUN_MOTIVE_LIVE=1 MOTIVE_API_KEY=... npx jest src/adapters/intl/motive.live.spec.ts
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
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
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
  MOTIVE_API_KEY: 'mtv0a1b2c3d4e5f6a7b8c9d0e1f2a3b4',
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
const ok = () => mockedAxios.mockResolvedValueOnce({ status: 200, data: {}, headers: {} });

describe('motive adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the company API key as X-Api-Key to api.gomotive.com', () => {
    expect(a.slug).toBe('motive');
    expect(a.category).toBe('logistics');
    expect(a.icon).toBe('motive');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://api.gomotive.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Api-Key', apiKey: '{{MOTIVE_API_KEY}}' });
    expect(a.requiredEnvVars).toEqual(['MOTIVE_API_KEY']);
    expect(a.envVarMeta.MOTIVE_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    const pattern = new RegExp(a.envVarMeta.MOTIVE_API_KEY.pattern!);
    expect(pattern.test(ENV.MOTIVE_API_KEY)).toBe(true);
    for (const bad of ['', 'short', 'X-Api-Key: abcdefghijklmnop', 'has a space in it ok']) expect(pattern.test(bad)).toBe(false);
  });

  it('probes with one page of vehicles and explains 401, 403 and 404', () => {
    expect(a.probe).toEqual({ tool: 'motive_list_vehicles', params: { per_page: 1 } });
    expect(tool('motive_list_vehicles').parameters.required ?? []).toEqual([]);
    for (const status of ['401', '403', '404']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    expect(a.tools.length).toBeGreaterThanOrEqual(15);
    for (const name of mine) expect(name).toMatch(/^motive_[a-z0-9_]+$/);
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

  it('only reads: every tool is a GET, read-only and installed on', () => {
    for (const entry of a.tools) {
      expect(entry.endpointMapping.method).toBe('GET');
      expect(annotationsOf(entry).readOnlyHint).toBe(true);
      expect(annotationsOf(entry).destructiveHint).toBe(false);
      expect(entry.enabled).not.toBe(false);
    }
  });

  it('names every tool in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('lists vehicles with the key, default paging and bracketed id filters', async () => {
    ok();
    await call('motive_list_vehicles', { driver_ids: [11, 12], fuel_type: 'diesel' });
    const req = sent();
    expect(req.url).toBe('https://api.gomotive.com/v1/vehicles');
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(req.headers['X-Api-Key']).toBe(ENV.MOTIVE_API_KEY);
    expect(req.params).toEqual({ 'driver_ids[]': [11, 12], fuel_type: 'diesel', per_page: 25, page_no: 1 });
    expect(req.headers['X-Time-Zone']).toBeUndefined();
    expect(req.headers['X-Metric-Units']).toBeUndefined();
  });

  it('sends X-Time-Zone and X-Metric-Units only when asked, on vehicle locations', async () => {
    ok();
    await call('motive_list_vehicle_locations', {
      vehicle_ids: [23],
      vehicle_status: 'active',
      per_page: 100,
      time_zone: 'America/Chicago',
      metric_units: true,
    });
    const req = sent();
    expect(req.url).toBe('https://api.gomotive.com/v2/vehicle_locations');
    expect(req.params).toEqual({ 'vehicle_ids[]': [23], vehicle_status: 'active', per_page: 100, page_no: 1 });
    expect(req.headers['X-Time-Zone']).toBe('America/Chicago');
    expect(req.headers['X-Metric-Units']).toBe('true');
  });

  it('reads one vehicle location history with the required dates', async () => {
    expect(tool('motive_get_vehicle_location_history').parameters.required).toEqual([
      'vehicle_id',
      'start_date',
      'end_date',
    ]);
    ok();
    await call('motive_get_vehicle_location_history', { vehicle_id: 6620, start_date: '2026-10-01', end_date: '2026-10-02' });
    const req = sent();
    expect(req.url).toBe('https://api.gomotive.com/v2/vehicle_locations/6620');
    expect(req.params).toEqual({ start_date: '2026-10-01', end_date: '2026-10-02' });
  });

  it('builds the HOS, inspection, safety and IFTA requests on the documented paths', async () => {
    ok();
    await call('motive_list_available_time', { driver_ids: [5] });
    expect(sent().url).toBe('https://api.gomotive.com/v1/available_time');
    expect(sent().params).toEqual({ 'driver_ids[]': [5], per_page: 25, page_no: 1 });

    ok();
    await call('motive_list_hos_logs', { start_date: '2026-10-01', end_date: '2026-10-07' });
    expect(sent().url).toBe('https://api.gomotive.com/v1/logs');
    expect(sent().params).toEqual({ start_date: '2026-10-01', end_date: '2026-10-07', per_page: 25, page_no: 1 });

    ok();
    await call('motive_list_inspection_reports', { status: 'with_defects', vehicle_ids: [7] });
    expect(sent().url).toBe('https://api.gomotive.com/v2/inspection_reports');
    expect(sent().params).toEqual({ status: 'with_defects', 'vehicle_ids[]': [7], per_page: 25, page_no: 1 });

    ok();
    await call('motive_list_driver_performance_events', { event_types: ['hard_brake', 'cell_phone'] });
    expect(sent().url).toBe('https://api.gomotive.com/v2/driver_performance_events');
    expect(sent().params).toEqual({ 'event_types[]': ['hard_brake', 'cell_phone'], per_page: 25, page_no: 1 });

    ok();
    await call('motive_get_ifta_mileage_summary', { start_date: '2026-07-01', end_date: '2026-09-30', jurisdictions: ['TX'] });
    expect(sent().url).toBe('https://api.gomotive.com/v1/ifta/summary');
    expect(sent().params).toEqual({
      start_date: '2026-07-01',
      end_date: '2026-09-30',
      'jurisdictions[]': ['TX'],
      per_page: 25,
      page_no: 1,
    });

    ok();
    await call('motive_lookup_vehicle', { number: 'Truck 12' });
    expect(sent().url).toBe('https://api.gomotive.com/v1/vehicles/lookup');
    expect(sent().params).toEqual({ number: 'Truck 12' });
  });
});

// Opt-in: RUN_MOTIVE_LIVE=1. The refusal check needs no account; the reads
// need MOTIVE_API_KEY with read scopes for vehicles, locations and users.
const live = process.env.RUN_MOTIVE_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('Motive: live', () => {
  it('refuses a wrong key with 401', async () => {
    const response = await liveFetch.get('https://api.gomotive.com/v1/vehicles', {
      headers: { 'X-Api-Key': 'not-a-real-motive-key', Accept: 'application/json' },
      params: { per_page: 1 },
      validateStatus: () => true,
    });
    expect(response.status).toBe(401);
  });

  it('reads one page of vehicles, vehicle locations and users', async () => {
    const key = process.env.MOTIVE_API_KEY;
    if (!key) throw new Error('Set MOTIVE_API_KEY for the authenticated live check');
    const headers = { 'X-Api-Key': key, Accept: 'application/json' };
    const vehicles = await liveFetch.get('https://api.gomotive.com/v1/vehicles', {
      headers,
      params: { per_page: 1 },
      validateStatus: () => true,
    });
    expect(vehicles.status).toBe(200);
    expect(Array.isArray(vehicles.data.vehicles)).toBe(true);
    expect(vehicles.data.pagination).toMatchObject({ per_page: 1, page_no: 1 });

    const locations = await liveFetch.get('https://api.gomotive.com/v2/vehicle_locations', {
      headers,
      params: { per_page: 1 },
      validateStatus: () => true,
    });
    expect(locations.status).toBe(200);
    expect(Array.isArray(locations.data.vehicles)).toBe(true);

    const users = await liveFetch.get('https://api.gomotive.com/v1/users', {
      headers,
      params: { per_page: 1, role: 'driver' },
      validateStatus: () => true,
    });
    expect(users.status).toBe(200);
    expect(Array.isArray(users.data.users)).toBe(true);
  });
});
