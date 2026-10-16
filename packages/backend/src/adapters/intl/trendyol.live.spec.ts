import axios from 'axios';
import FormData from 'form-data';
import * as adapter from './trendyol.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { fetchOutbound } from '../../common/outbound-fetch.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Three layers of verification for the Trendyol adapter:
 *
 *   1. Static: always runs. Pins Basic auth with the API key and secret,
 *      the User-Agent Trendyol requires ("<seller id> - SelfIntegration"),
 *      the optional storeFrontCode header, the production and stage hosts,
 *      every tool's method and URL (each checked against Trendyol's
 *      published reference; orders on the v2 endpoint that is mandatory from
 *      15 Oct 2026, products on the Product v2 filters), the bodies, and
 *      which tools write.
 *
 *   2. Public lookups: RUN_TRENDYOL_LIVE=1 calls the category, attribute,
 *      brand, cargo provider and claim reason lookups, which Trendyol serves
 *      without a seller account, through the real engine with placeholder
 *      credentials.
 *
 *   3. Live seller reads: skipped unless TRENDYOL_SELLER_ID, TRENDYOL_API_KEY
 *      and TRENDYOL_API_SECRET are set (TRENDYOL_API_HOST defaults to
 *      production). Reads products, stock and prices, orders, claims,
 *      questions, addresses and settlements; nothing is written.
 *
 *        TRENDYOL_SELLER_ID=... TRENDYOL_API_KEY=... TRENDYOL_API_SECRET=... \
 *          npx jest src/adapters/intl/trendyol.live.spec.ts
 */

jest.mock('../../common/outbound-fetch.util', () => ({
  ...jest.requireActual('../../common/outbound-fetch.util'),
  fetchOutbound: jest.fn(),
}));
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
const mockedFetchOutbound = fetchOutbound as jest.MockedFunction<typeof fetchOutbound>;

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    bodyEncoding?: string;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
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

// Built at run time so no literal here looks like a real key or secret.
const KEY = 'k1y2'.repeat(5);
const SECRET = 's3c4'.repeat(5);
const PROD = 'https://apigw.trendyol.com';
const STAGE = 'https://stageapigw.trendyol.com';
const ENV = { TRENDYOL_API_HOST: PROD, TRENDYOL_SELLER_ID: '123456', TRENDYOL_API_KEY: KEY, TRENDYOL_API_SECRET: SECRET };
const BASE = `${PROD}/integration`;
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep({ ...a.connector.authConfig }, env),
      headers: config.headers,
    },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, params);
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = [
  'trendyol_answer_question',
  'trendyol_approve_claim_items',
  'trendyol_archive_products',
  'trendyol_change_cargo_provider',
  'trendyol_create_products',
  'trendyol_delete_products',
  'trendyol_reject_claim_items',
  'trendyol_report_unsupplied',
  'trendyol_send_invoice_link',
  'trendyol_update_package_status',
  'trendyol_update_price_and_inventory',
  'trendyol_update_product_content',
  'trendyol_update_tracking_number',
  'trendyol_update_unapproved_products',
];
const SWITCHED_OFF = ['trendyol_delete_products', 'trendyol_reject_claim_items', 'trendyol_report_unsupplied'];

describe('trendyol adapter: static spec conformance', () => {
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedFetchOutbound.mockReset();
  });

  it('is listed (verified against the official reference, public lookups and customer traffic on 12 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('signs with Basic auth and sends the User-Agent Trendyol requires', async () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{TRENDYOL_API_KEY}}', password: '{{TRENDYOL_API_SECRET}}' });
    expect(needsBrowserAuthorization(a as never)).toBe(false);
    mockedAxios.mockResolvedValue({ data: {} });
    await call('trendyol_list_orders', {});
    expect(sent().auth).toEqual({ username: KEY, password: SECRET });
    expect(sent().headers['User-Agent']).toBe('123456 - SelfIntegration');
    expect(JSON.stringify(sent().params)).not.toContain(SECRET);
    expect(sent().url).not.toContain(SECRET);
  });

  it('reaches production or stage through TRENDYOL_API_HOST', async () => {
    expect(a.connector.baseUrl).toBe('{{TRENDYOL_API_HOST}}/integration');
    const host = new RegExp(a.envVarMeta.TRENDYOL_API_HOST.pattern!);
    expect(host.test(PROD)).toBe(true);
    expect(host.test(STAGE)).toBe(true);
    for (const bad of [`${PROD}/`, `${PROD}/integration`, 'https://api.trendyol.com', 'https://api.trendyol.com/sapigw', 'http://apigw.trendyol.com']) expect(host.test(bad)).toBe(false);
    mockedAxios.mockResolvedValue({ data: {} });
    await execute('trendyol_list_orders', { ...ENV, TRENDYOL_API_HOST: STAGE }, {});
    expect(sent().url).toBe(`${STAGE}/integration/order/sellers/123456/v2/orders`);
    expect(a.instructions).toContain(STAGE);
    expect(a.instructions).toMatch(/whitelisted/);
  });

  it('sends storeFrontCode only when TRENDYOL_STOREFRONT_CODE is set', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.headers?.storeFrontCode}`).toBe(`${t.name}:\${TRENDYOL_STOREFRONT_CODE}`);
    await execute('trendyol_list_orders', { ...ENV, TRENDYOL_STOREFRONT_CODE: 'AE' }, {});
    expect(sent().headers.storeFrontCode).toBe('AE');
    mockedAxios.mockClear();
    await call('trendyol_list_orders', {});
    expect(sent().headers).not.toHaveProperty('storeFrontCode');
    mockedAxios.mockClear();
    await execute('trendyol_list_orders', { ...ENV, TRENDYOL_STOREFRONT_CODE: '' }, {});
    expect(sent().headers).not.toHaveProperty('storeFrontCode');
  });

  it('checks the variables and keeps the secret secret', () => {
    expect(a.requiredEnvVars).toEqual(['TRENDYOL_API_HOST', 'TRENDYOL_SELLER_ID', 'TRENDYOL_API_KEY', 'TRENDYOL_API_SECRET']);
    expect(a.optionalEnvVars).toEqual(['TRENDYOL_STOREFRONT_CODE']);
    const seller = new RegExp(a.envVarMeta.TRENDYOL_SELLER_ID.pattern!);
    expect(seller.test('123456')).toBe(true);
    expect(seller.test('123456 - SelfIntegration')).toBe(false);
    expect(new RegExp(a.envVarMeta.TRENDYOL_API_KEY.pattern!).test(`${KEY} `)).toBe(false);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'TRENDYOL_API_SECRET')!.secret).toBe(true);
    expect(described.find((d) => d.name === 'TRENDYOL_API_HOST')!.kind).toBe('address');
  });

  it('probes with one stock and price row, which needs valid credentials', () => {
    expect(a.probe).toEqual({ tool: 'trendyol_list_stock_and_prices', params: { size: 1 } });
  });

  it('prefixes every tool with trendyol_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^trendyol_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only, asks for confirmation on every write and installs deletions and cancellations switched off', () => {
    const reads = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(a.tools.filter((t) => !reads.includes(t.name)).map((t) => t.name).sort()).toEqual(WRITES);
    // The buybox check is the only read sent as a POST.
    for (const t of a.tools.filter((x) => x.endpointMapping.method !== 'GET' && reads.includes(x.name))) expect(t.name).toBe('trendyol_get_buybox');
    for (const name of WRITES) expect(tool(name).description).toMatch(/get a yes from the user first/);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(SWITCHED_OFF);
    for (const name of SWITCHED_OFF) expect(annotationsOf(tool(name)).destructiveHint).toBe(true);
    expect(annotationsOf(tool('trendyol_create_products')).destructiveHint).toBe(false);
  });

  it('encodes path ids, so an id cannot reach another route', async () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.path.replace('{{TRENDYOL_SELLER_ID}}', '').includes('{'))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
    mockedAxios.mockResolvedValue({ data: {} });
    await call('trendyol_get_product', { barcode: '../products' });
    expect(sent().url).toBe(`${BASE}/product/sellers/123456/product/..%2Fproducts`);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\btrendyol_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\btrendyol_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  // [tool, args, method, path below /integration]
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['trendyol_list_products', {}, 'GET', '/product/sellers/123456/products/approved'],
    ['trendyol_list_unapproved_products', {}, 'GET', '/product/sellers/123456/products/unapproved'],
    ['trendyol_list_stock_and_prices', {}, 'GET', '/product/sellers/123456/products/approved/inventory-and-price'],
    ['trendyol_get_product', { barcode: 'B1' }, 'GET', '/product/sellers/123456/product/B1'],
    ['trendyol_get_buybox', { barcodes: ['B1'] }, 'POST', '/product/sellers/123456/products/buybox-information'],
    ['trendyol_get_batch_request', { batchRequestId: 'r-1' }, 'GET', '/product/sellers/123456/products/batch-requests/r-1'],
    ['trendyol_create_products', { items: [{ barcode: 'B1' }] }, 'POST', '/product/sellers/123456/v2/products'],
    ['trendyol_update_price_and_inventory', { items: [{ barcode: 'B1', quantity: 3 }] }, 'POST', '/inventory/sellers/123456/products/price-and-inventory'],
    ['trendyol_update_product_content', { items: [{ contentId: 1, title: 'T' }] }, 'POST', '/product/sellers/123456/products/content-bulk-update'],
    ['trendyol_update_unapproved_products', { items: [{ barcode: 'B1' }] }, 'POST', '/product/sellers/123456/products/unapproved-bulk-update'],
    ['trendyol_archive_products', { items: [{ barcode: 'B1', archived: true }] }, 'PUT', '/product/sellers/123456/products/archive-state'],
    ['trendyol_delete_products', { items: [{ barcode: 'B1' }] }, 'DELETE', '/product/sellers/123456/products'],
    ['trendyol_list_orders', {}, 'GET', '/order/sellers/123456/v2/orders'],
    ['trendyol_update_package_status', { packageId: 77, status: 'Picking', lines: [{ lineId: 1, quantity: 1 }] }, 'PUT', '/order/sellers/123456/shipment-packages/77'],
    ['trendyol_update_tracking_number', { packageId: 77, cargoSenderNumber: '123', providerCode: 'DHLMP' }, 'PUT', '/order/sellers/123456/shipment-packages/77/tracking-details'],
    ['trendyol_change_cargo_provider', { packageId: 77, cargoProvider: 'YKMP' }, 'PUT', '/order/sellers/123456/shipment-packages/77/cargo-providers'],
    ['trendyol_send_invoice_link', { shipmentPackageId: 77, invoiceLink: 'https://inv.example.com/1.pdf' }, 'POST', '/sellers/123456/seller-invoice-links'],
    ['trendyol_report_unsupplied', { packageId: 77, lines: [{ lineId: 1, quantity: 1 }], reasonId: 500 }, 'PUT', '/order/sellers/123456/shipment-packages/77/items/unsupplied'],
    ['trendyol_list_claims', {}, 'GET', '/order/sellers/123456/claims'],
    ['trendyol_get_claim_item_audit', { claimItemId: 'ci-1' }, 'GET', '/order/sellers/123456/claims/items/ci-1/audit'],
    ['trendyol_list_claim_issue_reasons', {}, 'GET', '/order/claim-issue-reasons'],
    ['trendyol_approve_claim_items', { claimId: 'c-1', claimLineItemIdList: ['ci-1'] }, 'PUT', '/order/sellers/123456/claims/c-1/items/approve'],
    ['trendyol_reject_claim_items', { claimId: 'c-1', claimIssueReasonId: 401, claimItemIdList: 'ci-1', description: 'Missing item' }, 'POST', '/order/sellers/123456/claims/c-1/issue'],
    ['trendyol_list_questions', {}, 'GET', '/qna/sellers/123456/questions/filter'],
    ['trendyol_get_question', { id: 9 }, 'GET', '/qna/sellers/123456/questions/9'],
    ['trendyol_answer_question', { id: 9, text: 'Yes, it is cotton.' }, 'POST', '/qna/sellers/123456/questions/9/answers'],
    ['trendyol_list_categories', { name: 'Casual' }, 'GET', '/product/product-categories'],
    ['trendyol_get_category_attributes', { categoryId: 411 }, 'GET', '/product/categories/411/attributes'],
    ['trendyol_list_attribute_values', { categoryId: 411, attributeId: 343 }, 'GET', '/product/categories/411/attributes/343/values'],
    ['trendyol_search_brands', { name: 'Nike' }, 'GET', '/product/brands/by-name'],
    ['trendyol_list_brands', {}, 'GET', '/product/brands'],
    ['trendyol_list_cargo_providers', {}, 'GET', '/product/lookup/cargo-providers'],
    ['trendyol_list_addresses', {}, 'GET', '/sellers/123456/addresses'],
    ['trendyol_list_settlements', { transactionType: 'Sale' }, 'GET', '/finance/che/sellers/123456/settlements'],
    ['trendyol_list_other_financials', { transactionType: 'PaymentOrder' }, 'GET', '/finance/che/sellers/123456/otherfinancials'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to %s', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ method, url: `${BASE}${path}` }));
  });

  it('lists orders on the v2 endpoint, 50 at a time, with the filters given', async () => {
    mockedAxios.mockResolvedValue({ data: { content: [] } });
    await call('trendyol_list_orders', { status: 'Created', startDate: 1759276800000, endDate: 1760486400000, orderByField: 'PackageLastModifiedDate', orderByDirection: 'DESC' });
    expect(sent().params).toEqual({
      status: 'Created',
      startDate: 1759276800000,
      endDate: 1760486400000,
      orderByField: 'PackageLastModifiedDate',
      orderByDirection: 'DESC',
      size: 50,
    });
    // The v1 order list and the v1 product filter are switched off by Trendyol.
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/\/order\/sellers\/[^/]+\/orders$/);
    expect(a.tools.filter((t) => t.endpointMapping.method === 'GET' && /\/products$/.test(t.endpointMapping.path))).toEqual([]);
  });

  it('sends price and stock items as given', async () => {
    mockedAxios.mockResolvedValue({ data: { batchRequestId: 'r-1' } });
    const items = [{ barcode: 'B1', quantity: 3, salePrice: 99.9, listPrice: 120 }];
    await call('trendyol_update_price_and_inventory', { items });
    expect(sent().data).toEqual({ items });
  });

  it('moves a package to Invoiced with the invoice number in params, and to Picking with empty params', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    const lines = [{ lineId: 11, quantity: 2 }];
    await call('trendyol_update_package_status', { packageId: 77, status: 'Invoiced', lines, invoiceNumber: 'EME2018000025208' });
    expect(sent().data).toEqual({ status: 'Invoiced', lines, params: { invoiceNumber: 'EME2018000025208' } });
    mockedAxios.mockClear();
    await call('trendyol_update_package_status', { packageId: 77, status: 'Picking', lines });
    expect(sent().data).toEqual({ status: 'Picking', lines, params: {} });
  });

  it('approves claim items with the body Trendyol expects', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('trendyol_approve_claim_items', { claimId: 'c-1', claimLineItemIdList: ['ci-1', 'ci-2'] });
    expect(sent().data).toEqual({ claimLineItemIdList: ['ci-1', 'ci-2'], params: {} });
  });

  it('sends a claim rejection as multipart, with an optional evidence file', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('trendyol_reject_claim_items', { claimId: 'c-1', claimIssueReasonId: 401, claimItemIdList: 'ci-1,ci-2', description: 'Missing item' });
    expect(sent().data).toBeInstanceOf(FormData);
    const text = (sent().data as FormData).getBuffer().toString('utf8');
    expect(text).toMatch(/name="claimIssueReasonId"\r\n\r\n401\r\n/);
    expect(text).toMatch(/name="claimItemIdList"\r\n\r\nci-1,ci-2\r\n/);
    expect(text).not.toContain('name="files"');
    mockedAxios.mockClear();
    mockedFetchOutbound.mockResolvedValue({ status: 200, headers: { 'content-type': 'image/jpeg' }, body: Buffer.from('jpg'), finalUrl: 'https://img.example.com/box.jpg' } as any);
    await call('trendyol_reject_claim_items', { claimId: 'c-1', claimIssueReasonId: 401, claimItemIdList: 'ci-1', description: 'Missing item', file_url: 'https://img.example.com/box.jpg' });
    expect((sent().data as FormData).getBuffer().toString('utf8')).toMatch(/name="files"; filename="box.jpg"/);
  });

  it('answers a question with the text only', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('trendyol_answer_question', { id: 9, text: 'Yes, it is cotton.' });
    expect(sent().data).toEqual({ text: 'Yes, it is cotton.' });
  });

  it('asks for categories in the language given and pages settlements by 500', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('trendyol_list_categories', { name: 'Shoes', language: 'en' });
    expect(sent().params).toEqual({ name: 'Shoes' });
    expect(sent().headers['Accept-Language']).toBe('en');
    mockedAxios.mockClear();
    await call('trendyol_list_settlements', { transactionType: 'Sale', startDate: 1759276800000, endDate: 1760486400000 });
    expect(sent().params).toEqual({ transactionType: 'Sale', startDate: 1759276800000, endDate: 1760486400000, size: 500 });
  });

  it('documents the setup, epoch dates, async writes and limits', () => {
    expect(a.instructions).toContain('Entegrasyon Bilgileri');
    expect(a.instructions).toContain('SelfIntegration');
    expect(a.instructions).toMatch(/epoch milliseconds/);
    expect(a.instructions).toContain('batchRequestId');
    expect(a.instructions).toMatch(/50 requests per 10 seconds/);
    expect(a.instructions).toMatch(/15 October 2026/);
    expect(a.verifyHints['401']).toContain('TRENDYOL_API_KEY');
  });
});

const publicLive = process.env.RUN_TRENDYOL_LIVE === '1' ? describe : describe.skip;

publicLive('trendyol adapter: live public lookups', () => {
  // Placeholder credentials: these lookups answer without a seller account.
  const env = { ...ENV, TRENDYOL_SELLER_ID: '1' };
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, params);

  it('finds a category, its attributes and their values', async () => {
    const cats = await run('trendyol_list_categories', { name: 'Casual' });
    expect(Array.isArray(cats.categories)).toBe(true);
    const attrs = await run('trendyol_get_category_attributes', { categoryId: 411, required: true });
    expect(attrs.id).toBe(411);
    const attr = attrs.categoryAttributes[0].attribute.id;
    const values = await run('trendyol_list_attribute_values', { categoryId: 411, attributeId: attr, size: 5 });
    expect(Array.isArray(values.content)).toBe(true);
  }, 60_000);

  it('finds brands, cargo providers and claim rejection reasons', async () => {
    expect((await run('trendyol_search_brands', { name: 'Nike' })).some((b: { name: string }) => b.name === 'Nike')).toBe(true);
    expect(Array.isArray((await run('trendyol_list_brands', { size: 5 })).brands)).toBe(true);
    expect((await run('trendyol_list_cargo_providers')).some((c: { code: string }) => c.code === 'YKMP')).toBe(true);
    expect(Array.isArray(await run('trendyol_list_claim_issue_reasons'))).toBe(true);
  }, 60_000);

  it('is refused with 401 on seller data without valid credentials', async () => {
    await expect(run('trendyol_list_orders', { size: 1 })).rejects.toMatchObject({ status: 401 });
  }, 60_000);
});

const LIVE_SELLER = process.env.TRENDYOL_SELLER_ID;
const LIVE_KEY = process.env.TRENDYOL_API_KEY;
const LIVE_SECRET = process.env.TRENDYOL_API_SECRET;
const live = LIVE_SELLER && LIVE_KEY && LIVE_SECRET ? describe : describe.skip;

live('trendyol adapter: live seller reads', () => {
  const env: Record<string, string> = {
    TRENDYOL_API_HOST: process.env.TRENDYOL_API_HOST || PROD,
    TRENDYOL_SELLER_ID: LIVE_SELLER as string,
    TRENDYOL_API_KEY: LIVE_KEY as string,
    TRENDYOL_API_SECRET: LIVE_SECRET as string,
  };
  if (process.env.TRENDYOL_STOREFRONT_CODE) env.TRENDYOL_STOREFRONT_CODE = process.env.TRENDYOL_STOREFRONT_CODE;
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, params);

  it('reads products, stock and prices', async () => {
    const products = await run('trendyol_list_products', { size: 2 });
    expect(Array.isArray(products.content)).toBe(true);
    expect(Array.isArray((await run('trendyol_list_stock_and_prices', { size: 2 })).content)).toBe(true);
    expect(Array.isArray((await run('trendyol_list_unapproved_products', { size: 2 })).content)).toBe(true);
    const barcode = products.content[0]?.variants?.[0]?.barcode;
    if (barcode) expect((await run('trendyol_get_product', { barcode })).barcode).toBe(barcode);
  }, 120_000);

  it('reads orders, claims, questions, addresses and settlements', async () => {
    expect(Array.isArray((await run('trendyol_list_orders', { size: 2 })).content)).toBe(true);
    expect(Array.isArray((await run('trendyol_list_claims', { size: 2 })).content)).toBe(true);
    expect(Array.isArray((await run('trendyol_list_questions', { size: 2 })).content)).toBe(true);
    expect((await run('trendyol_list_addresses')).supplierAddresses).toBeDefined();
    const end = Date.now();
    const settlements = await run('trendyol_list_settlements', { transactionType: 'Sale', startDate: end - 14 * 86_400_000, endDate: end });
    expect(Array.isArray(settlements.content)).toBe(true);
  }, 120_000);
});
