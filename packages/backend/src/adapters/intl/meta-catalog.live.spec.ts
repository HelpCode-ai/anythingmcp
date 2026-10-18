import axios from 'axios';
import * as adapter from './meta-catalog.json';
import * as metaAds from './meta-ads.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Meta Catalog adapter (Graph API product catalog reference, checked 18 Oct 2026).
 *
 *   1. Static: always runs. Pins the bearer token on the same Graph API
 *      version as Meta Ads, the business id in the catalog list paths, the
 *      default field lists, every tool's method and URL, the form-encoded
 *      writes (items_batch sends `requests` as JSON text) and that every write
 *      is installed switched off. axios is mocked: nothing leaves the box.
 *
 *   2. Live: RUN_META_CATALOG_LIVE=1 only checks, with a made-up token, that
 *      Graph API v26.0 answers and refuses it (OAuthException 190). It never
 *      reads or changes a real catalog:
 *
 *        RUN_META_CATALOG_LIVE=1 npx jest src/adapters/intl/meta-catalog.live.spec.ts
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
  parameters: { properties?: Record<string, { default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    bodyEncoding?: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  icon: string;
  instructions: string;
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

// Built at run time so no literal here looks like a real token.
const TOKEN = 'EAA' + 'x'.repeat(40);
const ENV = { META_CATALOG_ACCESS_TOKEN: TOKEN, META_CATALOG_BUSINESS_ID: '1234567890' };
const BASE = 'https://graph.facebook.com/v26.0';
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep({ ...a.connector.authConfig }, env), headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, params);
const sent = () => mockedAxios.mock.calls[0][0];
const form = () => new URLSearchParams(String(sent().data));
const WRITES = [
  'meta_catalog_batch_update_items',
  'meta_catalog_create_product',
  'meta_catalog_update_product',
  'meta_catalog_delete_product',
];

describe('meta-catalog adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the token as a bearer header to the Graph API version Meta Ads uses', async () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{META_CATALOG_ACCESS_TOKEN}}' });
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.baseUrl).toBe((metaAds as { connector: { baseUrl: string } }).connector.baseUrl);
    expect(a.instructions).toContain('v26.0');
    expect(a.icon).toBe('meta-ads');
    mockedAxios.mockResolvedValue({ data: {} });
    await call('meta_catalog_list_catalogs', {});
    expect(sent().headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(sent().params)).not.toContain(TOKEN);
  });

  it('checks the token and the numeric business id', () => {
    expect(a.requiredEnvVars).toEqual(['META_CATALOG_ACCESS_TOKEN', 'META_CATALOG_BUSINESS_ID']);
    const token = new RegExp(a.envVarMeta.META_CATALOG_ACCESS_TOKEN.pattern!);
    expect(token.test(TOKEN)).toBe(true);
    expect(token.test(`Bearer ${TOKEN}`)).toBe(false);
    const biz = new RegExp(a.envVarMeta.META_CATALOG_BUSINESS_ID.pattern!);
    expect(biz.test('123456789012345')).toBe(true);
    expect(biz.test('act_123456789')).toBe(false);
    expect(describeAdapterEnvVars(a as never).find((d) => d.name === 'META_CATALOG_ACCESS_TOKEN')!.secret).toBe(true);
  });

  it('probes with the token permissions, which read nothing of the catalog', () => {
    expect(a.probe).toEqual({ tool: 'meta_catalog_check_permissions' });
    expect(tool('meta_catalog_check_permissions').endpointMapping).toEqual({ method: 'GET', path: '/me/permissions' });
    expect(a.connector.healthcheckPath).toBe('/me/permissions');
  });

  it('prefixes every tool with meta_catalog_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^meta_catalog_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('reads with GET and installs every write switched off', () => {
    for (const t of a.tools) {
      const ann = annotationsOf(t);
      if (WRITES.includes(t.name)) {
        expect(`${t.name}:${t.enabled}:${ann.readOnlyHint}`).toBe(`${t.name}:false:false`);
        expect(t.description).toMatch(/confirm|wait for the user/i);
      } else {
        expect(`${t.name}:${t.endpointMapping.method}:${t.enabled}:${ann.readOnlyHint}`).toBe(`${t.name}:GET:undefined:true`);
      }
    }
  });

  it('asks for useful fields by default on every read of a node or list', () => {
    const noFields = ['meta_catalog_check_permissions', 'meta_catalog_get_diagnostics', 'meta_catalog_check_batch_status'];
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'GET' && !noFields.includes(x.name))) {
      expect(`${t.name}:${typeof t.parameters.properties?.fields?.default}`).toBe(`${t.name}:string`);
      expect(t.endpointMapping.queryParams?.fields).toBe('$fields');
    }
    expect(tool('meta_catalog_list_products').parameters.properties!.fields.default).toContain('review_status');
  });

  it('only points the model at tools that exist, refers Instagram to its own connector, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bmeta_catalog_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bmeta_catalog_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions).toMatch(/Instagram connector/);
    expect(a.tools.some((t) => /instagram/i.test(t.endpointMapping.path))).toBe(false);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['meta_catalog_check_permissions', {}, 'GET', `${BASE}/me/permissions`],
    ['meta_catalog_list_businesses', {}, 'GET', `${BASE}/me/businesses`],
    ['meta_catalog_list_catalogs', {}, 'GET', `${BASE}/1234567890/owned_product_catalogs`],
    ['meta_catalog_list_client_catalogs', {}, 'GET', `${BASE}/1234567890/client_product_catalogs`],
    ['meta_catalog_get_catalog', { catalog_id: '42' }, 'GET', `${BASE}/42`],
    ['meta_catalog_list_products', { catalog_id: '42' }, 'GET', `${BASE}/42/products`],
    ['meta_catalog_get_product', { product_id: '77' }, 'GET', `${BASE}/77`],
    ['meta_catalog_list_product_sets', { catalog_id: '42' }, 'GET', `${BASE}/42/product_sets`],
    ['meta_catalog_get_product_set', { product_set_id: '55' }, 'GET', `${BASE}/55`],
    ['meta_catalog_list_product_set_products', { product_set_id: '55' }, 'GET', `${BASE}/55/products`],
    ['meta_catalog_list_feeds', { catalog_id: '42' }, 'GET', `${BASE}/42/product_feeds`],
    ['meta_catalog_list_feed_uploads', { feed_id: '66' }, 'GET', `${BASE}/66/uploads`],
    ['meta_catalog_list_upload_errors', { upload_id: '88' }, 'GET', `${BASE}/88/errors`],
    ['meta_catalog_get_diagnostics', { catalog_id: '42' }, 'GET', `${BASE}/42/diagnostics`],
    ['meta_catalog_check_batch_status', { catalog_id: '42', handle: 'h1' }, 'GET', `${BASE}/42/check_batch_request_status`],
    ['meta_catalog_batch_update_items', { catalog_id: '42', requests: [] }, 'POST', `${BASE}/42/items_batch`],
    ['meta_catalog_create_product', { catalog_id: '42', retailer_id: 's', name: 'n', price: 1, currency: 'EUR', image_url: 'https://example.com/i.jpg' }, 'POST', `${BASE}/42/products`],
    ['meta_catalog_update_product', { product_id: '77', availability: 'out of stock' }, 'POST', `${BASE}/77`],
    ['meta_catalog_delete_product', { product_id: '77' }, 'DELETE', `${BASE}/77`],
  ];
  it('covers every tool in the table', () => {
    expect(table.map((r) => r[0]).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });
  it.each(table)('%s calls %s %s', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(sent().method.toUpperCase()).toBe(method);
    expect(sent().url).toBe(url);
  });

  it('passes filter, error_priority, summary and the after cursor to the products edge', async () => {
    mockedAxios.mockResolvedValue({ data: { data: [] } });
    const filter = '{"availability":{"eq":"out of stock"}}';
    await call('meta_catalog_list_products', { catalog_id: '42', filter, error_priority: 'HIGH', summary: 'total_count', after: 'QVFI', limit: 100 });
    expect(sent().params).toMatchObject({ filter, error_priority: 'HIGH', summary: 'total_count', after: 'QVFI', limit: 100 });
    expect(String(sent().params.fields)).toContain('retailer_id');
  });

  it('sends the batch requests as one JSON form field, as the Batch API expects', async () => {
    mockedAxios.mockResolvedValue({ data: { handles: ['h1'] } });
    const requests = [{ method: 'UPDATE', data: { id: 'sku-1', price: '19.99 EUR', availability: 'in stock' } }];
    await call('meta_catalog_batch_update_items', { catalog_id: '42', requests });
    const body = form();
    expect(body.get('item_type')).toBe('PRODUCT_ITEM');
    expect(body.get('allow_upsert')).toBe('true');
    expect(JSON.parse(body.get('requests')!)).toEqual(requests);
  });

  it('updates a single product with only the fields given, form-encoded', async () => {
    mockedAxios.mockResolvedValue({ data: { success: true } });
    await call('meta_catalog_update_product', { product_id: '77', price: 1999, currency: 'EUR' });
    const body = form();
    expect(body.get('price')).toBe('1999');
    expect(body.get('currency')).toBe('EUR');
    expect(body.has('availability')).toBe(false);
  });
});

const maybe = process.env.RUN_META_CATALOG_LIVE ? describe : describe.skip;
maybe('meta-catalog adapter: live edge reachability (bogus token, no catalog access)', () => {
  it('GET /me/permissions on v26.0 refuses a bogus token with OAuthException 190', async () => {
    const res = await mockedAxios.__actual.request({
      method: 'GET',
      url: `${BASE}/me/permissions`,
      headers: { Authorization: 'Bearer bogus' },
      validateStatus: () => true,
      timeout: 20000,
    });
    expect([400, 401]).toContain(res.status);
    expect(res.data?.error?.code).toBe(190);
  }, 30000);
});
