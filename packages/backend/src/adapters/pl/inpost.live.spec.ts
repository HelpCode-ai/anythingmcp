import axios from 'axios';
import * as adapter from './inpost.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * InPost ShipX adapter (lockers and points, services, shipments, tracking,
 * labels, price calculation, dispatch orders, COD report; creating and buying
 * shipments and ordering a courier switched off).
 *
 * Static checks always run: the bearer token, the organisation id in the path
 * (a connector variable, never a tool argument), every tool's method and path
 * against InPost's ShipX documentation
 * (dokumentacja-inpost.atlassian.net, "API ShipX ENG Documentation"), the
 * request bodies, and which tools install switched off. A shipment created in
 * simplified mode is bought in the same call, so creation is off as well.
 *
 * Live checks run only with RUN_INPOST_LIVE=1. Without credentials they read
 * the public status list and confirm that a wrong token is refused; with
 * INPOST_TOKEN and INPOST_ORGANIZATION_ID they read the organisation and one
 * page of shipments. Reads only.
 *
 *   RUN_INPOST_LIVE=1 INPOST_TOKEN=... INPOST_ORGANIZATION_ID=... \
 *     npx jest src/adapters/pl/inpost.live.spec.ts
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
  region: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string | { hint: string; field?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({ name: entry.name, connectorType: 'REST', endpointMapping: entry.endpointMapping, annotations: entry.annotations });
const used = (entry: Tool) => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) out.add(p);
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
  INPOST_TOKEN: 'eyJhbGciOiJSUzI1NiIsInR5cCIgOiAiSldUIn0.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl',
  INPOST_ORGANIZATION_ID: '12345',
};
const BASE = 'https://api-shipx-pl.easypack24.net';
const ORG = '/v1/organizations/{{INPOST_ORGANIZATION_ID}}';

/** Method and path of every tool, as on InPost's ShipX documentation pages. */
const ROUTES: Record<string, [string, string]> = {
  inpost_get_organization: ['GET', ORG],
  inpost_search_points: ['GET', 'https://api.inpost.pl/v1/points'],
  inpost_list_services: ['GET', '/v1/services'],
  inpost_list_sending_methods: ['GET', '/v1/sending_methods'],
  inpost_list_statuses: ['GET', '/v1/statuses'],
  inpost_list_shipments: ['GET', `${ORG}/shipments`],
  inpost_get_shipment: ['GET', '/v1/shipments/{shipment_id}'],
  inpost_track_shipment: ['GET', '/v1/tracking/{tracking_number}'],
  inpost_calculate_shipment_prices: ['POST', `${ORG}/shipments/calculate`],
  inpost_get_shipment_label: ['GET', '/v1/shipments/{shipment_id}/label'],
  inpost_list_dispatch_orders: ['GET', `${ORG}/dispatch_orders`],
  inpost_get_dispatch_order: ['GET', '/v1/dispatch_orders/{dispatch_order_id}'],
  inpost_calculate_dispatch_order_price: ['POST', `${ORG}/dispatch_orders/calculate`],
  inpost_get_cod_report: ['GET', `${ORG}/reports/cod`],
  inpost_create_shipment: ['POST', `${ORG}/shipments`],
  inpost_buy_shipment: ['POST', '/v1/shipments/{shipment_id}/buy'],
  inpost_cancel_shipment: ['DELETE', '/v1/shipments/{shipment_id}'],
  inpost_create_dispatch_order: ['POST', `${ORG}/dispatch_orders`],
  inpost_cancel_dispatch_order: ['DELETE', '/v1/dispatch_orders/{dispatch_order_id}'],
};
const REQUIRED: Record<string, string[]> = {
  inpost_get_organization: [],
  inpost_search_points: [],
  inpost_list_services: [],
  inpost_list_sending_methods: [],
  inpost_list_statuses: [],
  inpost_list_shipments: [],
  inpost_get_shipment: ['shipment_id'],
  inpost_track_shipment: ['tracking_number'],
  inpost_calculate_shipment_prices: ['shipments'],
  inpost_get_shipment_label: ['shipment_id'],
  inpost_list_dispatch_orders: [],
  inpost_get_dispatch_order: ['dispatch_order_id'],
  inpost_calculate_dispatch_order_price: ['shipments'],
  inpost_get_cod_report: ['start_date', 'end_date'],
  inpost_create_shipment: ['service', 'receiver', 'parcels'],
  inpost_buy_shipment: ['shipment_id', 'offer_id'],
  inpost_cancel_shipment: ['shipment_id'],
  inpost_create_dispatch_order: ['shipments', 'address', 'name', 'phone'],
  inpost_cancel_dispatch_order: ['dispatch_order_id'],
};
const SWITCHED_OFF = [
  'inpost_buy_shipment',
  'inpost_cancel_dispatch_order',
  'inpost_cancel_shipment',
  'inpost_create_dispatch_order',
  'inpost_create_shipment',
];

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
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
const ok = (status = 200) => mockedAxios.mockResolvedValueOnce({ status, data: {}, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

const RECEIVER = { email: 'receiver@example.com', phone: '888000000' };

describe('inpost adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('uses a bearer token on the ShipX production host, with the organisation id as a connector variable', () => {
    expect(a.slug).toBe('inpost');
    expect(a.region).toBe('pl');
    expect(a.category).toBe('logistics');
    expect(a.icon).toBe('inpost');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{INPOST_TOKEN}}' });
    expect(a.connector.headers).toMatchObject({ 'Accept-Language': 'en_GB' });
    expect(a.requiredEnvVars).toEqual(['INPOST_TOKEN', 'INPOST_ORGANIZATION_ID']);
    expect(a.envVarMeta.INPOST_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.INPOST_ORGANIZATION_ID.secret).toBeUndefined();
    for (const name of a.requiredEnvVars) expect(new RegExp(a.envVarMeta[name].pattern!).test(ENV[name])).toBe(true);
    for (const bad of ['', 'Bearer abc.def.ghi-0123456789', 'has space inside the token value']) {
      expect(new RegExp(a.envVarMeta.INPOST_TOKEN.pattern!).test(bad)).toBe(false);
    }
    for (const bad of ['', 'org-1', '12 345']) expect(new RegExp(a.envVarMeta.INPOST_ORGANIZATION_ID.pattern!).test(bad)).toBe(false);
    // No tool lets the model choose the organisation.
    for (const entry of a.tools) expect(Object.keys(entry.parameters.properties ?? {})).not.toContain('organization_id');
  });

  it('probes the organisation and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'inpost_get_organization', params: {} });
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    expect(a.verifyHints['404']).toMatchObject({ field: 'INPOST_ORGANIZATION_ID' });
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^inpost_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(declared.has(arg) || envNames.has(arg)).toBe(true);
      for (const arg of declared) expect(used(entry).has(arg)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(60);
    }
  });

  it('maps every tool to the method and path of the ShipX documentation', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const entry of a.tools) {
      expect([entry.endpointMapping.method, entry.endpointMapping.path]).toEqual(ROUTES[entry.name]);
      expect(entry.parameters.required ?? []).toEqual(REQUIRED[entry.name]);
    }
  });

  it('installs everything that buys, cancels or orders a courier switched off, and marks the rest read-only', () => {
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(SWITCHED_OFF);
    for (const entry of a.tools) {
      const isOff = entry.enabled === false;
      expect(annotationsOf(entry).readOnlyHint).toBe(!isOff);
      expect(/switched off/.test(entry.description)).toBe(isOff);
    }
    // The only enabled POSTs are the two price calculations.
    const enabledWrites = a.tools.filter((entry) => entry.enabled !== false && entry.endpointMapping.method !== 'GET');
    expect(enabledWrites.map((entry) => entry.name).sort()).toEqual(['inpost_calculate_dispatch_order_price', 'inpost_calculate_shipment_prices']);
    for (const entry of enabledWrites) expect(entry.endpointMapping.path.endsWith('/calculate')).toBe(true);
  });

  it('names every tool in the instructions and keeps them free of MDX-breaking characters', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions.startsWith('## InPost')).toBe(true);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.replace(/`[^`]*`/g, '')).not.toMatch(/[{}<]/);
    for (const entry of a.tools) expect(entry.description.replace(/`[^`]*`/g, '')).not.toMatch(/[{}<]/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('reads the organisation and the shipment list with the bearer token and the organisation id in the path', async () => {
    ok();
    await call('inpost_get_organization', {});
    const req = sent();
    expect(req.url).toBe(`${BASE}/v1/organizations/12345`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Authorization')).toBe(`Bearer ${ENV.INPOST_TOKEN}`);
    expect(header(req, 'Accept-Language')).toBe('en_GB');

    ok();
    await call('inpost_list_shipments', { status: 'confirmed', service: 'inpost_locker_standard' });
    expect(sent().url).toBe(`${BASE}/v1/organizations/12345/shipments`);
    expect(sent().params).toEqual({ status: 'confirmed', service: 'inpost_locker_standard', page: 1, per_page: 25 });

    ok();
    await call('inpost_list_dispatch_orders', { status: 'new' });
    expect(sent().url).toBe(`${BASE}/v1/organizations/12345/dispatch_orders`);
    expect(sent().params).toEqual({ status: 'new', page: 1, per_page: 25 });

    ok();
    await call('inpost_get_cod_report', { start_date: '2026-11-01', end_date: '2026-11-14' });
    expect(sent().url).toBe(`${BASE}/v1/organizations/12345/reports/cod`);
    expect(sent().params).toEqual({ format: 'csv', start_date: '2026-11-01', end_date: '2026-11-14' });
  });

  it('reads shipments, tracking, labels and reference data on the documented paths', async () => {
    ok();
    await call('inpost_get_shipment', { shipment_id: '4257799' });
    expect(sent().url).toBe(`${BASE}/v1/shipments/4257799`);

    ok();
    await call('inpost_track_shipment', { tracking_number: '632085946340007012341234' });
    expect(sent().url).toBe(`${BASE}/v1/tracking/632085946340007012341234`);

    ok();
    await call('inpost_get_shipment_label', { shipment_id: '4257799', type: 'A6' });
    expect(sent().url).toBe(`${BASE}/v1/shipments/4257799/label`);
    expect(sent().params).toEqual({ format: 'Pdf', type: 'A6' });

    ok();
    await call('inpost_list_statuses', {});
    expect(sent().url).toBe(`${BASE}/v1/statuses`);
    expect(sent().params).toEqual({ lang: 'en_GB' });

    ok();
    await call('inpost_list_sending_methods', { service: 'inpost_locker_standard' });
    expect(sent().url).toBe(`${BASE}/v1/sending_methods`);
    expect(sent().params).toEqual({ service: 'inpost_locker_standard' });

    ok();
    await call('inpost_get_dispatch_order', { dispatch_order_id: '24' });
    expect(sent().url).toBe(`${BASE}/v1/dispatch_orders/24`);
  });

  it('searches points on the points host, nearest first when asked', async () => {
    ok();
    await call('inpost_search_points', { relative_post_code: '00-718', sort_by: 'distance_to_relative_point', max_distance: 2000, type: 'parcel_locker' });
    const req = sent();
    expect(req.url).toBe('https://api.inpost.pl/v1/points');
    expect(header(req, 'Authorization')).toBe(`Bearer ${ENV.INPOST_TOKEN}`);
    expect(req.params).toEqual({
      relative_post_code: '00-718',
      sort_by: 'distance_to_relative_point',
      max_distance: 2000,
      type: 'parcel_locker',
      page: 1,
      per_page: 10,
    });
  });

  it('builds the price calculations and the switched-off writes as InPost documents them', async () => {
    const shipments = [{ id: 'SHIPMENT1', service: 'inpost_locker_standard', receiver: RECEIVER, parcels: { template: 'small' }, custom_attributes: { target_point: 'KRA010' } }];
    ok();
    await call('inpost_calculate_shipment_prices', { shipments });
    expect(sent().url).toBe(`${BASE}/v1/organizations/12345/shipments/calculate`);
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({ shipments });

    ok();
    await call('inpost_calculate_dispatch_order_price', { shipments: [24907, 24908] });
    expect(sent().url).toBe(`${BASE}/v1/organizations/12345/dispatch_orders/calculate`);
    expect(sent().data).toEqual({ shipments: [24907, 24908] });

    ok(201);
    await call('inpost_create_shipment', {
      service: 'inpost_locker_standard',
      receiver: RECEIVER,
      parcels: [{ template: 'small' }],
      custom_attributes: { target_point: 'KRA010' },
      reference: 'ORDER-1001',
    });
    expect(sent().url).toBe(`${BASE}/v1/organizations/12345/shipments`);
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({
      service: 'inpost_locker_standard',
      receiver: RECEIVER,
      parcels: [{ template: 'small' }],
      custom_attributes: { target_point: 'KRA010' },
      reference: 'ORDER-1001',
    });

    ok();
    await call('inpost_buy_shipment', { shipment_id: '4257799', offer_id: 1456 });
    expect(sent().url).toBe(`${BASE}/v1/shipments/4257799/buy`);
    expect(sent().data).toEqual({ offer_id: 1456 });

    ok(204);
    await call('inpost_cancel_shipment', { shipment_id: '4257799' });
    expect(String(sent().method).toUpperCase()).toBe('DELETE');
    expect(sent().url).toBe(`${BASE}/v1/shipments/4257799`);

    const address = { street: 'Malborska', building_number: '130', city: 'Krakow', post_code: '31-209', country_code: 'PL' };
    ok(201);
    await call('inpost_create_dispatch_order', { shipments: ['1', '2'], address, name: 'Warehouse', phone: '505404202' });
    expect(sent().url).toBe(`${BASE}/v1/organizations/12345/dispatch_orders`);
    expect(sent().data).toEqual({ shipments: ['1', '2'], name: 'Warehouse', phone: '505404202', address });

    ok(204);
    await call('inpost_cancel_dispatch_order', { dispatch_order_id: '24' });
    expect(String(sent().method).toUpperCase()).toBe('DELETE');
    expect(sent().url).toBe(`${BASE}/v1/dispatch_orders/24`);
  });
});

// Opt-in: RUN_INPOST_LIVE=1. The first two checks need no account; the reads
// need INPOST_TOKEN and INPOST_ORGANIZATION_ID of a production organisation.
// Nothing is written.
const live = process.env.RUN_INPOST_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('inpost: live', () => {
  it('lists the statuses without a token', async () => {
    const response = await liveFetch.get(`${BASE}/v1/statuses`, { params: { lang: 'en_GB' }, headers: { Accept: 'application/json' } });
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.data)).toContain('ready_to_pickup');
  });

  it('refuses a wrong token', async () => {
    const response = await liveFetch.get(`${BASE}/v1/organizations/1`, {
      headers: { Authorization: 'Bearer not-a-token', Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect([401, 403]).toContain(response.status);
  });

  it('reads the organisation and one page of shipments', async () => {
    const token = process.env.INPOST_TOKEN;
    const organization = process.env.INPOST_ORGANIZATION_ID;
    if (!token || !organization) return;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Accept-Language': 'en_GB' };
    const org = await liveFetch.get(`${BASE}/v1/organizations/${organization}`, { headers });
    expect(org.status).toBe(200);
    expect(String(org.data.id)).toBe(organization);
    const shipments = await liveFetch.get(`${BASE}/v1/organizations/${organization}/shipments`, { headers, params: { per_page: 5 } });
    expect(shipments.status).toBe(200);
    expect(Array.isArray(shipments.data.items)).toBe(true);
  });
});
