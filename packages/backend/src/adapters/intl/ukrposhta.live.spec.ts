import axios from 'axios';
import * as adapter from './ukrposhta.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Ukrposhta adapter (eCom API, status tracking, address classifier and
 * label forms on www.ukrposhta.ua).
 *
 * Static checks always run: the two bearers (eCom on shipments, clients,
 * address classifier and forms; StatusTracking on tracking), the counterparty
 * token on the calls about your clients and shipments, every tool's method
 * and path against Ukrposhta's documentation (dev.ukrposhta.ua: API
 * documentation 09.03.2026, Status tracking 10.03.2025, Address classifier
 * 3.20, and the Swagger at app.swaggerhub.com/apis-docs/Ukrpost/ukrpost-api),
 * the request bodies, and that creating and deleting shipments install
 * switched off.
 *
 * Live checks run only with RUN_UKRPOSHTA_LIVE=1 and the three production
 * keys; UKRPOSHTA_BARCODE adds a tracking read. Reads only. Not run for the
 * first version: no Ukrposhta contract was available.
 *
 *   RUN_UKRPOSHTA_LIVE=1 UKRPOSHTA_ECOM_BEARER=... UKRPOSHTA_TRACKING_BEARER=... \
 *     UKRPOSHTA_COUNTERPARTY_TOKEN=... npx jest src/adapters/intl/ukrposhta.live.spec.ts
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
  ukrposhta_track_shipment: ['GET', '/status-tracking/0.0.1/statuses'],
  ukrposhta_get_last_status: ['GET', '/status-tracking/0.0.1/statuses/last'],
  ukrposhta_get_last_statuses: ['POST', '/status-tracking/0.0.1/statuses/last/with-not-found'],
  ukrposhta_get_shipment_route: ['GET', '/status-tracking/0.0.1/barcodes/{barcode}/route'],
  ukrposhta_get_shipment: ['GET', '/ecom/0.0.1/shipments/{shipment_uuid}'],
  ukrposhta_get_shipment_by_barcode: ['GET', '/ecom/0.0.1/shipments/barcode/{barcode}'],
  ukrposhta_list_sender_shipments: ['GET', '/ecom/0.0.1/shipments'],
  ukrposhta_get_shipment_lifecycle: ['GET', '/ecom/0.0.1/shipments/{shipment}/lifecycle'],
  ukrposhta_list_shipment_groups: ['GET', '/ecom/0.0.1/shipment-groups/clients/{client_uuid}'],
  ukrposhta_list_group_shipments: ['GET', '/ecom/0.0.1/shipment-groups/{group_uuid}/shipments'],
  ukrposhta_get_label: ['GET', '/forms/ecom/0.0.1/shipments/{shipment}/sticker'],
  ukrposhta_calculate_domestic_price: ['POST', '/ecom/0.0.1/domestic/delivery-price'],
  ukrposhta_check_route: ['GET', '/ecom/0.0.1/addresses/availability-checking/from/{from_postcode}/to/{to_postcode}'],
  ukrposhta_get_client: ['GET', '/ecom/0.0.1/clients/{client_uuid}'],
  ukrposhta_find_clients_by_phone: ['GET', '/ecom/0.0.1/clients/phone'],
  ukrposhta_get_address: ['GET', '/ecom/0.0.1/addresses/{address_id}'],
  ukrposhta_create_address: ['POST', '/ecom/0.0.1/addresses'],
  ukrposhta_create_client: ['POST', '/ecom/0.0.1/clients'],
  ukrposhta_create_shipment: ['POST', '/ecom/0.0.1/shipments'],
  ukrposhta_delete_shipment: ['DELETE', '/ecom/0.0.1/shipments/{shipment_uuid}'],
  ukrposhta_find_post_offices_by_postcode: ['GET', '/address-classifier-ws/get_postoffices_by_postindex'],
  ukrposhta_find_post_offices_near: ['GET', '/address-classifier-ws/get_postoffices_by_geolocation'],
  ukrposhta_get_post_office_hours: ['GET', '/address-classifier-ws/get_postoffices_openhours_by_postindex'],
  ukrposhta_get_city_by_postcode: ['GET', '/address-classifier-ws/get_city_details_by_postcode'],
  ukrposhta_search_regions: ['GET', '/address-classifier-ws/get_regions_by_region_ua'],
  ukrposhta_search_districts: ['GET', '/address-classifier-ws/get_district_by_name'],
  ukrposhta_search_cities: ['GET', '/address-classifier-ws/get_city_by_name'],
  ukrposhta_search_streets: ['GET', '/address-classifier-ws/get_street_by_name'],
  ukrposhta_get_house_postcode: ['GET', '/address-classifier-ws/get_addr_house_by_street_id'],
};
// Tools that change spend, buy, cancel or delete: installed switched off.
const OFF = ['ukrposhta_create_shipment', 'ukrposhta_delete_shipment'];
// POST tools that only read (searches, reports, price estimates).
const READ_POSTS = ['ukrposhta_calculate_domestic_price', 'ukrposhta_get_last_statuses'];

// Built at runtime so no literal looks like a real credential.
const ENV: Record<string, string> = {
  UKRPOSHTA_ECOM_BEARER: ['11111111', '2222', '3333', 'aaaa', 'bcdef1234567'].join('-'),
  UKRPOSHTA_TRACKING_BEARER: ['44444444', '5555', '6666', 'bbbb', 'cdef12345678'].join('-'),
  UKRPOSHTA_COUNTERPARTY_TOKEN: ['77777777', '8888', '9999', 'cccc', 'def123456789'].join('-'),
};

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping as never,
    ENV,
  );
  const tokens = { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService;
  return new RestEngine(tokens, {} as LoginTokenService).execute(
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

describe('ukrposhta adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('has the catalog envelope', () => {
    expect(a.slug).toBe('ukrposhta');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('logistics');
    expect(a.icon).toBe('ukrposhta');
    expect(a.docsUrl).toBe('https://dev.ukrposhta.ua/documentation');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://www.ukrposhta.ua');
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
    for (const name of mine) expect(name).toMatch(/^ukrposhta_[a-z0-9_]+$/);
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
    expect(a.probe).toEqual({ tool: 'ukrposhta_find_post_offices_by_postcode', params: { postcode: '01001' } });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).enabled).not.toBe(false);
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('sends the right bearer per service and the counterparty token on account calls', () => {
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.headers?.Authorization).toBeUndefined();
    const noToken = ['/ecom/0.0.1/addresses', '/ecom/0.0.1/domestic/delivery-price'];
    for (const entry of a.tools) {
      const path = entry.endpointMapping.path;
      const bearer = path.startsWith('/status-tracking/') ? 'UKRPOSHTA_TRACKING_BEARER' : 'UKRPOSHTA_ECOM_BEARER';
      expect([entry.name, entry.endpointMapping.headers]).toEqual([entry.name, { Authorization: `Bearer {{${bearer}}}` }]);
      const wantsToken =
        (path.startsWith('/ecom/') || path.startsWith('/forms/')) && !noToken.some((p) => path.startsWith(p));
      expect([entry.name, entry.endpointMapping.queryParams?.token]).toEqual([
        entry.name,
        wantsToken ? '{{UKRPOSHTA_COUNTERPARTY_TOKEN}}' : undefined,
      ]);
    }
  });

  it('tracks with the StatusTracking bearer', async () => {
    ok([]);
    await call('ukrposhta_track_shipment', { barcode: '0500100031143', lang: 'en' });
    const req = sent();
    expect(req.url).toBe('https://www.ukrposhta.ua/status-tracking/0.0.1/statuses');
    expect(header(req, 'Authorization')).toBe(`Bearer ${ENV.UKRPOSHTA_TRACKING_BEARER}`);
    expect(req.params).toEqual({ barcode: '0500100031143', lang: 'en' });

    ok([]);
    await call('ukrposhta_get_last_statuses', { barcodes: ['0500100031143', 'RA067022855UA'] });
    expect(sent().url).toBe('https://www.ukrposhta.ua/status-tracking/0.0.1/statuses/last/with-not-found');
    expect(sent().data).toEqual(['0500100031143', 'RA067022855UA']);
  });

  it('reads shipments with the eCom bearer and the counterparty token', async () => {
    ok({});
    await call('ukrposhta_get_shipment_by_barcode', { barcode: '0503315033383' });
    const req = sent();
    expect(req.url).toBe('https://www.ukrposhta.ua/ecom/0.0.1/shipments/barcode/0503315033383');
    expect(header(req, 'Authorization')).toBe(`Bearer ${ENV.UKRPOSHTA_ECOM_BEARER}`);
    expect(req.params).toEqual({ token: ENV.UKRPOSHTA_COUNTERPARTY_TOKEN });

    ok({});
    await call('ukrposhta_get_label', { shipment: '0503315033383', size: 'SIZE_A4' });
    expect(sent().url).toBe('https://www.ukrposhta.ua/forms/ecom/0.0.1/shipments/0503315033383/sticker');
    expect(sent().params).toEqual({ token: ENV.UKRPOSHTA_COUNTERPARTY_TOKEN, size: 'SIZE_A4' });
  });

  it('queries the address classifier with its documented parameter names', async () => {
    ok({});
    await call('ukrposhta_find_post_offices_by_postcode', { postcode: '01001' });
    expect(sent().url).toBe('https://www.ukrposhta.ua/address-classifier-ws/get_postoffices_by_postindex');
    expect(sent().params).toEqual({ pi: '01001' });

    ok({});
    await call('ukrposhta_find_post_offices_near', { lat: 50.45, long: 30.52 });
    expect(sent().params).toEqual({ lat: 50.45, long: 30.52, maxdistance: 5 });
  });

  it('builds the price estimate and the switched-off shipment like the documented examples', async () => {
    ok({});
    await call('ukrposhta_calculate_domestic_price', { from_postcode: '04071', to_postcode: '07401', weight: 1200, length: 30, width: 20, height: 10 });
    expect(sent().url).toBe('https://www.ukrposhta.ua/ecom/0.0.1/domestic/delivery-price');
    expect(sent().data).toEqual({
      addressFrom: { postcode: '04071' },
      addressTo: { postcode: '07401' },
      type: 'STANDARD',
      deliveryType: 'W2W',
      weight: 1200,
      length: 30,
      width: 20,
      height: 10,
      parcels: [{ weight: 1200, length: 30, width: 20, height: 10 }],
    });

    const sender = '3b699af0-276b-4c94-8bef-2bb63a01099f';
    const recipient = '2e88b642-06ab-44e5-9a28-7acab533ed88';
    ok({});
    await call('ukrposhta_create_shipment', { sender_uuid: sender, recipient_uuid: recipient, weight: 1200, length: 170, delivery_type: 'W2D', paid_by_recipient: true });
    expect(sent().url).toBe('https://www.ukrposhta.ua/ecom/0.0.1/shipments');
    expect(sent().data).toEqual({
      sender: { uuid: sender },
      recipient: { uuid: recipient },
      type: 'STANDARD',
      deliveryType: 'W2D',
      paidByRecipient: true,
      parcels: [{ weight: 1200, length: 170 }],
    });
  });
});

// Opt-in: RUN_UKRPOSHTA_LIVE=1 with the three production keys from the
// contract annex. Nothing is written.
const live = process.env.RUN_UKRPOSHTA_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('ukrposhta: live', () => {
  const ecom = process.env.UKRPOSHTA_ECOM_BEARER;
  const tracking = process.env.UKRPOSHTA_TRACKING_BEARER;

  it('reads the post offices of a postcode with the eCom bearer', async () => {
    if (!ecom) throw new Error('Set UKRPOSHTA_ECOM_BEARER for the live check');
    const response = await liveFetch.get('https://www.ukrposhta.ua/address-classifier-ws/get_postoffices_by_postindex', {
      headers: { Authorization: `Bearer ${ecom}`, Accept: 'application/json' },
      params: { pi: '01001' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
  });

  it('reads the last status of a barcode with the StatusTracking bearer', async () => {
    const barcode = process.env.UKRPOSHTA_BARCODE;
    if (!tracking || !barcode) return;
    const response = await liveFetch.get('https://www.ukrposhta.ua/status-tracking/0.0.1/statuses/last', {
      headers: { Authorization: `Bearer ${tracking}`, Accept: 'application/json' },
      params: { barcode },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
  });
});
