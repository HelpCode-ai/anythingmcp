import axios from 'axios';
import * as adapter from './gumroad.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Gumroad adapter:
 *
 *   1. Static: always runs. Pins the Bearer token, every tool's method and
 *      URL through the real RestEngine (checked against Gumroad's own API v2
 *      routes, controllers and API reference), the form bodies the Rails
 *      controllers compare as strings ("true", "percent", "false"), the
 *      `success: false` answers turned into errors, the switched-off refund,
 *      and the response mappings against the documented example payloads.
 *
 *   2. Live: skipped unless RUN_GUMROAD_LIVE=1 and GUMROAD_ACCESS_TOKEN are set:
 *
 *        RUN_GUMROAD_LIVE=1 GUMROAD_ACCESS_TOKEN=... npx jest src/adapters/intl/gumroad.live.spec.ts
 *
 *      Reads only (user, products, one page of sales, offer codes and
 *      custom fields of the first product, sale webhooks). With
 *      GUMROAD_LIVE_WRITE=1 as well, an offer code ANYTHINGMCPTEST (1 cent
 *      off, usable once) is created on the first product; Gumroad's API has
 *      no way to delete it here, so remove it in the dashboard afterwards.
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
  parameters: { properties?: Record<string, { default?: unknown; pattern?: string }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    bodyEncoding?: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  responseMapping?: { transform?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { secret?: boolean; pattern?: string }>;
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

const BASE = 'https://api.gumroad.com/v2';
const PID = 'A-m3CDDC5dlrSdKZp0RFhA==';
const PID_ENC = 'A-m3CDDC5dlrSdKZp0RFhA%3D%3D';
const run = async (name: string, params: Record<string, unknown>, token = 'test-token') => {
  const { body } = await new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).executeWithMeta(
    {
      baseUrl: a.connector.baseUrl,
      authType: a.connector.authType,
      authConfig: { token },
      headers: a.connector.headers,
      errorWhen: a.connector.config.errorWhen,
    } as never,
    tool(name).endpointMapping,
    applySchemaDefaults(tool(name).parameters as never, params),
  );
  return body as any;
};
const runShaped = async (name: string, params: Record<string, unknown>, token?: string) =>
  applyResponseTransform(await run(name, params, token), tool(name).responseMapping as never).value as any;
const sent = () => mockedAxios.mock.calls[0][0];
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as never);

const WRITES = ['gumroad_enable_product', 'gumroad_disable_product', 'gumroad_create_offer_code'];

describe('gumroad adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('gumroad');
    expect(a.icon).toBe('gumroad');
    expect(a.category).toBe('e-commerce');
  });

  it('sends the generated access token as a Bearer token', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{GUMROAD_ACCESS_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['GUMROAD_ACCESS_TOKEN']);
    expect(a.envVarMeta.GUMROAD_ACCESS_TOKEN.secret).toBe(true);
    expect(new RegExp(a.envVarMeta.GUMROAD_ACCESS_TOKEN.pattern!).test('Bearer abc')).toBe(false);
    expect(a.connector.healthcheckPath).toBe('/user');
    expect(a.probe.tool).toBe('gumroad_get_user');
  });

  it('prefixes every tool with gumroad_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^gumroad_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('writes ask to confirm, the refund is switched off, nothing deletes', () => {
    for (const name of WRITES) {
      expect(tool(name).enabled).toBeUndefined();
      expect(tool(name).description).toMatch(/confirm before calling/);
      expect(annotationsOf(tool(name)).readOnlyHint).toBe(false);
    }
    expect(tool('gumroad_refund_sale').enabled).toBe(false);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['gumroad_refund_sale']);
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
    // POST /licenses/verify reads: it is marked read-only and never counts a use by default.
    expect(annotationsOf(tool('gumroad_verify_license'))).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    for (const t of a.tools.filter((x) => !WRITES.includes(x.name) && x.name !== 'gumroad_refund_sale')) {
      expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:true`);
    }
  });

  it('every tool shapes its answer, and only points at tools that exist', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${Boolean(tr && (tr.select || tr.exclude || tr.include))}`).toBe(`${t.name}:true`);
    }
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [...a.instructions.matchAll(/\bgumroad_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgumroad_[a-z_]+/g)])].map((m) => m[0]).filter((n) => n !== 'gumroad_fee'); // a sale field, not a tool
    expect(mentioned.length).toBeGreaterThan(12);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Gumroad\n')).toBe(true);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['gumroad_get_user', {}, 'GET', `${BASE}/user`],
    ['gumroad_list_products', {}, 'GET', `${BASE}/products`],
    ['gumroad_get_product', { product_id: PID }, 'GET', `${BASE}/products/${PID_ENC}`],
    ['gumroad_enable_product', { product_id: PID }, 'PUT', `${BASE}/products/${PID_ENC}/enable`],
    ['gumroad_disable_product', { product_id: PID }, 'PUT', `${BASE}/products/${PID_ENC}/disable`],
    ['gumroad_list_sales', {}, 'GET', `${BASE}/sales`],
    ['gumroad_get_sale', { sale_id: 'B28UKN-dvxYabdavG97Y-Q==' }, 'GET', `${BASE}/sales/B28UKN-dvxYabdavG97Y-Q%3D%3D`],
    ['gumroad_list_subscribers', { product_id: PID }, 'GET', `${BASE}/products/${PID_ENC}/subscribers`],
    ['gumroad_get_subscriber', { subscriber_id: 'P5ppE6H8XIjy2JSCgUhbAw==' }, 'GET', `${BASE}/subscribers/P5ppE6H8XIjy2JSCgUhbAw%3D%3D`],
    ['gumroad_list_offer_codes', { product_id: PID }, 'GET', `${BASE}/products/${PID_ENC}/offer_codes`],
    ['gumroad_create_offer_code', { product_id: PID, name: 'SPRING', amount_off: 20 }, 'POST', `${BASE}/products/${PID_ENC}/offer_codes`],
    ['gumroad_list_custom_fields', { product_id: PID }, 'GET', `${BASE}/products/${PID_ENC}/custom_fields`],
    ['gumroad_verify_license', { product_id: PID, license_key: 'K' }, 'POST', `${BASE}/licenses/verify`],
    ['gumroad_list_resource_subscriptions', { resource_name: 'sale' }, 'GET', `${BASE}/resource_subscriptions`],
    ['gumroad_refund_sale', { sale_id: 'S1' }, 'PUT', `${BASE}/sales/S1/refund`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends the right method and URL with the Bearer token', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: { success: true } });
    await run(name, params);
    expect(sent().method).toBe(method);
    expect(sent().url).toBe(url);
    expect(sent().headers.Authorization).toBe('Bearer test-token');
  });

  it('encodes every path id, so a crafted id cannot reach another route', async () => {
    mockedAxios.mockResolvedValue({ data: { success: true } });
    await run('gumroad_get_product', { product_id: '../sales' });
    expect(sent().url).toBe(`${BASE}/products/..%2Fsales`);
    for (const t of a.tools.filter((x) => /\{[a-z_]+\}/.test(x.endpointMapping.path))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('sends the sales filters and the subscriber pagination switch as query parameters', async () => {
    mockedAxios.mockResolvedValue({ data: { success: true } });
    await run('gumroad_list_sales', { after: '2026-01-01', before: '2026-02-01', product_id: PID, page_key: '20230119081040000000-123456' });
    expect(sent().params).toEqual({ after: '2026-01-01', before: '2026-02-01', product_id: PID, page_key: '20230119081040000000-123456' });
    expect(new RegExp(tool('gumroad_list_sales').parameters.properties!.after.pattern!).test('2026-1-1')).toBe(false);
    mockedAxios.mockClear();
    await run('gumroad_list_subscribers', { product_id: PID });
    expect(sent().params).toEqual({ paginated: 'true' });
  });

  it('posts form bodies with the string values the Rails controllers compare against', async () => {
    mockedAxios.mockResolvedValue({ data: { success: true } });
    await run('gumroad_create_offer_code', { product_id: PID, name: 'HALF', amount_off: 50, offer_type: 'percent', universal: true });
    expect(sent().headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(sent().data).toString()).toBe('name=HALF&amount_off=50&offer_type=percent&universal=true');
    mockedAxios.mockClear();
    await run('gumroad_create_offer_code', { product_id: PID, name: 'ONEOFF', amount_off: 100 });
    expect(new URLSearchParams(sent().data).toString()).toBe('name=ONEOFF&amount_off=100&offer_type=cents&universal=false');
    mockedAxios.mockClear();
    // The controller counts a use for anything but "false": the default must send it.
    await run('gumroad_verify_license', { product_id: PID, license_key: '83DB262A-C19D3B06-A5235A6B-8C079166' });
    expect(new URLSearchParams(sent().data).toString()).toBe(
      `product_id=${encodeURIComponent(PID)}&license_key=83DB262A-C19D3B06-A5235A6B-8C079166&increment_uses_count=false`,
    );
  });

  it('turns a success: false answer into an error carrying Gumroad\'s message', async () => {
    mockedAxios.mockResolvedValue({ data: { success: false, message: 'The product was not found.' } });
    await expect(run('gumroad_get_product', { product_id: PID })).rejects.toThrow(/The product was not found/);
    mockedAxios.mockResolvedValue({ data: { success: false, message: 'Valid resource_name parameter required' } });
    await expect(run('gumroad_list_resource_subscriptions', { resource_name: 'sale' })).rejects.toThrow(/Valid resource_name/);
    mockedAxios.mockResolvedValue({ data: { success: true, user: { name: 'x' } } });
    await expect(run('gumroad_get_user', {})).resolves.toMatchObject({ success: true });
  });

  // Example payloads from the Gumroad API reference, trimmed.
  it('shapes a sales page to the fields a sales question needs', () => {
    const out = shape('gumroad_list_sales', {
      success: true,
      next_page_url: '/v2/sales?page_key=20230119081040000000-123456',
      next_page_key: '20230119081040000000-123456',
      sales: [{
        id: 'B28UKN-dvxYabdavG97Y-Q==', email: 'calvin@gumroad.com', seller_id: 'kL0', timestamp: 'about 2 months ago', daystamp: ' 5 Jan 2021 11:38 AM', created_at: '2021-01-05T19:38:56Z',
        product_name: 'Pencil Icon PSD', price: 1000, gumroad_fee: 60, formatted_total_price: '$10 a month', currency_symbol: '$', product_id: '32-nPainqpLj1B_WIwVlMw==',
        partially_refunded: false, chargedback: false, zip_code: '625003', card: { visual: null, type: null }, order_id: 524459995, purchaser_id: '5530311507811',
        license_key: '83DB262A-C19D3B06-A5235A6B-8C079166', quantity: 1, variants: { Tier: 'Premium' }, can_contact: true,
      }],
    }).value as any;
    expect(out.next_page_key).toBe('20230119081040000000-123456');
    expect(out.sales[0]).toMatchObject({ id: 'B28UKN-dvxYabdavG97Y-Q==', price: 1000, gumroad_fee: 60, order_id: 524459995, variants: { Tier: 'Premium' }, quantity: 1 });
    for (const dropped of ['seller_id', 'timestamp', 'daystamp', 'zip_code', 'card', 'purchaser_id', 'can_contact']) expect(out.sales[0][dropped]).toBeUndefined();
  });

  it('shapes products, subscribers, offer codes and a license check', () => {
    const products = shape('gumroad_list_products', {
      success: true,
      products: [{ id: PID, name: 'Pencil Icon PSD', published: true, price: 100, currency: 'usd', formatted_price: '$1', short_url: 'https://sahil.gumroad.com/l/pencil', description: '<p>long</p>', thumbnail_url: 'x', file_info: {}, purchasing_power_parity_prices: { US: 100 }, sales_count: 3, sales_usd_cents: 300, variants: [] }],
    }).value as any;
    expect(products.products[0]).toEqual({ id: PID, name: 'Pencil Icon PSD', published: true, price: 100, currency: 'usd', formatted_price: '$1', short_url: 'https://sahil.gumroad.com/l/pencil', sales_count: 3, sales_usd_cents: 300 });
    const subs = shape('gumroad_list_subscribers', {
      success: true, next_page_key: 'k',
      subscribers: [{ id: 'P5', product_id: PID, product_name: 'Pencil', user_id: '35', user_email: 'calvin@gumroad.com', purchase_ids: ['O4'], created_at: '2015-06-30T17:38:04Z', recurrence: 'monthly', cancelled_at: null, status: 'alive', license_key: 'L' }],
    }).value as any;
    expect(subs.subscribers[0]).toMatchObject({ id: 'P5', status: 'alive', recurrence: 'monthly', user_email: 'calvin@gumroad.com' });
    expect(subs.next_page_key).toBe('k');
    const codes = shape('gumroad_list_offer_codes', { success: true, offer_codes: [{ id: 'mN7', name: '1OFF', amount_cents: 100, max_purchase_count: null, universal: false, times_used: 1 }] }).value as any;
    expect(codes.offer_codes[0]).toEqual({ id: 'mN7', name: '1OFF', amount_cents: 100, max_purchase_count: null, universal: false, times_used: 1 });
    const lic = shape('gumroad_verify_license', {
      success: true, uses: 3,
      purchase: { seller_id: 'kL0', product_id: PID, product_name: 'licenses demo product', email: 'customer@example.com', price: 0, currency: 'usd', quantity: 1, sale_id: 'FO8', sale_timestamp: '2021-01-05T19:38:56Z', purchaser_id: '555', license_key: '85DB', ip_country: 'United States', refunded: false, chargebacked: false, card: { visual: null }, subscription_cancelled_at: null },
    }).value as any;
    expect(lic.uses).toBe(3);
    expect(lic.purchase).toMatchObject({ sale_id: 'FO8', email: 'customer@example.com', refunded: false, chargebacked: false });
    expect(lic.purchase.ip_country).toBeUndefined();
    expect(lic.purchase.purchaser_id).toBeUndefined();
  });
});

const live = process.env.RUN_GUMROAD_LIVE === '1' && process.env.GUMROAD_ACCESS_TOKEN ? describe : describe.skip;

live('gumroad adapter: live API', () => {
  const token = process.env.GUMROAD_ACCESS_TOKEN!;
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  it('reads the user, products, sales and webhooks', async () => {
    const me = await runShaped('gumroad_get_user', {}, token);
    expect(typeof me.user.user_id).toBe('string');
    const products = await runShaped('gumroad_list_products', {}, token);
    expect(Array.isArray(products.products)).toBe(true);
    const sales = await runShaped('gumroad_list_sales', {}, token);
    expect(Array.isArray(sales.sales)).toBe(true);
    expect(sales.sales.length).toBeLessThanOrEqual(10);
    const hooks = await runShaped('gumroad_list_resource_subscriptions', { resource_name: 'sale' }, token);
    expect(Array.isArray(hooks.resource_subscriptions)).toBe(true);
    const first = products.products[0];
    if (first) {
      const product = await runShaped('gumroad_get_product', { product_id: first.id }, token);
      expect(product.id).toBe(first.id);
      const codes = await runShaped('gumroad_list_offer_codes', { product_id: first.id }, token);
      expect(Array.isArray(codes.offer_codes)).toBe(true);
      const fields = await runShaped('gumroad_list_custom_fields', { product_id: first.id }, token);
      expect(Array.isArray(fields.custom_fields)).toBe(true);
    }
  }, 60_000);

  it('an unknown license key is a 404', async () => {
    const products = await runShaped('gumroad_list_products', {}, token);
    if (!products.products[0]) return;
    await expect(run('gumroad_verify_license', { product_id: products.products[0].id, license_key: 'NOT-A-REAL-KEY' }, token)).rejects.toMatchObject({ response: { status: 404 } });
  }, 30_000);

  const writes = process.env.GUMROAD_LIVE_WRITE === '1' ? it : it.skip;
  writes('creates a one-use 1 cent offer code on the first product', async () => {
    const products = await runShaped('gumroad_list_products', {}, token);
    const code = await runShaped('gumroad_create_offer_code', { product_id: products.products[0].id, name: 'ANYTHINGMCPTEST', amount_off: 1, max_purchase_count: 1 }, token);
    expect(code.name).toBe('ANYTHINGMCPTEST');
  }, 30_000);
});
