import axios from 'axios';
import * as adapter from './moka-pos.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Moka POS adapter (Moka API at api.mokapos.com).
 *
 * Static checks always run: the OAuth 2.0 authorization-code settings
 * (authorize and token URL on api.mokapos.com, the five scopes, no PKCE),
 * every tool's method and URL against Moka's published Swagger document,
 * the report date parameters, the write bodies, and which tools install
 * switched off. No tool creates a checkout or an order, and next_url is
 * taken out of the transaction answers because Moka's examples carry an
 * access token in it.
 * https://api.mokapos.com/docs
 *
 * Live checks run only with RUN_MOKA_POS_LIVE=1. Without credentials they
 * confirm the API refuses a call without a token; with MOKA_ACCESS_TOKEN
 * they read the profile and the business. Reads only.
 *
 *   RUN_MOKA_POS_LIVE=1 MOKA_ACCESS_TOKEN=... \
 *     npx jest src/adapters/intl/moka-pos.live.spec.ts
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
  responseMapping?: { transform?: { exclude?: string[] } };
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
  verifyHints: Record<string, string>;
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
  MOKA_CLIENT_ID: '7a5a83adb069d27563e0d67882a1e0b0739f0eaf',
  MOKA_CLIENT_SECRET: '4fc78952dde155d350d93603c2b0f542a8b371aeb014',
};
const BASE = 'https://api.mokapos.com';

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

// Method and path of every tool, as in Moka's Swagger document.
const CONTRACT: Record<string, [string, string]> = {
  moka_pos_get_profile: ['GET', '/v1/profile/self'],
  moka_pos_get_business: ['GET', '/v1/businesses'],
  moka_pos_list_outlets: ['GET', '/v1/businesses/{business_id}/outlets'],
  moka_pos_list_customers: ['GET', '/v1/businesses/{business_id}/customers'],
  moka_pos_list_loyalty_programs: ['GET', '/v1/businesses/{business_id}/loyalties/programs'],
  moka_pos_list_loyalty_point_activities: ['GET', '/v1/loyalties/point-activities'],
  moka_pos_list_categories: ['GET', '/v1/outlets/{outlet_id}/categories'],
  moka_pos_list_items: ['GET', '/v1/outlets/{outlet_id}/items'],
  moka_pos_list_modifiers: ['GET', '/v1/outlets/{outlet_id}/modifiers'],
  moka_pos_list_discounts: ['GET', '/v1/outlets/{outlet_id}/discounts'],
  moka_pos_list_taxes: ['GET', '/v1/outlets/{outlet_id}/taxes'],
  moka_pos_list_sales_types: ['GET', '/v1/outlets/{outlet_id}/sales_type'],
  moka_pos_list_promos: ['GET', '/v1/outlets/{outlet_id}/promos'],
  moka_pos_list_item_stock_summaries: ['GET', '/v1/outlets/{outlet_id}/inventory/item_summaries'],
  moka_pos_list_purchase_orders: ['GET', '/v1/outlets/{outlet_id}/inventory/purchase_orders'],
  moka_pos_get_purchase_order: ['GET', '/v1/outlets/{outlet_id}/inventory/purchase_orders/{purchase_order_id}'],
  moka_pos_get_sales_summary: ['GET', '/v2/outlets/{outlet_id}/reports/sales_summary'],
  moka_pos_get_item_sales: ['GET', '/v3/outlets/{outlet_id}/reports/item_sales'],
  moka_pos_get_category_sales: ['GET', '/v2/outlets/{outlet_id}/reports/category_sales'],
  moka_pos_get_modifier_sales: ['GET', '/v2/outlets/{outlet_id}/reports/modifier_sales'],
  moka_pos_get_discount_sales: ['GET', '/v2/outlets/{outlet_id}/reports/discount_sales'],
  moka_pos_get_tax_sales: ['GET', '/v2/outlets/{outlet_id}/reports/tax_sales'],
  moka_pos_get_payment_methods_report: ['GET', '/v2/outlets/{outlet_id}/reports/payment_methods'],
  moka_pos_get_collector_sales: ['GET', '/v2/outlets/{outlet_id}/reports/collector_sales'],
  moka_pos_get_server_sales: ['GET', '/v2/outlets/{outlet_id}/reports/server_sales'],
  moka_pos_get_sales_type_report: ['GET', '/v1/outlets/{outlet_id}/reports/sales_types'],
  moka_pos_get_transactions_report: ['GET', '/v2/outlets/{outlet_id}/reports/transactions'],
  moka_pos_list_latest_transactions: ['GET', '/v3/outlets/{outlet_id}/reports/get_latest_transactions'],
  moka_pos_list_invoices: ['GET', '/v3/outlets/{outlet_id}/reports/invoices'],
  moka_pos_get_invoice: ['GET', '/v3/outlets/{outlet_id}/invoices/{invoice_id}'],
  moka_pos_create_item: ['POST', '/v1/outlets/{outlet_id}/items'],
  moka_pos_update_item: ['PUT', '/v1/outlets/{outlet_id}/items/{item_id}'],
  moka_pos_adjust_item_stock: ['POST', '/v1/outlets/{outlet_id}/adjustment/items'],
  moka_pos_delete_item: ['DELETE', '/v1/outlets/{outlet_id}/items/{item_id}'],
};

describe('moka-pos adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in with the authorization code flow on api.mokapos.com', () => {
    expect(a.slug).toBe('moka-pos');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('moka-pos');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{MOKA_CLIENT_ID}}',
      clientSecret: '{{MOKA_CLIENT_SECRET}}',
      authorizationUrl: 'https://api.mokapos.com/oauth/authorize',
      tokenUrl: 'https://api.mokapos.com/oauth/token',
      tokenAuthMethod: 'client_secret_post',
      pkce: false,
      scopes: 'profile library report transaction customer',
    });
    expect(a.requiredEnvVars).toEqual(['MOKA_CLIENT_ID', 'MOKA_CLIENT_SECRET']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.envVarMeta.MOKA_CLIENT_SECRET).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.MOKA_CLIENT_ID.secret).toBeUndefined();
    for (const name of a.requiredEnvVars) {
      const pattern = new RegExp(a.envVarMeta[name].pattern!);
      expect(pattern.test(ENV[name])).toBe(true);
      for (const bad of ['', 'has a space in it 1234567890']) expect(pattern.test(bad)).toBe(false);
    }
  });

  it('asks only for the scopes its tools need and never for checkout scopes', () => {
    const scopes = String(a.connector.authConfig.scopes).split(' ');
    expect(scopes.sort()).toEqual(['customer', 'library', 'profile', 'report', 'transaction']);
    for (const entry of a.tools) {
      expect(entry.endpointMapping.path).not.toContain('checkouts');
      expect(entry.endpointMapping.path).not.toContain('advanced_orderings');
      expect(entry.endpointMapping.path).not.toContain('/oauth/');
    }
  });

  it('probes the profile and explains 401, 403, 404 and the quota', () => {
    expect(a.probe).toEqual({ tool: 'moka_pos_get_profile' });
    expect(tool('moka_pos_get_profile').parameters.required ?? []).toEqual([]);
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('maps every tool to the documented method and path', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(CONTRACT).sort());
    for (const entry of a.tools) {
      const [method, path] = CONTRACT[entry.name];
      expect(entry.endpointMapping.method).toBe(method);
      expect(entry.endpointMapping.path).toBe(path);
    }
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^moka_pos_[a-z0-9_]+$/);
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

  it('marks reads read-only and installs only the item deletion switched off', () => {
    for (const entry of a.tools) {
      const read = entry.endpointMapping.method === 'GET';
      expect(annotationsOf(entry).readOnlyHint).toBe(read);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off).toEqual(['moka_pos_delete_item']);
    const writes = a.tools.filter((entry) => entry.endpointMapping.method !== 'GET').map((entry) => entry.name);
    expect(writes.sort()).toEqual([
      'moka_pos_adjust_item_stock',
      'moka_pos_create_item',
      'moka_pos_delete_item',
      'moka_pos_update_item',
    ]);
  });

  it('requires a date range on every report by date and keeps next_url out of the answers', () => {
    for (const entry of a.tools) {
      const query = entry.endpointMapping.queryParams ?? {};
      if ('start' in query) {
        expect(query).toMatchObject({ start: '$start', end: '$end' });
        expect(entry.parameters.required).toEqual(expect.arrayContaining(['outlet_id', 'start', 'end']));
        expect(entry.parameters.properties!.start.description).toContain('DD/MM/YYYY');
      }
    }
    for (const name of ['moka_pos_list_latest_transactions', 'moka_pos_list_invoices']) {
      expect(tool(name).responseMapping?.transform?.exclude).toEqual(['data.next_url']);
    }
  });

  it('names every tool in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions).toContain('/api/mcp-oauth/callback');
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('reads the profile and the outlets with the bearer token', async () => {
    ok();
    await call('moka_pos_get_profile', {});
    const req = sent();
    expect(req.url).toBe(`${BASE}/v1/profile/self`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Authorization')).toBe('Bearer test-token');
    expect(header(req, 'Accept')).toBe('application/json');

    ok();
    await call('moka_pos_list_outlets', { business_id: 9 });
    expect(sent().url).toBe(`${BASE}/v1/businesses/9/outlets`);

    ok();
    await call('moka_pos_list_customers', { business_id: 9, page: 2, per_page: 50, include_loyalty: true });
    expect(sent().url).toBe(`${BASE}/v1/businesses/9/customers`);
    expect(sent().params).toEqual({ page: 2, per_page: 50, include_loyalty: true });
  });

  it('sends report dates as start and end on the documented API versions', async () => {
    const range = { outlet_id: 2239, start: '01/11/2026', end: '30/11/2026' };

    ok();
    await call('moka_pos_get_sales_summary', range);
    expect(sent().url).toBe(`${BASE}/v2/outlets/2239/reports/sales_summary`);
    expect(sent().params).toEqual({ start: '01/11/2026', end: '30/11/2026' });

    ok();
    await call('moka_pos_get_item_sales', range);
    expect(sent().url).toBe(`${BASE}/v3/outlets/2239/reports/item_sales`);
    expect(sent().params).toEqual({ start: '01/11/2026', end: '30/11/2026' });

    ok();
    await call('moka_pos_get_payment_methods_report', { ...range, per_page: 100 });
    expect(sent().url).toBe(`${BASE}/v2/outlets/2239/reports/payment_methods`);
    expect(sent().params).toEqual({ start: '01/11/2026', end: '30/11/2026', per_page: 100 });

    ok();
    await call('moka_pos_get_discount_sales', range);
    expect(sent().url).toBe(`${BASE}/v2/outlets/2239/reports/discount_sales`);

    ok();
    await call('moka_pos_get_transactions_report', { ...range, time_filter: 'created_at' });
    expect(sent().url).toBe(`${BASE}/v2/outlets/2239/reports/transactions`);
    expect(sent().params).toEqual({ start: '01/11/2026', end: '30/11/2026', time_filter: 'created_at' });

    ok();
    await call('moka_pos_list_item_stock_summaries', { ...range, optional_keyword: 'kopi' });
    expect(sent().url).toBe(`${BASE}/v1/outlets/2239/inventory/item_summaries`);
    expect(sent().params).toEqual({ start: '01/11/2026', end: '30/11/2026', optional_keyword: 'kopi' });
  });

  it('pages the latest transactions by epoch time and reads one invoice by its UUID', async () => {
    ok();
    await call('moka_pos_list_latest_transactions', { outlet_id: 2239, since: 1767200400, until: 1767286800, per_page: 50 });
    expect(sent().url).toBe(`${BASE}/v3/outlets/2239/reports/get_latest_transactions`);
    expect(sent().params).toEqual({ since: 1767200400, until: 1767286800, per_page: 50 });

    ok();
    await call('moka_pos_get_invoice', { outlet_id: 4522, invoice_id: '112cc68d-321f-48e4-b55a-81af98718444' });
    expect(sent().url).toBe(`${BASE}/v3/outlets/4522/invoices/112cc68d-321f-48e4-b55a-81af98718444`);

    ok();
    await call('moka_pos_get_purchase_order', { outlet_id: 2239, purchase_order_id: 113112 });
    expect(sent().url).toBe(`${BASE}/v1/outlets/2239/inventory/purchase_orders/113112`);
  });

  it('builds the item and stock adjustment bodies as Moka documents them', async () => {
    ok();
    await call('moka_pos_create_item', {
      outlet_id: 2624,
      name: 'Americano',
      category_id: 23700,
      item_variants: [{ name: 'Large', sku: 'AMR-L', price: 25000, track_stock: true, in_stock: 40 }],
    });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/v1/outlets/2624/items`);
    expect(sent().data).toEqual({
      item: {
        name: 'Americano',
        category_id: 23700,
        item_variants: [{ name: 'Large', sku: 'AMR-L', price: 25000, track_stock: true, in_stock: 40 }],
      },
    });

    ok();
    await call('moka_pos_update_item', {
      outlet_id: 2624,
      item_id: 788987,
      name: 'Americano',
      item_variants: [{ id: 1130275, price: 27000 }],
    });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/v1/outlets/2624/items/788987`);
    expect(sent().data).toEqual({ item: { name: 'Americano', item_variants: [{ id: 1130275, price: 27000 }] } });

    ok();
    await call('moka_pos_adjust_item_stock', {
      outlet_id: 2624,
      note: 'Stock count',
      history_details: [{ item_id: 788987, item_variant_id: 1130275, actual_stock: 36 }],
    });
    expect(sent().url).toBe(`${BASE}/v1/outlets/2624/adjustment/items`);
    expect(sent().data).toEqual({
      adjustment: { note: 'Stock count', history_details: [{ item_id: 788987, item_variant_id: 1130275, actual_stock: 36 }] },
    });

    ok();
    await call('moka_pos_delete_item', { outlet_id: 2624, item_id: 788987 });
    expect(String(sent().method).toUpperCase()).toBe('DELETE');
    expect(sent().url).toBe(`${BASE}/v1/outlets/2624/items/788987`);
  });
});

// Opt-in: RUN_MOKA_POS_LIVE=1. The refusal check needs no account; the reads
// need MOKA_ACCESS_TOKEN (an access token of an authorized Moka app). Nothing
// is written.
const live = process.env.RUN_MOKA_POS_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('Moka POS: live', () => {
  it('refuses a call without an access token', async () => {
    const response = await liveFetch.get(`${BASE}/v1/profile/self`, {
      headers: { Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(401);
    expect(response.data.meta.code).toBe(401);
  });

  it('reads the profile and the business', async () => {
    const token = process.env.MOKA_ACCESS_TOKEN;
    if (!token) throw new Error('Set MOKA_ACCESS_TOKEN for the live check');
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    const profile = await liveFetch.get(`${BASE}/v1/profile/self`, { headers, validateStatus: () => true });
    expect(profile.status).toBe(200);
    expect(profile.data.business_id).toBeDefined();
    const business = await liveFetch.get(`${BASE}/v1/businesses`, { headers, validateStatus: () => true });
    expect(business.status).toBe(200);
  });
});
