import axios from 'axios';
import * as adapter from './google-merchant-center.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';

/**
 * Google Merchant API v1 (developers.google.com/merchant/api, discovery documents
 * merchantapi.googleapis.com/$discovery/rest?version=<sub-api>_v1), the successor
 * of the Content API for Shopping v2.1 (sunset 18 August 2026). One host, one
 * sub-API per path prefix (accounts, products, datasources, reports, inventories,
 * promotions, notifications, issueresolution, quota), OAuth2 with the `content`
 * scope, the Merchant Center account id from GOOGLE_MERCHANT_ACCOUNT_ID.
 *
 * Static part: always runs. Live part (reads only) needs an access token with the
 * content scope from a Cloud project already registered with the account:
 *   RUN_GOOGLE_MERCHANT_CENTER_LIVE=1 GOOGLE_ACCESS_TOKEN=ya29... GOOGLE_MERCHANT_ACCOUNT_ID=123 \
 *     npx jest src/adapters/intl/google-merchant-center
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

type Mapping = {
  method: string;
  path: string;
  encodePathParams?: boolean;
  queryParams?: Record<string, unknown>;
  bodyMapping?: Record<string, unknown>;
  headers?: Record<string, string>;
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: Mapping;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind?: string; pattern?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};

const PREFIX = 'google_merchant_center_';
const BASE = 'https://merchantapi.googleapis.com';
const ACC = '{{GOOGLE_MERCHANT_ACCOUNT_ID}}';
// The connector service resolves {{VAR}} before the engine runs; do the same here.
const resolve = (m: Mapping, account: string): Mapping => JSON.parse(JSON.stringify(m).split(ACC).join(account));
const newEngine = () =>
  new RestEngine({ getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService, {} as LoginTokenService);
const connectorConfig = () => ({
  baseUrl: a.connector.baseUrl,
  authType: a.connector.authType,
  authConfig: { ...a.connector.authConfig },
  headers: { ...a.connector.headers },
});
const call = (name: string, params: Record<string, unknown>) =>
  newEngine().execute(connectorConfig(), resolve(tool(name).endpointMapping, '123'), applySchemaDefaults(tool(name).parameters, params));
const sent = () => mockedAxios.mock.calls[0][0];

describe('google-merchant-center adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in with the shared Google OAuth client and the content scope, on the configured account', () => {
    expect(a.requiredEnvVars).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_MERCHANT_ACCOUNT_ID']);
    expect(a.envVarMeta.GOOGLE_MERCHANT_ACCOUNT_ID.kind).toBe('setting');
    expect(new RegExp(a.envVarMeta.GOOGLE_MERCHANT_ACCOUNT_ID.pattern as string).test('123456789')).toBe(true);
    expect(new RegExp(a.envVarMeta.GOOGLE_MERCHANT_ACCOUNT_ID.pattern as string).test('accounts/123')).toBe(false);
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{GOOGLE_CLIENT_ID}}',
      clientSecret: '{{GOOGLE_CLIENT_SECRET}}',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: 'https://www.googleapis.com/auth/content',
    });
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toContain('18 August 2026');
    expect(a.instructions).toContain('`GOOGLE_MERCHANT_ACCOUNT_ID`');
  });

  it('uses only Merchant API v1 paths, scoped to the configured account except the account list', () => {
    for (const t of a.tools) {
      const p = t.endpointMapping.path;
      expect(p).toMatch(/^\/[a-z]+\/v1\/accounts/);
      expect(p).not.toContain('v1beta');
      expect(p).not.toContain('content/v2');
      if (t.name !== 'google_merchant_center_list_accounts') expect(`${t.name}:${p.includes(`/accounts/${ACC}`)}`).toBe(`${t.name}:true`);
    }
  });

  it.each([
    ['google_merchant_center_get_account', {}, 'GET', '/accounts/v1/accounts/123'],
    ['google_merchant_center_list_accounts', {}, 'GET', '/accounts/v1/accounts'],
    ['google_merchant_center_list_subaccounts', {}, 'GET', '/accounts/v1/accounts/123:listSubaccounts'],
    ['google_merchant_center_get_business_info', {}, 'GET', '/accounts/v1/accounts/123/businessInfo'],
    ['google_merchant_center_get_homepage', {}, 'GET', '/accounts/v1/accounts/123/homepage'],
    ['google_merchant_center_list_account_issues', {}, 'GET', '/accounts/v1/accounts/123/issues'],
    ['google_merchant_center_list_programs', {}, 'GET', '/accounts/v1/accounts/123/programs'],
    ['google_merchant_center_get_shipping_settings', {}, 'GET', '/accounts/v1/accounts/123/shippingSettings'],
    ['google_merchant_center_list_regions', {}, 'GET', '/accounts/v1/accounts/123/regions'],
    ['google_merchant_center_list_users', {}, 'GET', '/accounts/v1/accounts/123/users'],
    ['google_merchant_center_get_developer_registration', {}, 'GET', '/accounts/v1/accounts/123/developerRegistration'],
    ['google_merchant_center_register_gcp_project', {}, 'POST', '/accounts/v1/accounts/123/developerRegistration:registerGcp'],
    ['google_merchant_center_list_products', {}, 'GET', '/products/v1/accounts/123/products'],
    ['google_merchant_center_get_product', { product_id: 'en~US~sku 1' }, 'GET', '/products/v1/accounts/123/products/en~US~sku%201'],
    ['google_merchant_center_insert_product_input', { data_source_id: '9', offer_id: 's', content_language: 'en', feed_label: 'US', product_attributes: {} }, 'POST', '/products/v1/accounts/123/productInputs:insert'],
    ['google_merchant_center_update_product_input', { product_id: 'en~US~s', data_source_id: '9' }, 'PATCH', '/products/v1/accounts/123/productInputs/en~US~s'],
    ['google_merchant_center_delete_product_input', { product_id: 'en~US~s', data_source_id: '9' }, 'DELETE', '/products/v1/accounts/123/productInputs/en~US~s'],
    ['google_merchant_center_list_data_sources', {}, 'GET', '/datasources/v1/accounts/123/dataSources'],
    ['google_merchant_center_get_data_source', { data_source_id: '9' }, 'GET', '/datasources/v1/accounts/123/dataSources/9'],
    ['google_merchant_center_get_latest_file_upload', { data_source_id: '9' }, 'GET', '/datasources/v1/accounts/123/dataSources/9/fileUploads/latest'],
    ['google_merchant_center_create_data_source', { display_name: 'x' }, 'POST', '/datasources/v1/accounts/123/dataSources'],
    ['google_merchant_center_update_data_source', { data_source_id: '9', update_mask: 'displayName' }, 'PATCH', '/datasources/v1/accounts/123/dataSources/9'],
    ['google_merchant_center_fetch_data_source', { data_source_id: '9' }, 'POST', '/datasources/v1/accounts/123/dataSources/9:fetch'],
    ['google_merchant_center_list_aggregate_product_statuses', {}, 'GET', '/issueresolution/v1/accounts/123/aggregateProductStatuses'],
    ['google_merchant_center_search_reports', { query: 'SELECT offer_id FROM product_view' }, 'POST', '/reports/v1/accounts/123/reports:search'],
    ['google_merchant_center_list_local_inventories', { product_id: 'en~US~s' }, 'GET', '/inventories/v1/accounts/123/products/en~US~s/localInventories'],
    ['google_merchant_center_insert_local_inventory', { product_id: 'en~US~s', store_code: 'S1', local_inventory_attributes: {} }, 'POST', '/inventories/v1/accounts/123/products/en~US~s/localInventories:insert'],
    ['google_merchant_center_delete_local_inventory', { product_id: 'en~US~s', store_code: 'S1' }, 'DELETE', '/inventories/v1/accounts/123/products/en~US~s/localInventories/S1'],
    ['google_merchant_center_list_regional_inventories', { product_id: 'en~US~s' }, 'GET', '/inventories/v1/accounts/123/products/en~US~s/regionalInventories'],
    ['google_merchant_center_insert_regional_inventory', { product_id: 'en~US~s', region: 'R1', regional_inventory_attributes: {} }, 'POST', '/inventories/v1/accounts/123/products/en~US~s/regionalInventories:insert'],
    ['google_merchant_center_delete_regional_inventory', { product_id: 'en~US~s', region: 'R1' }, 'DELETE', '/inventories/v1/accounts/123/products/en~US~s/regionalInventories/R1'],
    ['google_merchant_center_list_promotions', {}, 'GET', '/promotions/v1/accounts/123/promotions'],
    ['google_merchant_center_get_promotion', { promotion_id: 'en~US~P1' }, 'GET', '/promotions/v1/accounts/123/promotions/en~US~P1'],
    ['google_merchant_center_insert_promotion', { data_source_id: '9', promotion_id: 'P1', content_language: 'en', target_country: 'US', redemption_channel: ['ONLINE'], attributes: {} }, 'POST', '/promotions/v1/accounts/123/promotions:insert'],
    ['google_merchant_center_list_notification_subscriptions', {}, 'GET', '/notifications/v1/accounts/123/notificationsubscriptions'],
    ['google_merchant_center_get_notification_subscription', { subscription_id: 'n1' }, 'GET', '/notifications/v1/accounts/123/notificationsubscriptions/n1'],
    ['google_merchant_center_create_notification_subscription', { registered_event: 'PRODUCT_STATUS_CHANGE', call_back_uri: 'https://x.example/h' }, 'POST', '/notifications/v1/accounts/123/notificationsubscriptions'],
    ['google_merchant_center_update_notification_subscription', { subscription_id: 'n1', call_back_uri: 'https://x.example/h' }, 'PATCH', '/notifications/v1/accounts/123/notificationsubscriptions/n1'],
    ['google_merchant_center_delete_notification_subscription', { subscription_id: 'n1' }, 'DELETE', '/notifications/v1/accounts/123/notificationsubscriptions/n1'],
    ['google_merchant_center_list_quotas', {}, 'GET', '/quota/v1/accounts/123/quotas'],
  ])('%s sends %s to the documented Merchant API URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ method, url: `${BASE}${path}`, headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }),
    );
  });

  it('covers every tool with a URL check above', () => {
    expect(a.tools).toHaveLength(40);
  });

  it('writes product inputs into an API data source of the same account', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const attrs = { title: 'Shoe', price: { amountMicros: '59990000', currencyCode: 'EUR' }, availability: 'IN_STOCK' };
    await call('google_merchant_center_insert_product_input', { data_source_id: '456', offer_id: 'sku1', content_language: 'en', feed_label: 'US', product_attributes: attrs });
    expect(sent().params).toEqual({ dataSource: 'accounts/123/dataSources/456' });
    expect(sent().data).toEqual({ offerId: 'sku1', contentLanguage: 'en', feedLabel: 'US', productAttributes: attrs });
    mockedAxios.mockClear();
    await call('google_merchant_center_update_product_input', {
      product_id: 'en~US~sku1',
      data_source_id: '456',
      update_mask: 'product_attributes.availability',
      product_attributes: { availability: 'OUT_OF_STOCK' },
    });
    expect(sent().params).toEqual({ dataSource: 'accounts/123/dataSources/456', updateMask: 'product_attributes.availability' });
    expect(sent().data).toEqual({ productAttributes: { availability: 'OUT_OF_STOCK' } });
  });

  it('sends reports, inventory, promotions and notifications with the documented body fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('google_merchant_center_search_reports', { query: 'SELECT offer_id, clicks FROM product_performance_view WHERE date DURING LAST_7_DAYS', page_size: 100 });
    expect(sent().data).toEqual({ query: 'SELECT offer_id, clicks FROM product_performance_view WHERE date DURING LAST_7_DAYS', pageSize: 100 });
    mockedAxios.mockClear();
    await call('google_merchant_center_insert_local_inventory', { product_id: 'en~US~s', store_code: 'S1', local_inventory_attributes: { availability: 'IN_STOCK', quantity: '3' } });
    expect(sent().data).toEqual({ storeCode: 'S1', localInventoryAttributes: { availability: 'IN_STOCK', quantity: '3' } });
    mockedAxios.mockClear();
    await call('google_merchant_center_insert_regional_inventory', { product_id: 'en~US~s', region: 'R1', regional_inventory_attributes: { availability: 'IN_STOCK' } });
    expect(sent().data).toEqual({ region: 'R1', regionalInventoryAttributes: { availability: 'IN_STOCK' } });
    mockedAxios.mockClear();
    await call('google_merchant_center_insert_promotion', { data_source_id: '9', promotion_id: 'P1', content_language: 'en', target_country: 'US', redemption_channel: ['ONLINE'], attributes: { longTitle: 'x' } });
    expect(sent().data).toEqual({
      dataSource: 'accounts/123/dataSources/9',
      promotion: { promotionId: 'P1', contentLanguage: 'en', targetCountry: 'US', redemptionChannel: ['ONLINE'], attributes: { longTitle: 'x' } },
    });
    mockedAxios.mockClear();
    await call('google_merchant_center_create_notification_subscription', { registered_event: 'PRODUCT_STATUS_CHANGE', call_back_uri: 'https://x.example/h', target_account_id: '123' });
    expect(sent().data).toEqual({ registeredEvent: 'PRODUCT_STATUS_CHANGE', callBackUri: 'https://x.example/h', targetAccount: 'accounts/123' });
    mockedAxios.mockClear();
    await call('google_merchant_center_create_notification_subscription', { registered_event: 'PRODUCT_STATUS_CHANGE', call_back_uri: 'https://x.example/h', all_managed_accounts: true });
    expect(sent().data).toEqual({ registeredEvent: 'PRODUCT_STATUS_CHANGE', callBackUri: 'https://x.example/h', allManagedAccounts: true });
    mockedAxios.mockClear();
    await call('google_merchant_center_update_notification_subscription', { subscription_id: 'n1', call_back_uri: 'https://y.example/h' });
    expect(sent().params).toEqual({ updateMask: 'callBackUri' });
    mockedAxios.mockClear();
    await call('google_merchant_center_register_gcp_project', { developer_email: 'dev@example.com' });
    expect(sent().data).toEqual({ developerEmail: 'dev@example.com' });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('installs the deletes switched off, says so, and marks them destructive', () => {
    const off = [
      'google_merchant_center_delete_local_inventory',
      'google_merchant_center_delete_notification_subscription',
      'google_merchant_center_delete_product_input',
      'google_merchant_center_delete_regional_inventory',
    ];
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(off);
    expect(a.tools.filter((t) => t.endpointMapping.method === 'DELETE').map((t) => t.name).sort()).toEqual(off);
    expect(a.instructions).toContain(
      '**Switched off at install**: `google_merchant_center_delete_product_input`, `google_merchant_center_delete_local_inventory`, `google_merchant_center_delete_regional_inventory` and `google_merchant_center_delete_notification_subscription`; they cannot be undone',
    );
    for (const name of off) expect(`${name}:${annotationsOf(tool(name)).destructiveHint}`).toBe(`${name}:true`);
  });

  it('marks every GET and the report search read-only, and no write', () => {
    for (const t of a.tools) {
      const reads = t.endpointMapping.method === 'GET' || t.name === 'google_merchant_center_search_reports';
      expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:${reads}`);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe).toEqual({ tool: 'google_merchant_center_get_account' });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    expect(a.connector.healthcheckPath).toBe(`/accounts/v1/accounts/${ACC}`);
    const names = new Set(a.tools.map((t) => t.name));
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(`\`${t.name}\``)}`).toBe(`${t.name}:true`);
    const mentioned = [
      ...a.instructions.matchAll(/\bgoogle_merchant_center_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgoogle_merchant_center_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/—/);
  });
});

const TOKEN = process.env.GOOGLE_ACCESS_TOKEN;
const ACCOUNT = process.env.GOOGLE_MERCHANT_ACCOUNT_ID;
const live = process.env.RUN_GOOGLE_MERCHANT_CENTER_LIVE === '1' && TOKEN && ACCOUNT ? describe : describe.skip;

live('google-merchant-center adapter: live (read-only)', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
      { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: TOKEN as string }, headers: a.connector.headers },
      resolve(tool(name).endpointMapping, ACCOUNT as string),
      applySchemaDefaults(tool(name).parameters, params),
    );

  it('reads the account, its issues, data sources, products and statuses', async () => {
    expect((await run('google_merchant_center_get_account')).accountId).toBe(ACCOUNT);
    await run('google_merchant_center_get_developer_registration');
    await run('google_merchant_center_list_account_issues');
    await run('google_merchant_center_list_programs');
    await run('google_merchant_center_list_data_sources');
    const products = await run('google_merchant_center_list_products', { page_size: 2 });
    if (products.products?.length) {
      const id = String(products.products[0].name).split('/products/')[1];
      expect((await run('google_merchant_center_get_product', { product_id: id })).name).toBe(products.products[0].name);
      await run('google_merchant_center_list_local_inventories', { product_id: id });
    }
    await run('google_merchant_center_list_aggregate_product_statuses');
    await run('google_merchant_center_list_quotas');
  }, 60_000);

  it('runs a product status report', async () => {
    const report = await run('google_merchant_center_search_reports', {
      query: 'SELECT id, offer_id, title, aggregated_reporting_context_status FROM product_view LIMIT 5',
    });
    expect(report).toBeDefined();
  }, 60_000);
});
