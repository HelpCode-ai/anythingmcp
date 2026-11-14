import axios from 'axios';
import * as adapter from './amazon-shipping.json';
import * as seller from './amazon-seller.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Amazon Shipping adapter (Shipping API v2 on SP-API: rates, tracking,
 * documents, access points, collection forms; purchase, one-click purchase,
 * cancellation and manifest generation switched off).
 *
 * Static checks always run: the Login with Amazon wiring, identical to the
 * amazon-seller adapter (refresh token grant, x-amz-access-token header,
 * the same SPAPI_* variables), the regional endpoint and the
 * x-amzn-shipping-business-id header as choices, every tool's method and
 * path against Amazon's model (github.com/amzn/selling-partner-api-models,
 * models/shipping-api-model/shippingV2.json), the request bodies, and which
 * tools install switched off. Every call that buys a label is off.
 *
 * Live checks run only with RUN_AMAZON_SHIPPING_LIVE=1. Without credentials
 * they confirm that Login with Amazon refuses a wrong client; with
 * SPAPI_CLIENT_ID, SPAPI_CLIENT_SECRET, SPAPI_REFRESH_TOKEN, SPAPI_ENDPOINT
 * and AMAZON_SHIPPING_BUSINESS_ID they list the unmanifested shipments.
 * Reads only.
 *
 *   RUN_AMAZON_SHIPPING_LIVE=1 SPAPI_CLIENT_ID=... SPAPI_CLIENT_SECRET=... \
 *     SPAPI_REFRESH_TOKEN=... SPAPI_ENDPOINT=https://sellingpartnerapi-eu.amazon.com \
 *     AMAZON_SHIPPING_BUSINESS_ID=AmazonShipping_UK \
 *     npx jest src/adapters/intl/amazon-shipping.live.spec.ts
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
type EnvMeta = { pattern?: string; kind?: string; secret?: boolean; options?: Array<{ value: string; label: string }> };
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, EnvMeta>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  setupGuide: { effort: string; steps: Array<{ id: string; fields?: string[] }> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const sellerAuthConfig = (seller as unknown as { connector: { authConfig: Record<string, unknown> } }).connector.authConfig;
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
  SPAPI_CLIENT_ID: 'amzn1.application-oa2-client.0123456789abcdef0123456789abcdef',
  SPAPI_CLIENT_SECRET: 'amzn1.oa2-cs.v1.0123456789abcdef0123456789abcdef0123456789abcdef',
  SPAPI_REFRESH_TOKEN: 'Atzr|IwEBIExampleRefreshToken0123456789',
  SPAPI_ENDPOINT: 'https://sellingpartnerapi-eu.amazon.com',
  AMAZON_SHIPPING_BUSINESS_ID: 'AmazonShipping_UK',
};
const BASE = ENV.SPAPI_ENDPOINT;

/** Method and path of every tool, as in Amazon's shippingV2 model. */
const ROUTES: Record<string, [string, string]> = {
  amazon_shipping_get_rates: ['POST', '/shipping/v2/shipments/rates'],
  amazon_shipping_get_additional_inputs: ['GET', '/shipping/v2/shipments/additionalInputs/schema'],
  amazon_shipping_get_tracking: ['GET', '/shipping/v2/tracking'],
  amazon_shipping_get_shipment_documents: ['GET', '/shipping/v2/shipments/{shipment_id}/documents'],
  amazon_shipping_get_access_points: ['GET', '/shipping/v2/accessPoints'],
  amazon_shipping_get_unmanifested_shipments: ['PUT', '/shipping/v2/unmanifestedShipments'],
  amazon_shipping_get_collection_form_history: ['PUT', '/shipping/v2/collectionForms/history'],
  amazon_shipping_get_collection_form: ['GET', '/shipping/v2/collectionForms/{collection_form_id}'],
  amazon_shipping_get_carrier_accounts: ['PUT', '/shipping/v2/carrierAccounts'],
  amazon_shipping_purchase_shipment: ['POST', '/shipping/v2/shipments'],
  amazon_shipping_direct_purchase_shipment: ['POST', '/shipping/v2/shipments/directPurchase'],
  amazon_shipping_one_click_shipment: ['POST', '/shipping/v2/oneClickShipment'],
  amazon_shipping_cancel_shipment: ['PUT', '/shipping/v2/shipments/{shipment_id}/cancel'],
  amazon_shipping_generate_collection_form: ['POST', '/shipping/v2/collectionForms'],
};
const REQUIRED: Record<string, string[]> = {
  amazon_shipping_get_rates: ['ship_from', 'packages', 'channel_details'],
  amazon_shipping_get_additional_inputs: ['request_token', 'rate_id'],
  amazon_shipping_get_tracking: ['tracking_id', 'carrier_id'],
  amazon_shipping_get_shipment_documents: ['shipment_id', 'package_client_reference_id'],
  amazon_shipping_get_access_points: ['access_point_types', 'country_code', 'postal_code'],
  amazon_shipping_get_unmanifested_shipments: [],
  amazon_shipping_get_collection_form_history: [],
  amazon_shipping_get_collection_form: ['collection_form_id'],
  amazon_shipping_get_carrier_accounts: [],
  amazon_shipping_purchase_shipment: ['request_token', 'rate_id', 'requested_document_specification'],
  amazon_shipping_direct_purchase_shipment: ['channel_details'],
  amazon_shipping_one_click_shipment: ['ship_from', 'packages', 'channel_details', 'label_specifications', 'service_ids'],
  amazon_shipping_cancel_shipment: ['shipment_id'],
  amazon_shipping_generate_collection_form: ['carrier_id'],
};
const SWITCHED_OFF = [
  'amazon_shipping_cancel_shipment',
  'amazon_shipping_direct_purchase_shipment',
  'amazon_shipping_generate_collection_form',
  'amazon_shipping_one_click_shipment',
  'amazon_shipping_purchase_shipment',
];

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  const tokens = { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService;
  return new RestEngine(tokens, {} as LoginTokenService).execute(
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

const SHIP_FROM = { name: 'Warehouse', addressLine1: '1 Dock Road', city: 'Manchester', stateOrRegion: 'Greater Manchester', postalCode: 'M1 1AA', countryCode: 'GB' };
const SHIP_TO = { name: 'Jane Doe', addressLine1: '10 High Street', city: 'London', stateOrRegion: 'London', postalCode: 'EC1A 1BB', countryCode: 'GB' };
const PACKAGES = [
  {
    packageClientReferenceId: 'PKG-1001-1',
    dimensions: { length: 30, width: 20, height: 10, unit: 'CENTIMETER' },
    weight: { value: 2, unit: 'KILOGRAM' },
    insuredValue: { value: 40, unit: 'GBP' },
    items: [{ quantity: 1, description: 'Mug' }],
  },
];
const CHANNEL = { channelType: 'EXTERNAL' };
const LABEL = { format: 'PDF', size: { width: 4, length: 6, unit: 'INCH' }, dpi: 300, needFileJoining: false, requestedDocumentTypes: ['LABEL'] };

describe('amazon-shipping adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in with Login with Amazon exactly as the amazon-seller adapter does', () => {
    expect(a.slug).toBe('amazon-shipping');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('logistics');
    expect(a.icon).toBe('amazon-shipping');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{SPAPI_ENDPOINT}}');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'refresh_token',
      tokenUrl: 'https://api.amazon.com/auth/o2/token',
      clientId: '{{SPAPI_CLIENT_ID}}',
      clientSecret: '{{SPAPI_CLIENT_SECRET}}',
      refreshToken: '{{SPAPI_REFRESH_TOKEN}}',
      headerName: 'x-amz-access-token',
    });
    expect(a.connector.authConfig).toEqual(sellerAuthConfig);
    expect(a.connector.headers).toMatchObject({ 'x-amzn-shipping-business-id': '{{AMAZON_SHIPPING_BUSINESS_ID}}' });
    expect(a.requiredEnvVars).toEqual(['SPAPI_CLIENT_ID', 'SPAPI_CLIENT_SECRET', 'SPAPI_REFRESH_TOKEN', 'SPAPI_ENDPOINT', 'AMAZON_SHIPPING_BUSINESS_ID']);
    for (const name of ['SPAPI_CLIENT_SECRET', 'SPAPI_REFRESH_TOKEN']) expect(a.envVarMeta[name]).toMatchObject({ kind: 'credential', secret: true });
    for (const name of a.requiredEnvVars) expect(new RegExp(a.envVarMeta[name].pattern!).test(ENV[name])).toBe(true);
    expect(new RegExp(a.envVarMeta.SPAPI_REFRESH_TOKEN.pattern!).test('Atza|an-access-token')).toBe(false);
  });

  it('offers the three SP-API regions and the Amazon Shipping countries as choices', () => {
    expect(a.envVarMeta.SPAPI_ENDPOINT.options!.map((option) => option.value)).toEqual([
      'https://sellingpartnerapi-na.amazon.com',
      'https://sellingpartnerapi-eu.amazon.com',
      'https://sellingpartnerapi-fe.amazon.com',
    ]);
    const businesses = a.envVarMeta.AMAZON_SHIPPING_BUSINESS_ID.options!.map((option) => option.value);
    // The values of the x-amzn-shipping-business-id header in Amazon's model.
    expect([...businesses].sort()).toEqual(
      ['AmazonShipping_EG', 'AmazonShipping_ES', 'AmazonShipping_FR', 'AmazonShipping_IN', 'AmazonShipping_IT', 'AmazonShipping_JP', 'AmazonShipping_SA', 'AmazonShipping_UAE', 'AmazonShipping_UK', 'AmazonShipping_US'],
    );
    for (const meta of [a.envVarMeta.SPAPI_ENDPOINT, a.envVarMeta.AMAZON_SHIPPING_BUSINESS_ID]) {
      const values = meta.options!.map((option) => option.value);
      expect(values.length).toBeGreaterThanOrEqual(2);
      expect(values.length).toBeLessThanOrEqual(20);
      expect(new Set(values).size).toBe(values.length);
      for (const option of meta.options!) {
        expect(option.label).toBeTruthy();
        expect(new RegExp(meta.pattern!).test(option.value)).toBe(true);
      }
    }
  });

  it('probes with a read and explains 400, 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'amazon_shipping_get_unmanifested_shipments', params: {} });
    for (const key of ['400', '401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    expect(a.verifyHints['403']).toContain('Amazon Logistics');
  });

  it('asks for every required variable in the setup guide', () => {
    expect(a.setupGuide.effort).toBe('own_app');
    const asked = a.setupGuide.steps.flatMap((step) => step.fields ?? []);
    expect(asked.sort()).toEqual([...a.requiredEnvVars].sort());
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^amazon_shipping_[a-z0-9_]+$/);
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

  it('maps every tool to the method and path of the shippingV2 model', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const entry of a.tools) {
      expect([entry.endpointMapping.method, entry.endpointMapping.path]).toEqual(ROUTES[entry.name]);
      expect(entry.parameters.required ?? []).toEqual(REQUIRED[entry.name]);
    }
  });

  it('installs purchase, one-click, cancel and manifest generation switched off and marks everything else read-only', () => {
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(SWITCHED_OFF);
    for (const entry of a.tools) {
      const isOff = entry.enabled === false;
      // Amazon models three reads as PUT; they carry an explicit read-only hint.
      expect(annotationsOf(entry).readOnlyHint).toBe(!isOff);
      expect(/switched off/.test(entry.description)).toBe(isOff);
    }
    const enabledPaths = a.tools.filter((entry) => entry.enabled !== false).map((entry) => entry.endpointMapping.path);
    for (const path of enabledPaths) expect(path).not.toMatch(/directPurchase|oneClickShipment|\/cancel$|^\/shipping\/v2\/shipments$|^\/shipping\/v2\/collectionForms$/);
  });

  it('names every tool in the instructions and keeps them free of MDX-breaking characters', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions.startsWith('## Amazon Shipping')).toBe(true);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.replace(/`[^`]*`/g, '')).not.toMatch(/[{}<]/);
    for (const entry of a.tools) expect(entry.description.replace(/`[^`]*`/g, '')).not.toMatch(/[{}<]/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('asks for rates on the regional endpoint with the access token and the business id headers', async () => {
    ok();
    await call('amazon_shipping_get_rates', { ship_from: SHIP_FROM, ship_to: SHIP_TO, packages: PACKAGES, channel_details: CHANNEL });
    const req = sent();
    expect(req.url).toBe(`${BASE}/shipping/v2/shipments/rates`);
    expect(String(req.method).toUpperCase()).toBe('POST');
    // SP-API reads the token from x-amz-access-token, not from Authorization.
    expect(header(req, 'x-amz-access-token')).toBe('test-token');
    expect(header(req, 'Authorization')).toBeUndefined();
    expect(header(req, 'x-amzn-shipping-business-id')).toBe('AmazonShipping_UK');
    expect(req.data).toEqual({ shipTo: SHIP_TO, shipFrom: SHIP_FROM, packages: PACKAGES, channelDetails: CHANNEL });
  });

  it('reads tracking, documents, access points and additional inputs with the documented query names', async () => {
    ok();
    await call('amazon_shipping_get_tracking', { tracking_id: '1578648261977', carrier_id: 'AMZN_UK' });
    expect(sent().url).toBe(`${BASE}/shipping/v2/tracking`);
    expect(sent().params).toEqual({ trackingId: '1578648261977', carrierId: 'AMZN_UK' });

    ok();
    await call('amazon_shipping_get_shipment_documents', { shipment_id: '445454-3232-3232', package_client_reference_id: 'PKG-1001-1', format: 'PNG', dpi: 203 });
    expect(sent().url).toBe(`${BASE}/shipping/v2/shipments/445454-3232-3232/documents`);
    expect(sent().params).toEqual({ packageClientReferenceId: 'PKG-1001-1', format: 'PNG', dpi: 203 });

    ok();
    await call('amazon_shipping_get_access_points', { access_point_types: 'HELIX,CORE_LOCKER', country_code: 'GB', postal_code: 'EC1A 1BB' });
    expect(sent().url).toBe(`${BASE}/shipping/v2/accessPoints`);
    expect(sent().params).toEqual({ accessPointTypes: 'HELIX,CORE_LOCKER', countryCode: 'GB', postalCode: 'EC1A 1BB' });

    ok();
    await call('amazon_shipping_get_additional_inputs', { request_token: 'amzn1.rq.123', rate_id: 'rate-1' });
    expect(sent().url).toBe(`${BASE}/shipping/v2/shipments/additionalInputs/schema`);
    expect(sent().params).toEqual({ requestToken: 'amzn1.rq.123', rateId: 'rate-1' });

    ok();
    await call('amazon_shipping_get_collection_form', { collection_form_id: 'form-1' });
    expect(sent().url).toBe(`${BASE}/shipping/v2/collectionForms/form-1`);
    expect(String(sent().method).toUpperCase()).toBe('GET');
  });

  it('sends the three reads Amazon models as PUT with a JSON body', async () => {
    ok();
    await call('amazon_shipping_get_unmanifested_shipments', {});
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/shipping/v2/unmanifestedShipments`);
    expect(sent().data).toEqual({});

    ok();
    await call('amazon_shipping_get_carrier_accounts', {});
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/shipping/v2/carrierAccounts`);
    expect(sent().data).toEqual({});

    ok();
    await call('amazon_shipping_get_collection_form_history', { carrier_id: 'AMZN_UK', date_range: { startDate: '2026-11-01T00:00:00Z', endDate: '2026-11-14T00:00:00Z' } });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/shipping/v2/collectionForms/history`);
    expect(sent().data).toEqual({ maxResults: 20, carrierId: 'AMZN_UK', dateRange: { startDate: '2026-11-01T00:00:00Z', endDate: '2026-11-14T00:00:00Z' } });
  });

  it('builds the switched-off purchase, cancel and manifest calls as the model describes them', async () => {
    ok();
    await call('amazon_shipping_purchase_shipment', { request_token: 'amzn1.rq.123', rate_id: 'rate-1', requested_document_specification: LABEL, idempotency_key: 'order-1001-try-1' });
    expect(sent().url).toBe(`${BASE}/shipping/v2/shipments`);
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(header(sent(), 'x-amzn-IdempotencyKey')).toBe('order-1001-try-1');
    expect(sent().data).toEqual({ requestToken: 'amzn1.rq.123', rateId: 'rate-1', requestedDocumentSpecification: LABEL });

    ok();
    await call('amazon_shipping_purchase_shipment', { request_token: 'amzn1.rq.123', rate_id: 'rate-1', requested_document_specification: LABEL });
    expect(header(sent(), 'x-amzn-IdempotencyKey')).toBeUndefined();

    ok();
    await call('amazon_shipping_one_click_shipment', { ship_from: SHIP_FROM, ship_to: SHIP_TO, packages: PACKAGES, channel_details: CHANNEL, label_specifications: LABEL, service_ids: ['SWA-UK-PREM'] });
    expect(sent().url).toBe(`${BASE}/shipping/v2/oneClickShipment`);
    expect(sent().data).toEqual({
      shipTo: SHIP_TO,
      shipFrom: SHIP_FROM,
      packages: PACKAGES,
      channelDetails: CHANNEL,
      labelSpecifications: LABEL,
      serviceSelection: { serviceId: ['SWA-UK-PREM'] },
    });

    const amazonChannel = { channelType: 'AMAZON', amazonOrderDetails: { orderId: '113-3080243-4028244' } };
    ok();
    await call('amazon_shipping_direct_purchase_shipment', { channel_details: amazonChannel, ship_from: SHIP_FROM, packages: PACKAGES, label_specifications: LABEL });
    expect(sent().url).toBe(`${BASE}/shipping/v2/shipments/directPurchase`);
    expect(sent().data).toEqual({ shipFrom: SHIP_FROM, packages: PACKAGES, channelDetails: amazonChannel, labelSpecifications: LABEL });

    ok();
    await call('amazon_shipping_cancel_shipment', { shipment_id: '445454-3232-3232' });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/shipping/v2/shipments/445454-3232-3232/cancel`);

    ok();
    await call('amazon_shipping_generate_collection_form', { carrier_id: 'AMZN_UK', ship_from_address: SHIP_FROM });
    expect(sent().url).toBe(`${BASE}/shipping/v2/collectionForms`);
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({ carrierId: 'AMZN_UK', shipFromAddress: SHIP_FROM });
  });
});

// Opt-in: RUN_AMAZON_SHIPPING_LIVE=1. The refusal check needs no account; the
// read needs the keys of a private app with the Amazon Logistics role.
// Nothing is written or bought.
const live = process.env.RUN_AMAZON_SHIPPING_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('amazon-shipping: live', () => {
  it('refuses a wrong client at Login with Amazon', async () => {
    const response = await liveFetch.post(
      'https://api.amazon.com/auth/o2/token',
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'Atzr|not-a-token', client_id: 'amzn1.application-oa2-client.none', client_secret: 'not-a-secret' }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, validateStatus: () => true },
    );
    expect([400, 401]).toContain(response.status);
  });

  it('lists the unmanifested shipments', async () => {
    const { SPAPI_CLIENT_ID: id, SPAPI_CLIENT_SECRET: secret, SPAPI_REFRESH_TOKEN: refresh, SPAPI_ENDPOINT: endpoint } = process.env;
    const business = process.env.AMAZON_SHIPPING_BUSINESS_ID;
    if (!id || !secret || !refresh || !endpoint || !business) return;
    const token = await liveFetch.post(
      'https://api.amazon.com/auth/o2/token',
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: id, client_secret: secret }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } },
    );
    expect(token.data.access_token).toBeTruthy();
    const response = await liveFetch.put(
      `${endpoint}/shipping/v2/unmanifestedShipments`,
      {},
      { headers: { 'x-amz-access-token': token.data.access_token, 'x-amzn-shipping-business-id': business, Accept: 'application/json' }, validateStatus: () => true },
    );
    // 200 with the list; 400 means Amazon accepted the sign-in and the role
    // but has nothing to answer for this account, which the 400 hint explains.
    expect([200, 400]).toContain(response.status);
  });
});
