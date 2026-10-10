import axios from 'axios';
import * as adapter from './shippo.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Shippo adapter:
 *
 *   1. Static: always runs. Pins the `ShippoToken` Authorization header, the
 *      token pattern, every tool's method and URL, the shipment, label,
 *      customs and refund bodies (synchronous by default), and which tools
 *      are read-only or destructive.
 *
 *   2. Live: skipped unless SHIPPO_API_TOKEN is set. Writes need a test token
 *      (shippo_test_...), where labels are free:
 *
 *        SHIPPO_API_TOKEN=shippo_test_... npx jest src/adapters/intl/shippo.live.spec.ts
 *
 *      Reads carrier accounts, parcel templates, addresses, shipments, labels,
 *      customs declarations, refunds, manifests and test tracking numbers.
 *
 *      SHIPPO_LIVE_WRITE=1 (test token only) runs the whole flow: two US
 *      addresses (one validated), a parcel, a shipment with rates, a USPS test
 *      label bought from the cheapest rate, read back and listed, tracking
 *      registered, a customs item and declaration, and in `finally` a refund
 *      of the label, read back. Test addresses and parcels cannot be deleted;
 *      they stay in the test data, labelled "AnythingMCP test".
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

const BASE = 'https://api.goshippo.com';
const execute = (name: string, token: string, params: Record<string, unknown>) => {
  const env = { SHIPPO_API_TOKEN: token };
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
const call = (name: string, params: Record<string, unknown>) => execute(name, 'shippo_test_abc123', params);
const sent = () => mockedAxios.mock.calls[0][0];

describe('shippo adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until verified against a real account', () => {
    expect(a.unlisted).toBe(true);
    expect(a.prerequisites).toMatch(/test key/);
  });

  it('sends the token as "Authorization: ShippoToken <token>" and no API version header', async () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'ShippoToken {{SHIPPO_API_TOKEN}}' });
    expect(a.connector.baseUrl).toBe(BASE);
    mockedAxios.mockResolvedValue({ data: {} });
    await call('shippo_list_carrier_accounts', {});
    expect(sent().headers.Authorization).toBe('ShippoToken shippo_test_abc123');
    // A version header would change the whole account's default version.
    expect(Object.keys(sent().headers).map((h) => h.toLowerCase())).not.toContain('shippo-api-version');
  });

  it('accepts test and live tokens only, and marks the token secret', () => {
    expect(a.requiredEnvVars).toEqual(['SHIPPO_API_TOKEN']);
    const token = new RegExp(a.envVarMeta.SHIPPO_API_TOKEN.pattern!);
    expect(token.test('shippo_test_5f1b2c3d4e')).toBe(true);
    expect(token.test('shippo_live_5f1b2c3d4e')).toBe(true);
    expect(token.test('ShippoToken shippo_test_5f1b')).toBe(false);
    expect(describeAdapterEnvVars(a as never).find((d) => d.name === 'SHIPPO_API_TOKEN')!.secret).toBe(true);
  });

  it('probes with one carrier account and health-checks the same list', () => {
    expect(a.probe).toEqual({ tool: 'shippo_list_carrier_accounts', params: { results: 1 } });
    expect(a.connector.healthcheckPath).toBe('/carrier_accounts?results=1');
  });

  it('prefixes every tool with shippo_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^shippo_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only and buying or refunding a label destructive', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual([
      'shippo_get_address',
      'shippo_get_carrier_account',
      'shippo_get_customs_declaration',
      'shippo_get_customs_item',
      'shippo_get_label',
      'shippo_get_manifest',
      'shippo_get_parcel',
      'shippo_get_rate',
      'shippo_get_refund',
      'shippo_get_shipment',
      'shippo_get_tracking',
      'shippo_list_addresses',
      'shippo_list_carrier_accounts',
      'shippo_list_customs_declarations',
      'shippo_list_labels',
      'shippo_list_manifests',
      'shippo_list_parcel_templates',
      'shippo_list_refunds',
      'shippo_list_shipment_rates',
      'shippo_list_shipments',
      'shippo_validate_address',
    ]);
    for (const name of ['shippo_buy_label', 'shippo_request_refund']) {
      const ann = annotationsOf(tool(name));
      expect(`${name}:${ann.readOnlyHint}:${ann.destructiveHint}:${ann.idempotentHint}`).toBe(`${name}:false:true:false`);
      expect(tool(name).description).toMatch(/confirm/i);
    }
    expect(annotationsOf(tool('shippo_create_shipment')).destructiveHint).toBe(false);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bshippo_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bshippo_[a-z_]+/g)]),
    ]
      .map((m) => m[0])
      // Key prefixes, not tool names.
      .filter((m) => m !== 'shippo_test_' && m !== 'shippo_live_');
    expect(mentioned.length).toBeGreaterThan(8);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['shippo_create_address', { country: 'US' }, 'POST', '/addresses'],
    ['shippo_get_address', { address_id: 'a1' }, 'GET', '/addresses/a1'],
    ['shippo_validate_address', { address_id: 'a1' }, 'GET', '/addresses/a1/validate'],
    ['shippo_list_addresses', {}, 'GET', '/addresses'],
    ['shippo_create_parcel', { weight: '1', mass_unit: 'kg' }, 'POST', '/parcels'],
    ['shippo_get_parcel', { parcel_id: 'p1' }, 'GET', '/parcels/p1'],
    ['shippo_list_parcel_templates', {}, 'GET', '/parcel-templates'],
    ['shippo_create_shipment', { address_from: 'a1', address_to: 'a2', parcels: ['p1'] }, 'POST', '/shipments'],
    ['shippo_get_shipment', { shipment_id: 's1' }, 'GET', '/shipments/s1'],
    ['shippo_list_shipments', {}, 'GET', '/shipments'],
    ['shippo_list_shipment_rates', { shipment_id: 's1' }, 'GET', '/shipments/s1/rates'],
    ['shippo_get_rate', { rate_id: 'r1' }, 'GET', '/rates/r1'],
    ['shippo_buy_label', { rate: 'r1' }, 'POST', '/transactions'],
    ['shippo_list_labels', {}, 'GET', '/transactions'],
    ['shippo_get_label', { transaction_id: 't1' }, 'GET', '/transactions/t1'],
    ['shippo_get_tracking', { carrier: 'shippo', tracking_number: 'SHIPPO_TRANSIT' }, 'GET', '/tracks/shippo/SHIPPO_TRANSIT'],
    ['shippo_register_tracking', { carrier: 'shippo', tracking_number: 'SHIPPO_TRANSIT' }, 'POST', '/tracks'],
    ['shippo_list_carrier_accounts', {}, 'GET', '/carrier_accounts'],
    ['shippo_get_carrier_account', { carrier_account_id: 'c1' }, 'GET', '/carrier_accounts/c1'],
    ['shippo_create_customs_item', { description: 'T-shirt', quantity: 1, net_weight: '0.2', mass_unit: 'kg', value_amount: '10', value_currency: 'EUR', origin_country: 'DE' }, 'POST', '/customs/items'],
    ['shippo_get_customs_item', { customs_item_id: 'ci1' }, 'GET', '/customs/items/ci1'],
    ['shippo_create_customs_declaration', { contents_type: 'MERCHANDISE', non_delivery_option: 'RETURN', certify: true, certify_signer: 'Ana', items: ['ci1'] }, 'POST', '/customs/declarations'],
    ['shippo_get_customs_declaration', { customs_declaration_id: 'cd1' }, 'GET', '/customs/declarations/cd1'],
    ['shippo_list_customs_declarations', {}, 'GET', '/customs/declarations'],
    ['shippo_request_refund', { transaction: 't1' }, 'POST', '/refunds'],
    ['shippo_list_refunds', {}, 'GET', '/refunds/'],
    ['shippo_get_refund', { refund_id: 'rf1' }, 'GET', '/refunds/rf1'],
    ['shippo_create_manifest', { carrier_account: 'c1', shipment_date: '2026-10-12T09:00:00Z', address_from: 'a1' }, 'POST', '/manifests'],
    ['shippo_list_manifests', {}, 'GET', '/manifests'],
    ['shippo_get_manifest', { manifest_id: 'm1' }, 'GET', '/manifests/m1'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ method, url: `${BASE}${path}` }));
  });

  it('creates shipments, labels, refunds and manifests synchronously by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const from = { name: 'A', street1: '215 Clayton St.', city: 'San Francisco', state: 'CA', zip: '94117', country: 'US' };
    await call('shippo_create_shipment', { address_from: from, address_to: 'addr-2', parcels: [{ length: '10', width: '10', height: '10', distance_unit: 'in', weight: '1', mass_unit: 'lb' }] });
    expect(sent().data).toEqual({ address_from: from, address_to: 'addr-2', parcels: [{ length: '10', width: '10', height: '10', distance_unit: 'in', weight: '1', mass_unit: 'lb' }], async: false });
    for (const [name, params, body] of [
      ['shippo_buy_label', { rate: 'r1', label_file_type: 'PDF_A6' }, { rate: 'r1', label_file_type: 'PDF_A6', async: false }],
      ['shippo_request_refund', { transaction: 't1' }, { transaction: 't1', async: false }],
      ['shippo_create_manifest', { carrier_account: 'c1', shipment_date: '2026-10-12T09:00:00Z', address_from: 'a1' }, { carrier_account: 'c1', shipment_date: '2026-10-12T09:00:00Z', address_from: 'a1', async: false }],
    ] as Array<[string, Record<string, unknown>, Record<string, unknown>]>) {
      mockedAxios.mockClear();
      await call(name, params);
      expect(sent().data).toEqual(body);
    }
  });

  it('passes customs items and the declaration as Shippo names them', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('shippo_create_customs_declaration', { contents_type: 'MERCHANDISE', non_delivery_option: 'RETURN', certify: true, certify_signer: 'Ana Diaz', items: ['ci1'], incoterm: 'DDU' });
    expect(sent().data).toEqual({ contents_type: 'MERCHANDISE', non_delivery_option: 'RETURN', certify: true, certify_signer: 'Ana Diaz', items: ['ci1'], incoterm: 'DDU' });
  });
});

const TOKEN = process.env.SHIPPO_API_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('shippo adapter: live API', () => {
  const write = process.env.SHIPPO_LIVE_WRITE === '1' && !!TOKEN?.startsWith('shippo_test_');
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, TOKEN as string, params);

  it('reads carrier accounts, parcel templates and the lists', async () => {
    const carriers = await run('shippo_list_carrier_accounts', { results: 5, service_levels: true });
    expect(Array.isArray(carriers.results)).toBe(true);
    if (carriers.results.length) {
      const one = await run('shippo_get_carrier_account', { carrier_account_id: carriers.results[0].object_id });
      expect(one.object_id).toBe(carriers.results[0].object_id);
    }
    const templates = await run('shippo_list_parcel_templates', { carrier: 'usps' });
    expect(templates).toBeDefined();
    for (const name of ['shippo_list_addresses', 'shippo_list_shipments', 'shippo_list_labels', 'shippo_list_customs_declarations', 'shippo_list_manifests']) {
      const page = await run(name, { results: 2 });
      expect(Array.isArray(page.results)).toBe(true);
    }
    const refunds = await run('shippo_list_refunds');
    expect(refunds).toBeDefined();
    const labels = await run('shippo_list_labels', { results: 1 });
    if (labels.results.length) {
      const one = await run('shippo_get_label', { transaction_id: labels.results[0].object_id });
      expect(one.object_id).toBe(labels.results[0].object_id);
    }
  }, 90_000);

  (TOKEN?.startsWith('shippo_test_') ? it : it.skip)('reads a test tracking number', async () => {
    const track = await run('shippo_get_tracking', { carrier: 'shippo', tracking_number: 'SHIPPO_TRANSIT' });
    expect(track.tracking_status.status).toBe('TRANSIT');
  }, 30_000);

  (write ? it : it.skip)('validates addresses, rates a shipment, buys a test label, tracks it, prepares customs and refunds the label', async () => {
    const from = await run('shippo_create_address', {
      name: 'AnythingMCP test sender', company: 'AnythingMCP test', street1: '215 Clayton St.', city: 'San Francisco', state: 'CA', zip: '94117', country: 'US',
      phone: '+1 555 341 9393', email: 'anythingmcp-test@example.com', validate: true,
    });
    expect(from.validation_results).toBeDefined();
    const to = await run('shippo_create_address', {
      name: 'AnythingMCP test recipient', street1: '965 Mission St', city: 'San Francisco', state: 'CA', zip: '94103', country: 'US', phone: '+1 555 341 9394', email: 'anythingmcp-test@example.com',
    });
    const validated = await run('shippo_validate_address', { address_id: to.object_id });
    expect(validated.object_id).toBe(to.object_id);
    expect((await run('shippo_get_address', { address_id: from.object_id })).object_id).toBe(from.object_id);

    const parcel = await run('shippo_create_parcel', { length: '10', width: '8', height: '4', distance_unit: 'in', weight: '2', mass_unit: 'lb', metadata: 'AnythingMCP test' });
    expect((await run('shippo_get_parcel', { parcel_id: parcel.object_id })).object_id).toBe(parcel.object_id);

    const shipment = await run('shippo_create_shipment', { address_from: from.object_id, address_to: to.object_id, parcels: [parcel.object_id], metadata: 'AnythingMCP test' });
    expect(shipment.status).toBe('SUCCESS');
    expect((await run('shippo_get_shipment', { shipment_id: shipment.object_id })).object_id).toBe(shipment.object_id);
    const rates = await run('shippo_list_shipment_rates', { shipment_id: shipment.object_id });
    expect(rates.results.length).toBeGreaterThan(0);
    const usps = rates.results.filter((r: { provider: string }) => r.provider === 'USPS');
    const cheapest = (usps.length ? usps : rates.results).sort((x: { amount: string }, y: { amount: string }) => Number(x.amount) - Number(y.amount))[0];
    expect((await run('shippo_get_rate', { rate_id: cheapest.object_id })).object_id).toBe(cheapest.object_id);

    const label = await run('shippo_buy_label', { rate: cheapest.object_id, label_file_type: 'PDF', metadata: 'AnythingMCP test' });
    try {
      expect(label.status).toBe('SUCCESS');
      expect(label.test).toBe(true);
      const read = await run('shippo_get_label', { transaction_id: label.object_id });
      expect(read.tracking_number).toBe(label.tracking_number);
      const listed = await run('shippo_list_labels', { rate: cheapest.object_id });
      expect(listed.results.map((t: { object_id: string }) => t.object_id)).toContain(label.object_id);
      const registered = await run('shippo_register_tracking', { carrier: 'shippo', tracking_number: 'SHIPPO_DELIVERED', metadata: 'AnythingMCP test' });
      expect(registered.tracking_number).toBe('SHIPPO_DELIVERED');

      const item = await run('shippo_create_customs_item', {
        description: 'AnythingMCP test T-shirt', quantity: 2, net_weight: '0.4', mass_unit: 'kg', value_amount: '20.00', value_currency: 'USD', origin_country: 'US', tariff_number: '610910',
      });
      expect((await run('shippo_get_customs_item', { customs_item_id: item.object_id })).object_id).toBe(item.object_id);
      const declaration = await run('shippo_create_customs_declaration', {
        contents_type: 'MERCHANDISE', non_delivery_option: 'RETURN', certify: true, certify_signer: 'AnythingMCP Test', items: [item.object_id], incoterm: 'DDU', eel_pfc: 'NOEEI_30_37_a',
      });
      expect((await run('shippo_get_customs_declaration', { customs_declaration_id: declaration.object_id })).object_id).toBe(declaration.object_id);
    } finally {
      const refund = await run('shippo_request_refund', { transaction: label.object_id });
      expect(refund.status).toMatch(/QUEUED|PENDING|SUCCESS/);
      const again = await run('shippo_get_refund', { refund_id: refund.object_id });
      expect(again.transaction).toBe(label.object_id);
    }
  }, 180_000);
});
