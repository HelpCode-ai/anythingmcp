import axios from 'axios';
import * as adapter from './ready2order.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the ready2order adapter:
 *
 *   1. Static: always runs. Pins Bearer auth with the Account Token and every
 *      tool's method, URL, query and body through the real RestEngine, checked
 *      against ready2order's OpenAPI document (ready2order.com/api/doc, version
 *      R2-2026.42.3, read 13 Oct 2026): parameter names such as itemNumber,
 *      dateField and includeProductGroup, the product and stock bodies, and the
 *      customer body with its required customerCategory_id.
 *
 *   2. Live: skipped unless RUN_READY2ORDER_LIVE=1. Without a token it checks
 *      that ready2order refuses a wrong one with 401 on real routes and answers
 *      404 on a made-up one. With READY2ORDER_ACCOUNT_TOKEN it reads the VAT
 *      rates, one product and the bills of the last week (nothing is changed):
 *
 *        RUN_READY2ORDER_LIVE=1 READY2ORDER_ACCOUNT_TOKEN=... npx jest src/adapters/de/ready2order.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
    config: { errorWhen: unknown[] };
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

const BASE = 'https://api.ready2order.com/v1';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = 'r2o-test-' + 'x'.repeat(24);
const ENV: Record<string, string> = { READY2ORDER_ACCOUNT_TOKEN: FAKE_TOKEN };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[0][0];

describe('ready2order adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: verified read-only on a live account on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.region).toBe('de');
    expect(a.icon).toBe('ready2order');
  });

  it('sends the Account Token as Bearer, on api.ready2order.com/v1', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{READY2ORDER_ACCOUNT_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/vat-rates');
    expect(a.requiredEnvVars).toEqual(['READY2ORDER_ACCOUNT_TOKEN']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'READY2ORDER_ACCOUNT_TOKEN', kind: 'credential', secret: true, required: true });
    const pattern = new RegExp(a.envVarMeta.READY2ORDER_ACCOUNT_TOKEN.pattern!);
    expect(pattern.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_TOKEN}`, `${FAKE_TOKEN} `, 'short']) expect(pattern.test(bad)).toBe(false);
  });

  it('probes with the VAT rates and explains 401, 403 and the 60 per minute limit', () => {
    expect(a.probe).toEqual({ tool: 'ready2order_list_vat_rates' });
    expect(a.verifyHints['403']).toMatch(/Developer Token/);
    expect(a.verifyHints['429']).toMatch(/60 requests/);
    expect(a.connector.config.errorWhen).toEqual([{ path: 'error', equals: true, messagePath: 'msg', status: 400 }]);
    expect(a.instructions).toContain('/developerToken/grantAccessToken');
  });

  it('prefixes every tool and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^ready2order_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('ships only the delete switched off, marks GETs read-only and asks for confirmation on writes', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['ready2order_delete_product']);
    for (const t of a.tools) {
      const readOnly = annotationsOf(t).readOnlyHint === true;
      expect(`${t.name}:${readOnly}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
      if (!readOnly) expect(t.description).toMatch(/confirmation/);
    }
  });

  it('only points the model at tools that exist, describes every parameter and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bready2order_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bready2order_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['ready2order_list_products', {}, 'GET', `${BASE}/products`],
    ['ready2order_get_product', { id: 11 }, 'GET', `${BASE}/products/11`],
    ['ready2order_create_product', { product_name: 'Cola', product_price: '3.50' }, 'POST', `${BASE}/products`],
    ['ready2order_update_product', { id: 11, product_active: false }, 'PUT', `${BASE}/products/11`],
    ['ready2order_get_product_stock', { id: 11 }, 'GET', `${BASE}/products/11/stock`],
    ['ready2order_get_stock_by_item_number', { itemNumber: 'A-1/2' }, 'GET', `${BASE}/products/itemNumber/A-1%2F2/stock`],
    ['ready2order_update_product_stock', { id: 11, product_stockDelta: '24' }, 'PUT', `${BASE}/products/11/stock`],
    ['ready2order_delete_product', { id: 11 }, 'DELETE', `${BASE}/products/11`],
    ['ready2order_list_product_groups', {}, 'GET', `${BASE}/productgroups`],
    ['ready2order_list_group_products', { id: 4 }, 'GET', `${BASE}/productgroups/4/products`],
    ['ready2order_create_product_group', { productgroup_name: 'Drinks' }, 'POST', `${BASE}/productgroups`],
    ['ready2order_list_bills', { dateFrom: '2026-10-01', dateTo: '2026-10-07' }, 'GET', `${BASE}/document/invoice`],
    ['ready2order_get_bill', { id: 900 }, 'GET', `${BASE}/document/invoice/900`],
    ['ready2order_get_bill_pdf', { id: 900 }, 'GET', `${BASE}/document/invoice/900/pdf`],
    ['ready2order_list_open_orders', {}, 'GET', `${BASE}/orders`],
    ['ready2order_list_customers', {}, 'GET', `${BASE}/customers`],
    ['ready2order_get_customer', { id: 7 }, 'GET', `${BASE}/customers/7`],
    ['ready2order_create_customer', { customerCategory_id: 1, lastName: 'Muster' }, 'POST', `${BASE}/customers`],
    ['ready2order_update_customer', { id: 7, email: 'max@example.com' }, 'PUT', `${BASE}/customers/7`],
    ['ready2order_list_customer_groups', {}, 'GET', `${BASE}/customerCategories`],
    ['ready2order_list_payment_methods', {}, 'GET', `${BASE}/paymentMethods`],
    ['ready2order_list_vat_rates', {}, 'GET', `${BASE}/vat-rates`],
    ['ready2order_get_daily_report_status', {}, 'GET', `${BASE}/dailyReport/status`],
    ['ready2order_list_users', {}, 'GET', `${BASE}/users`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Bearer token', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('filters products and bills with the documented query names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('ready2order_list_products', { q: 'cola', productgroup_id: 4, includeProductGroup: true, page: 2, limit: 50 });
    expect(sent().params).toEqual({ q: 'cola', productgroup_id: 4, includeProductGroup: true, page: 2, limit: 50 });
    mockedAxios.mockClear();
    await call('ready2order_list_bills', { dateFrom: '2026-10-01', dateTo: '2026-10-07', dateField: 'bill', items: true, payments: true, offset: 100, limit: 100 });
    expect(sent().params).toEqual({ dateFrom: '2026-10-01', dateTo: '2026-10-07', dateField: 'bill', items: true, payments: true, offset: 100, limit: 100 });
    mockedAxios.mockClear();
    await call('ready2order_get_bill_pdf', { id: 900 });
    expect(sent().params).toEqual({ format: 'A4' });
  });

  it('sends only the given product, stock and customer fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('ready2order_create_product', { product_name: 'Cola', product_price: '3.50', product_vat: '20', productgroup_id: 4, product_priceIncludesVat: true });
    expect(sent().data).toEqual({ product_name: 'Cola', product_price: '3.50', product_vat: '20', productgroup_id: 4, product_priceIncludesVat: true });
    mockedAxios.mockClear();
    await call('ready2order_update_product', { id: 11, product_active: false });
    expect(sent().data).toEqual({ product_active: false });
    mockedAxios.mockClear();
    await call('ready2order_update_product_stock', { id: 11, product_stockDelta: '-2' });
    expect(sent().data).toEqual({ product_stockDelta: '-2' });
    mockedAxios.mockClear();
    await call('ready2order_create_customer', { customerCategory_id: 1, company: 'Muster GmbH', uid: 'ATU12345678' });
    expect(sent().data).toEqual({ customerCategory_id: 1, company: 'Muster GmbH', uid: 'ATU12345678' });
  });
});

const live = process.env.RUN_READY2ORDER_LIVE === '1' ? describe : describe.skip;
live('ready2order adapter: live', () => {
  const realToken = process.env.READY2ORDER_ACCOUNT_TOKEN;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['ready2order_list_vat_rates', {}],
    ['ready2order_list_products', { limit: 1 }],
    ['ready2order_list_bills', { dateFrom: '2026-10-01', dateTo: '2026-10-07', limit: 1 }],
    ['ready2order_get_daily_report_status', {}],
  ])('%s: ready2order refuses a wrong token with 401', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401, data: { code: 'apiFailedAuthentication' } } });
  }, 30000);

  it('answers 404 on a made-up route', async () => {
    await expect(
      (mockedAxios.__actual as any).request({ url: `${BASE}/does-not-exist`, method: 'GET', headers: { Authorization: `Bearer ${FAKE_TOKEN}` } }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (realToken ? it : it.skip)('reads VAT rates, one product and a week of bills', async () => {
    const env = { READY2ORDER_ACCOUNT_TOKEN: realToken! };
    const rates = await call('ready2order_list_vat_rates', {}, env);
    expect(Array.isArray(rates)).toBe(true);
    const products = await call('ready2order_list_products', { limit: 1 }, env);
    expect(Array.isArray(products)).toBe(true);
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const bills = await call('ready2order_list_bills', { dateFrom: from, dateTo: to, limit: 5 }, env);
    expect(Array.isArray(bills.invoices)).toBe(true);
  }, 60000);
});
