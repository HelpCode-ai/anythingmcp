import axios from 'axios';
import * as adapter from './easypost.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the EasyPost adapter:
 *
 *   1. Static: always runs. Pins HTTP Basic with the API key as user name
 *      and an empty password, every tool's method and URL, the wrapped
 *      request bodies (address, parcel, shipment, tracker, customs), the
 *      top-level verify flags, the buy body, and which tools are read-only,
 *      money-moving or not.
 *
 *   2. Live: skipped unless EASYPOST_API_KEY is set:
 *
 *        EASYPOST_API_KEY=... npx jest src/adapters/intl/easypost.live.spec.ts
 *
 *      Reads addresses, shipments (bought and unbought), trackers, batches
 *      and scan forms, and carrier accounts (refused with a test key).
 *
 *      EASYPOST_LIVE_WRITE=1 runs only when the key is a test key (checked on
 *      the mode of the first object it creates, before anything is bought):
 *      two US addresses (one verified on creation, one verified afterwards,
 *      shipping to whatever id the verification answers with), a parcel,
 *      customs item and info, a shipment with rates, re-rating, a free test
 *      label bought from the cheapest rate, label conversion to PDF, a
 *      tracker for a test code, a scan form attempt, and in `finally` a
 *      refund of the label. Test addresses, parcels, customs objects and
 *      trackers cannot be deleted; they stay in the test data.
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

// Built at run time so no literal in this file looks like a real key.
const KEY = 'EZTK' + '0'.repeat(40);
const BASE = 'https://api.easypost.com/v2';
const execute = (name: string, key: string, params: Record<string, unknown>) => {
  const env = { EASYPOST_API_KEY: key };
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep({ ...a.connector.authConfig }, env), headers: config.headers },
    endpointMapping,
    applySchemaDefaults(tool(name).parameters, params),
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, KEY, params);
const sent = () => mockedAxios.mock.calls[0][0];
const MONEY = ['easypost_buy_shipment', 'easypost_insure_shipment', 'easypost_refund_shipment'];

describe('easypost adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (verified against the official API spec on 12 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
    expect(a.prerequisites).toMatch(/test key/i);
  });

  it('sends the key as the Basic user name with an empty password', async () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{EASYPOST_API_KEY}}', password: '' });
    expect(a.connector.baseUrl).toBe(BASE);
    mockedAxios.mockResolvedValue({ data: {} });
    await call('easypost_list_addresses', {});
    expect(sent().auth).toEqual({ username: KEY, password: '' });
    expect(a.requiredEnvVars).toEqual(['EASYPOST_API_KEY']);
    expect(describeAdapterEnvVars(a as never).find((d) => d.name === 'EASYPOST_API_KEY')!.secret).toBe(true);
  });

  it('probes and health-checks with one address, which a test key may read', () => {
    expect(a.probe).toEqual({ tool: 'easypost_list_addresses', params: { page_size: 1 } });
    expect(a.connector.healthcheckPath).toBe('/addresses?page_size=1');
  });

  it('prefixes every tool with easypost_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^easypost_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only and buying, insuring and refunding as money-moving writes to confirm', () => {
    for (const t of a.tools) expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    for (const name of MONEY) {
      const ann = annotationsOf(tool(name));
      expect(`${name}:${ann.readOnlyHint}:${ann.destructiveHint}:${ann.idempotentHint}`).toBe(`${name}:false:true:false`);
      expect(tool(name).description).toMatch(/confirm|wait for the user/i);
    }
    for (const name of ['easypost_create_shipment', 'easypost_rerate_shipment', 'easypost_create_tracker', 'easypost_create_address']) {
      expect(annotationsOf(tool(name)).destructiveHint).toBe(false);
    }
    // Nothing is deleted through this connector.
    expect(a.tools.filter((t) => t.endpointMapping.method === 'DELETE')).toEqual([]);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\beasypost_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\beasypost_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(8);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['easypost_create_address', { street1: '1 Main St', country: 'US' }, 'POST', '/addresses'],
    ['easypost_create_and_verify_address', { street1: '1 Main St', country: 'US' }, 'POST', '/addresses/create_and_verify'],
    ['easypost_verify_address', { address_id: 'adr_1' }, 'GET', '/addresses/adr_1/verify'],
    ['easypost_get_address', { address_id: 'adr_1' }, 'GET', '/addresses/adr_1'],
    ['easypost_list_addresses', {}, 'GET', '/addresses'],
    ['easypost_create_parcel', { weight: 10 }, 'POST', '/parcels'],
    ['easypost_get_parcel', { parcel_id: 'prcl_1' }, 'GET', '/parcels/prcl_1'],
    ['easypost_create_shipment', { to_address: { id: 'adr_1' }, from_address: { id: 'adr_2' }, parcel: { id: 'prcl_1' } }, 'POST', '/shipments'],
    ['easypost_get_shipment', { shipment_id: 'shp_1' }, 'GET', '/shipments/shp_1'],
    ['easypost_list_shipments', {}, 'GET', '/shipments'],
    ['easypost_buy_shipment', { shipment_id: 'shp_1', rate_id: 'rate_1' }, 'POST', '/shipments/shp_1/buy'],
    ['easypost_refund_shipment', { shipment_id: 'shp_1' }, 'POST', '/shipments/shp_1/refund'],
    ['easypost_rerate_shipment', { shipment_id: 'shp_1' }, 'POST', '/shipments/shp_1/rerate'],
    ['easypost_get_smartrates', { shipment_id: 'shp_1' }, 'GET', '/shipments/shp_1/smartrate'],
    ['easypost_convert_label', { shipment_id: 'shp_1', file_format: 'PDF' }, 'GET', '/shipments/shp_1/label'],
    ['easypost_insure_shipment', { shipment_id: 'shp_1', amount: '100' }, 'POST', '/shipments/shp_1/insure'],
    ['easypost_create_tracker', { tracking_code: 'EZ1000000001' }, 'POST', '/trackers'],
    ['easypost_get_tracker', { tracker_id: 'trk_1' }, 'GET', '/trackers/trk_1'],
    ['easypost_list_trackers', {}, 'GET', '/trackers'],
    ['easypost_list_carrier_accounts', {}, 'GET', '/carrier_accounts'],
    ['easypost_get_carrier_account', { carrier_account_id: 'ca_1' }, 'GET', '/carrier_accounts/ca_1'],
    ['easypost_create_customs_item', { description: 'Shirt', quantity: 1, value: 10, weight: 5 }, 'POST', '/customs_items'],
    ['easypost_get_customs_item', { customs_item_id: 'cstitem_1' }, 'GET', '/customs_items/cstitem_1'],
    ['easypost_create_customs_info', { customs_items: [{ id: 'cstitem_1' }], contents_type: 'merchandise' }, 'POST', '/customs_infos'],
    ['easypost_get_customs_info', { customs_info_id: 'cstinfo_1' }, 'GET', '/customs_infos/cstinfo_1'],
    ['easypost_list_batches', {}, 'GET', '/batches'],
    ['easypost_get_batch', { batch_id: 'batch_1' }, 'GET', '/batches/batch_1'],
    ['easypost_create_scan_form', { shipments: [{ id: 'shp_1' }] }, 'POST', '/scan_forms'],
    ['easypost_list_scan_forms', {}, 'GET', '/scan_forms'],
    ['easypost_get_scan_form', { scan_form_id: 'sf_1' }, 'GET', '/scan_forms/sf_1'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ method, url: `${BASE}${path}` }));
  });

  it('wraps objects as EasyPost expects and keeps the verify flags next to the address', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('easypost_create_address', { name: 'Ana', street1: '417 Montgomery St', city: 'San Francisco', state: 'CA', zip: '94104', country: 'US', verify: true });
    expect(sent().data).toEqual({
      address: { name: 'Ana', street1: '417 Montgomery St', city: 'San Francisco', state: 'CA', zip: '94104', country: 'US' },
      verify: true,
    });
    mockedAxios.mockClear();
    // Left out, not sent as false: EasyPost verifies whenever the key is present.
    await call('easypost_create_address', { street1: '417 Montgomery St', country: 'US' });
    expect(sent().data).toEqual({ address: { street1: '417 Montgomery St', country: 'US' } });
    mockedAxios.mockClear();
    await call('easypost_create_parcel', { length: 10, width: 8, height: 4, weight: 15.4 });
    expect(sent().data).toEqual({ parcel: { length: 10, width: 8, height: 4, weight: 15.4 } });
    mockedAxios.mockClear();
    await call('easypost_create_tracker', { tracking_code: 'EZ1000000001', carrier: 'USPS' });
    expect(sent().data).toEqual({ tracker: { tracking_code: 'EZ1000000001', carrier: 'USPS' } });
  });

  it('builds the shipment and the buy body', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const to = { name: 'B', street1: '1 Main St', city: 'Austin', state: 'TX', zip: '78701', country: 'US' };
    await call('easypost_create_shipment', { to_address: to, from_address: { id: 'adr_2' }, parcel: { id: 'prcl_1' }, options: { label_format: 'PDF' }, reference: 'order-1' });
    expect(sent().data).toEqual({ shipment: { to_address: to, from_address: { id: 'adr_2' }, parcel: { id: 'prcl_1' }, options: { label_format: 'PDF' }, reference: 'order-1' } });
    mockedAxios.mockClear();
    await call('easypost_buy_shipment', { shipment_id: 'shp_1', rate_id: 'rate_1', insurance: '50.00' });
    expect(sent().data).toEqual({ rate: { id: 'rate_1' }, insurance: '50.00' });
  });

  it('filters trackers by code with the array parameter EasyPost reads', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('easypost_list_trackers', { tracking_code: 'EZ1000000001', carrier: 'USPS' });
    expect(sent().params).toEqual({ 'tracking_codes[]': 'EZ1000000001', carrier: 'USPS', page_size: 20 });
  });
});

const API_KEY = process.env.EASYPOST_API_KEY;
const live = API_KEY ? describe : describe.skip;

live('easypost adapter: live API', () => {
  const write = process.env.EASYPOST_LIVE_WRITE === '1';
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, API_KEY as string, params);
  const listOf = (answer: any, key: string) => answer[key] ?? [];
  const errorCode = (e: unknown) => (e as { response?: { data?: { error?: { code?: string } } } }).response?.data?.error?.code;

  it('reads addresses, shipments, trackers, batches, scan forms and carrier accounts', async () => {
    const addresses = await run('easypost_list_addresses', { page_size: 2 });
    // A fresh account may answer without the array.
    expect(Array.isArray(listOf(addresses, 'addresses'))).toBe(true);
    const first = listOf(addresses, 'addresses')[0];
    if (first) expect((await run('easypost_get_address', { address_id: first.id })).id).toBe(first.id);
    for (const purchased of [true, false]) {
      const shipments = await run('easypost_list_shipments', { page_size: 2, purchased });
      expect(Array.isArray(listOf(shipments, 'shipments'))).toBe(true);
      const one = listOf(shipments, 'shipments')[0];
      if (one) expect((await run('easypost_get_shipment', { shipment_id: one.id })).id).toBe(one.id);
    }
    const trackers = await run('easypost_list_trackers', { page_size: 2 });
    expect(Array.isArray(listOf(trackers, 'trackers'))).toBe(true);
    const batches = await run('easypost_list_batches', { page_size: 2 });
    expect(Array.isArray(listOf(batches, 'batches'))).toBe(true);
    const batch = listOf(batches, 'batches')[0];
    if (batch) expect((await run('easypost_get_batch', { batch_id: batch.id })).id).toBe(batch.id);
    const forms = await run('easypost_list_scan_forms', { page_size: 2 });
    expect(Array.isArray(listOf(forms, 'scan_forms'))).toBe(true);
    const form = listOf(forms, 'scan_forms')[0];
    if (form) expect((await run('easypost_get_scan_form', { scan_form_id: form.id })).id).toBe(form.id);
    try {
      const carriers = await run('easypost_list_carrier_accounts');
      expect(Array.isArray(carriers)).toBe(true);
      if (carriers.length) expect((await run('easypost_get_carrier_account', { carrier_account_id: carriers[0].id })).id).toBe(carriers[0].id);
    } catch (e) {
      // Carrier accounts are production-only.
      expect(errorCode(e)).toMatch(/MODE|UNAUTHORIZED|FORBIDDEN/);
    }
  }, 90_000);

  (write ? it : it.skip)('verifies addresses, rates, buys a free test label, tracks it and refunds it', async () => {
    const from = await run('easypost_create_address', {
      name: 'AnythingMCP test sender', company: 'AnythingMCP test', street1: '417 Montgomery Street', street2: 'Floor 5',
      city: 'San Francisco', state: 'CA', zip: '94104', country: 'US', phone: '4153334445', email: 'anythingmcp-test@example.com', verify: true,
    });
    // Stop before anything can be bought with a production key.
    expect(from.mode).toBe('test');
    expect(from.verifications.delivery).toBeDefined();
    const to = await run('easypost_create_and_verify_address', {
      name: 'AnythingMCP test recipient', street1: '179 N Harbor Dr', city: 'Redondo Beach', state: 'CA', zip: '90277', country: 'US', phone: '3108085243',
    });
    expect(to.verifications.delivery.success).toBe(true);
    const checked = await run('easypost_verify_address', { address_id: to.id });
    // The answer may be a new address object; ship to whichever id it carries.
    const toId = checked.address.id;
    expect(toId).toMatch(/^adr_/);
    expect((await run('easypost_get_address', { address_id: toId })).id).toBe(toId);

    const parcel = await run('easypost_create_parcel', { length: 10, width: 8, height: 4, weight: 15.4 });
    expect((await run('easypost_get_parcel', { parcel_id: parcel.id })).weight).toBe(15.4);
    const item = await run('easypost_create_customs_item', { description: 'AnythingMCP test T-shirt', quantity: 2, value: 20, weight: 10, hs_tariff_number: '610910', origin_country: 'US' });
    expect((await run('easypost_get_customs_item', { customs_item_id: item.id })).id).toBe(item.id);
    const customs = await run('easypost_create_customs_info', {
      customs_items: [{ id: item.id }], contents_type: 'merchandise', customs_certify: true, customs_signer: 'AnythingMCP Test', eel_pfc: 'NOEEI 30.37(a)',
    });
    expect((await run('easypost_get_customs_info', { customs_info_id: customs.id })).id).toBe(customs.id);

    const shipment = await run('easypost_create_shipment', { from_address: { id: from.id }, to_address: { id: toId }, parcel: { id: parcel.id }, reference: 'AnythingMCP test' });
    expect(shipment.rates.length).toBeGreaterThan(0);
    const rerated = await run('easypost_rerate_shipment', { shipment_id: shipment.id });
    expect(Array.isArray(rerated.rates)).toBe(true);
    await run('easypost_get_smartrates', { shipment_id: shipment.id }).catch((e: unknown) => expect(errorCode(e)).toBeDefined());
    const rates = (await run('easypost_get_shipment', { shipment_id: shipment.id })).rates;
    const usps = rates.filter((r: { carrier: string }) => r.carrier === 'USPS');
    const cheapest = (usps.length ? usps : rates).sort((x: { rate: string }, y: { rate: string }) => Number(x.rate) - Number(y.rate))[0];

    const bought = await run('easypost_buy_shipment', { shipment_id: shipment.id, rate_id: cheapest.id });
    try {
      expect(bought.mode).toBe('test');
      expect(bought.postage_label.label_url).toMatch(/^https:\/\//);
      expect(bought.tracking_code).toBeDefined();
      const pdf = await run('easypost_convert_label', { shipment_id: shipment.id, file_format: 'PDF' });
      expect(pdf.postage_label.label_pdf_url).toMatch(/^https:\/\//);
      const tracker = await run('easypost_create_tracker', { tracking_code: 'EZ4000000004', carrier: 'USPS' });
      expect((await run('easypost_get_tracker', { tracker_id: tracker.id })).tracking_code).toBe('EZ4000000004');
      const found = await run('easypost_list_trackers', { tracking_code: 'EZ4000000004', carrier: 'USPS' });
      expect(listOf(found, 'trackers').map((t: { id: string }) => t.id)).toContain(tracker.id);
      const listed = await run('easypost_list_shipments', { page_size: 5 });
      expect(listOf(listed, 'shipments').map((s: { id: string }) => s.id)).toContain(shipment.id);
      // Scan forms need same-day USPS shipments; a refusal is still an API answer.
      await run('easypost_create_scan_form', { shipments: [{ id: shipment.id }] })
        .then(async (form) => expect((await run('easypost_get_scan_form', { scan_form_id: form.id })).id).toBe(form.id))
        .catch((e: unknown) => expect(errorCode(e)).toBeDefined());
    } finally {
      const refunded = await run('easypost_refund_shipment', { shipment_id: shipment.id });
      expect(refunded.refund_status).toBeDefined();
    }
  }, 180_000);
});
