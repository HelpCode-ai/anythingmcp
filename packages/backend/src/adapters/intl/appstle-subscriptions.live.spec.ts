import axios from 'axios';
import * as adapter from './appstle-subscriptions.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Appstle Subscriptions Admin API (developers.appstle.com, OpenAPI at
 * https://developers.appstle.com/subscription/admin-api-swagger.json):
 * base https://subscription-admin.appstle.com, every path under
 * /api/external/v2, the key in the X-API-Key header, Spring paging with
 * page/size/sort and the total in X-Total-Count. Paths, methods and query
 * names were checked against that file.
 *
 * The live block reads only:
 *   RUN_APPSTLE_SUBSCRIPTIONS_LIVE=1 APPSTLE_API_KEY=... npx jest src/adapters/intl/appstle-subscriptions
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
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    exposeHeaders?: string[];
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { secret?: boolean }>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string' && v.startsWith('$')) out.add(v.slice(1));
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  return out;
};

const P = 'appstle_subscriptions_';
const BASE = 'https://subscription-admin.appstle.com';
const V2 = `${BASE}/api/external/v2`;
const KEY = ['appstle', 'key', '0a1b2c3d4e5f6789'].join('-');
const ENV = { APPSTLE_API_KEY: KEY };
const execute = (name: string, params: Record<string, unknown>) =>
  new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: a.connector.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep({ ...a.connector.authConfig }, ENV),
      headers: a.connector.headers,
    },
    tool(name).endpointMapping as never,
    { ...applySchemaDefaults(tool(name).parameters, params), ...ENV },
  ) as Promise<any>;
const sent = () => mockedAxios.mock.calls[0][0];

const C = 123456;
const LINE = 'gid://shopify/SubscriptionLine/abc-1';

describe('appstle-subscriptions adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the API key in the X-API-Key header, never in the query', async () => {
    expect(a.requiredEnvVars).toEqual(['APPSTLE_API_KEY']);
    expect(a.envVarMeta.APPSTLE_API_KEY.secret).toBe(true);
    expect(a.connector).toMatchObject({ baseUrl: BASE, authType: 'API_KEY', authConfig: { headerName: 'X-API-Key', apiKey: '{{APPSTLE_API_KEY}}' } });
    mockedAxios.mockResolvedValue({ data: [], headers: {} });
    await execute(`${P}list_subscription_contracts`, {});
    expect(sent().url).toBe(`${V2}/subscription-contract-details`);
    expect(sent().headers['X-API-Key']).toBe(KEY);
    expect(sent().params).toEqual({ page: 0, size: 20 });
    expect(JSON.stringify(sent().params)).not.toMatch(/api_key/);
  });

  // [tool suffix, args, method, path under /api/external/v2]
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['list_subscription_contracts', {}, 'GET', '/subscription-contract-details'],
    ['get_contract', { contract_id: C }, 'GET', `/subscription-contracts/contract-external/${C}`],
    ['get_contract_analytics', { contract_id: C }, 'GET', `/subscription-contract-details/analytics/${C}`],
    ['get_contract_current_cycle', { contract_id: C }, 'GET', `/subscription-contract-details/current-cycle/${C}`],
    ['get_contract_fulfillments', { contract_id: C }, 'GET', `/subscription-contract-details/subscription-fulfillments/${C}`],
    ['get_delivery_options', { contract_id: C }, 'GET', '/data/contract-delivery-options'],
    ['list_upcoming_orders', { contract_id: C }, 'GET', '/subscription-billing-attempts/top-orders'],
    ['list_past_orders', {}, 'GET', '/subscription-billing-attempts/past-orders'],
    ['get_past_orders_report', { status: 'FAILURE' }, 'GET', '/subscription-billing-attempts/past-orders/report'],
    ['list_customers', {}, 'GET', '/subscription-contract-details/customers'],
    ['get_customer', { customer_id: 77 }, 'GET', '/subscription-customers/77'],
    ['list_customer_subscriptions', { customer_id: 77 }, 'GET', '/subscription-customers-detail/valid/77'],
    ['get_customer_portal_link', { customer_id: 77 }, 'GET', '/manage-subscription-link'],
    ['list_subscription_groups', {}, 'GET', '/subscription-groups'],
    ['get_subscription_group', { group_id: 5 }, 'GET', '/subscription-groups/5'],
    ['list_selling_plans', {}, 'GET', '/subscription-groups/all-selling-plans'],
    ['list_product_swaps', {}, 'GET', '/product-swaps'],
    ['list_retention_activities', {}, 'GET', '/customer-retention-activities'],
    ['update_contract_status', { contract_id: C, status: 'PAUSED' }, 'PUT', '/subscription-contracts-update-status'],
    ['cancel_contract', { contract_id: C }, 'DELETE', `/subscription-contracts/${C}`],
    ['update_next_billing_date', { contract_id: C, next_billing_date: '2026-12-01T00:00:00Z' }, 'PUT', '/subscription-contracts-update-billing-date'],
    ['update_billing_interval', { contract_id: C, interval_count: 2, interval: 'WEEK' }, 'PUT', '/subscription-contracts-update-billing-interval'],
    ['update_delivery_interval', { contract_id: C, delivery_interval_count: 1, delivery_interval: 'MONTH' }, 'PUT', '/subscription-contracts-update-delivery-interval'],
    ['skip_order', { billing_attempt_id: 9 }, 'PUT', '/subscription-billing-attempts/skip-order/9'],
    ['skip_upcoming_order', { contract_id: C }, 'PUT', '/subscription-billing-attempts/skip-upcoming-order'],
    ['unskip_order', { billing_attempt_id: 9 }, 'PUT', '/subscription-billing-attempts/unskip-order/9'],
    ['reschedule_order', { billing_attempt_id: 9, billing_date: '2026-12-01T00:00:00Z' }, 'PUT', '/subscription-billing-attempts/reschedule-order/9'],
    ['bill_order_now', { billing_attempt_id: 9 }, 'PUT', '/subscription-billing-attempts/attempt-billing/9'],
    ['add_line_item', { contract_id: C, variant_id: '42', quantity: 1 }, 'PUT', '/subscription-contracts-add-line-item'],
    ['update_line_item', { contract_id: C, line_id: LINE }, 'PUT', '/subscription-contracts-update-line-item'],
    ['remove_line_item', { contract_id: C, line_id: LINE }, 'PUT', '/subscription-contracts-remove-line-item'],
    ['apply_discount_code', { contract_id: C, discount_code: 'SAVE10' }, 'PUT', '/subscription-contracts-apply-discount'],
    ['add_custom_discount', { contract_id: C, discount_type: 'PERCENTAGE', percentage: 10 }, 'PUT', '/subscription-contracts-add-discount'],
    ['remove_discount', { contract_id: C, discount_id: 'gid://shopify/SubscriptionManualDiscount/1' }, 'PUT', '/subscription-contracts-remove-discount'],
    ['update_shipping_address', { contract_id: C, city: 'Austin' }, 'PUT', '/subscription-contracts-update-shipping-address'],
    ['update_order_note', { contract_id: C, order_note: 'Leave at door' }, 'PUT', `/subscription-contracts-update-order-note/${C}`],
    ['send_payment_method_update_email', { contract_id: C }, 'PUT', '/subscription-contracts-update-payment-method'],
  ];

  it('covers every tool in the table', () => {
    expect(table.map((r) => P + r[0]).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s calls %s %s', async (suffix, args, method, path) => {
    mockedAxios.mockResolvedValue({ data: {}, headers: {} });
    await execute(P + suffix, args);
    expect(sent().method).toBe(method);
    expect(sent().url).toBe(`${V2}${path}`);
  });

  it('maps filters and ids to the documented query names', async () => {
    mockedAxios.mockResolvedValue({ data: [], headers: {} });
    await execute(`${P}list_subscription_contracts`, { status: 'ACTIVE', customer_name: 'ann', next_billing_from: '2026-11-01T00:00:00Z', next_billing_to: '2026-11-30T00:00:00Z', sort: 'next_billing_date,asc', size: 50 });
    expect(sent().params).toEqual({ status: 'ACTIVE', customerName: 'ann', fromNextDate: '2026-11-01T00:00:00Z', toNextDate: '2026-11-30T00:00:00Z', sort: 'next_billing_date,asc', page: 0, size: 50 });
    mockedAxios.mockClear();
    await execute(`${P}update_contract_status`, { contract_id: C, status: 'ACTIVE' });
    expect(sent().params).toEqual({ contractId: C, status: 'ACTIVE' });
    mockedAxios.mockClear();
    await execute(`${P}skip_order`, { billing_attempt_id: 9, contract_id: C });
    expect(sent().params).toEqual({ subscriptionContractId: C });
    mockedAxios.mockClear();
    await execute(`${P}update_line_item`, { contract_id: C, line_id: LINE, variant_id: 'gid://shopify/ProductVariant/42', quantity: 2 });
    expect(sent().params).toEqual({ contractId: C, lineId: LINE, variantId: 'gid://shopify/ProductVariant/42', quantity: 2 });
    mockedAxios.mockClear();
    await execute(`${P}cancel_contract`, { contract_id: C, cancellation_feedback: 'Too expensive' });
    expect(sent().params).toEqual({ cancellationFeedback: 'Too expensive' });
  });

  it('sends the address fields in the body and the contract id in the query', async () => {
    mockedAxios.mockResolvedValue({ data: {}, headers: {} });
    await execute(`${P}update_shipping_address`, { contract_id: C, first_name: 'Ann', address1: '1 Main St', city: 'Austin', zip: '78701', province_code: 'TX', country_code: 'US' });
    expect(sent().params).toEqual({ contractId: C });
    expect(sent().data).toEqual({ firstName: 'Ann', address1: '1 Main St', city: 'Austin', zip: '78701', provinceCode: 'TX', countryCode: 'US' });
  });

  it('exposes the X-Total-Count and Link headers on the paged lists', () => {
    for (const t of a.tools.filter((x) => 'page' in (x.parameters.properties ?? {}))) {
      expect(`${t.name}:${t.endpointMapping.exposeHeaders}`).toBe(`${t.name}:x-total-count,link`);
    }
  });

  it('every declared parameter reaches the request, path parameters are required and encoded', () => {
    for (const t of a.tools) {
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) {
        expect(t.parameters?.required).toContain(p);
        expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
      }
      expect(t.endpointMapping.path.startsWith('/api/external/v2/')).toBe(true);
    }
  });

  it('marks reads read-only, cancel destructive, and installs cancel and bill-now switched off', () => {
    for (const t of a.tools) expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    expect(annotationsOf(tool(`${P}cancel_contract`)).destructiveHint).toBe(true);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([`${P}bill_order_now`, `${P}cancel_contract`]);
  });

  it('probes with a read tool, names every tool in the instructions, and shares no name with another adapter', () => {
    expect(a.probe.tool).toBe(`${P}list_subscription_contracts`);
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    const names = new Set(a.tools.map((t) => t.name));
    for (const m of [...a.instructions.matchAll(/\bappstle_subscriptions_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bappstle_subscriptions_[a-z_]+/g)])]) {
      expect(names).toContain(m[0]);
    }
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(names.has(t.name)).toBe(false);
    }
    expect(JSON.stringify(adapter)).not.toMatch(/—/);
  });
});

const LIVE = process.env.RUN_APPSTLE_SUBSCRIPTIONS_LIVE === '1' && process.env.APPSTLE_API_KEY ? describe : describe.skip;
LIVE('appstle-subscriptions adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${V2}${path}`, { headers: { 'X-API-Key': process.env.APPSTLE_API_KEY!, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return { body: await res.json(), total: res.headers.get('x-total-count') };
  };
  it('reads contracts, customers, groups, selling plans and past orders', async () => {
    const contracts = await get('/subscription-contract-details?page=0&size=1');
    expect(Array.isArray(contracts.body)).toBe(true);
    expect(contracts.total).not.toBeNull();
    expect(Array.isArray((await get('/subscription-contract-details/customers?page=0&size=1')).body)).toBe(true);
    expect((await get('/subscription-groups')).body).toBeDefined();
    expect((await get('/subscription-groups/all-selling-plans')).body).toBeDefined();
    expect((await get('/subscription-billing-attempts/past-orders?page=0&size=1')).body).toBeDefined();
  }, 60_000);
});
