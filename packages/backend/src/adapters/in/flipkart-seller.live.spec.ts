import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import * as adapter from './flipkart-seller.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { PrismaService } from '../../common/prisma.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { needsBrowserAuthorization } from '../env-var-meta';

/**
 * Flipkart Marketplace Seller API v3 (seller.flipkart.com/api-docs/FMSAPI.html,
 * paths and bodies cross-checked with Flipkart's generated Java SDK,
 * github.com/Flipkart/flipkart-seller-api-java-sdk): base
 * https://api.flipkart.net/sellers, OAuth2 client credentials with scope
 * Seller_Api and the application id and secret as HTTP Basic.
 *
 * Static checks run every request through the real RestEngine with axios mocked.
 * Live part (reads only: listings, listing details, pre-dispatch shipments, returns):
 *   RUN_FLIPKART_SELLER_LIVE=1 FLIPKART_APP_ID=... FLIPKART_APP_SECRET=... npx jest src/adapters/in/flipkart-seller
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
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; bodyTemplate?: string; headers?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations } as never);

// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings and body templates.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.bodyTemplate ?? '');
  walk(m.headers ?? {});
  return out;
};

const BASE = 'https://api.flipkart.net/sellers';
const TOKEN_URL = 'https://api.flipkart.net/oauth-service/oauth/token';
// Built at run time so no literal here looks like a real secret.
const SECRET = ['a1b2c3d4', 'e5f6g7h8'].join('');
const ENV = { FLIPKART_APP_ID: 'myapp1234', FLIPKART_APP_SECRET: SECRET };
const SHIP = 'f2bd1e7a-1b2c-4d5e-8f90-123456789abc';

const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>, tokens?: OAuth2TokenService) => {
  const tokenService = tokens ?? ({ getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService);
  return new RestEngine(tokenService, {} as LoginTokenService).execute(
    { baseUrl: a.connector.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep({ ...a.connector.authConfig }, env), headers: a.connector.headers } as never,
    interpolateDeep(tool(name).endpointMapping, env) as never,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown> = {}) => execute(name, ENV, params);
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = ['flipkart_seller_update_price', 'flipkart_seller_update_inventory', 'flipkart_seller_generate_labels', 'flipkart_seller_mark_ready_to_dispatch', 'flipkart_seller_cancel_shipments'];
const READ_POSTS = ['flipkart_seller_search_listings', 'flipkart_seller_search_products', 'flipkart_seller_get_listings', 'flipkart_seller_search_shipments', 'flipkart_seller_download_manifest'];

describe('flipkart-seller adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is an in/e-commerce adapter with its own icon', () => {
    expect(a.slug).toBe('flipkart-seller');
    expect(a.region).toBe('in');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('flipkart');
  });

  it('signs in with client credentials, scope Seller_Api, without a browser', () => {
    expect(a.requiredEnvVars).toEqual(['FLIPKART_APP_ID', 'FLIPKART_APP_SECRET']);
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{FLIPKART_APP_ID}}',
      clientSecret: '{{FLIPKART_APP_SECRET}}',
      tokenUrl: TOKEN_URL,
      tokenAuthMethod: 'client_secret_basic',
      scope: 'Seller_Api',
    });
    expect(needsBrowserAuthorization(a as never)).toBe(false);
    expect(a.envVarMeta.FLIPKART_APP_SECRET.secret).toBe(true);
  });

  it('asks the token endpoint with the app id and secret as HTTP Basic', async () => {
    const service = new OAuth2TokenService({} as PrismaService, { get: () => 'test-encryption-key-32-chars!!!!' } as unknown as ConfigService);
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: { access_token: 'tok-1', token_type: 'bearer', expires_in: 3330779, scope: 'Seller_Api' } } as never);
    await expect(service.getAccessToken(interpolateDeep({ ...a.connector.authConfig }, ENV))).resolves.toBe('tok-1');
    const [url, body, options] = post.mock.calls[0] as unknown as [string, string, { headers: Record<string, string> }];
    expect(url).toBe(TOKEN_URL);
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({ grant_type: 'client_credentials', scope: 'Seller_Api' });
    expect(options.headers.Authorization).toBe(`Basic ${Buffer.from(`myapp1234:${SECRET}`).toString('base64')}`);
    post.mockRestore();
  });

  it('sends the bearer token on API calls', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('flipkart_seller_search_listings');
    expect(sent().headers.Authorization).toBe('Bearer test-token');
    expect(JSON.stringify(sent())).not.toContain(SECRET);
  });

  // [tool, args, method, url]
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['flipkart_seller_search_listings', {}, 'POST', `${BASE}/listings/v3/search`],
    ['flipkart_seller_search_products', {}, 'POST', `${BASE}/listings/v3/product/search`],
    ['flipkart_seller_get_listings', { skus: ['A1'] }, 'POST', `${BASE}/listings/v3/details`],
    ['flipkart_seller_update_price', { sku: 'A1', product_id: 'ABCDEFGHIJKLMNOP', mrp: 999, selling_price: 799 }, 'POST', `${BASE}/listings/v3/update/price`],
    ['flipkart_seller_update_inventory', { sku: 'A1', product_id: 'ABCDEFGHIJKLMNOP', locations: [{ id: 'LOC1', inventory: 5 }] }, 'POST', `${BASE}/listings/v3/update/inventory`],
    ['flipkart_seller_search_shipments', { states: ['APPROVED'] }, 'POST', `${BASE}/v3/shipments/filter`],
    ['flipkart_seller_next_shipments_page', { next_token: 'abc' }, 'GET', `${BASE}/v3/shipments/filter`],
    ['flipkart_seller_get_shipments', { order_ids: 'OD1' }, 'GET', `${BASE}/v3/shipments`],
    ['flipkart_seller_get_shipment_details', { shipment_ids: `${SHIP},S2` }, 'GET', `${BASE}/v3/shipments/${SHIP},S2`],
    ['flipkart_seller_generate_labels', { shipments: [{ shipmentId: SHIP }] }, 'POST', `${BASE}/v3/shipments/labels`],
    ['flipkart_seller_download_labels', { shipment_ids: SHIP }, 'GET', `${BASE}/v3/shipments/${SHIP}/labels`],
    ['flipkart_seller_download_invoices', { shipment_ids: SHIP }, 'GET', `${BASE}/v3/shipments/${SHIP}/invoices`],
    ['flipkart_seller_mark_ready_to_dispatch', { shipment_ids: [SHIP], location_id: 'LOC1' }, 'POST', `${BASE}/v3/shipments/dispatch`],
    ['flipkart_seller_cancel_shipments', { shipment_id: SHIP, location_id: 'LOC1', cancellation_group_ids: ['g1'], reason: 'not_enough_inventory' }, 'POST', `${BASE}/v3/shipments/cancel`],
    ['flipkart_seller_get_handover_counts', { location_id: 'LOC1' }, 'GET', `${BASE}/v3/shipments/handover/counts`],
    ['flipkart_seller_download_manifest', { vendor_group_code: 'V1', location_id: 'LOC1' }, 'POST', `${BASE}/v3/shipments/manifest`],
    ['flipkart_seller_list_returns', {}, 'GET', `${BASE}/v2/returns`],
    ['flipkart_seller_get_returns', { return_ids: 'R1,R2' }, 'GET', `${BASE}/v2/returns`],
    ['flipkart_seller_next_returns_page', { next_url: '/returns?source=customer_return&nextPageToken=x' }, 'GET', `${BASE}/v2/returns?source=customer_return&nextPageToken=x`],
  ];

  it('lists every tool in the URL table', () => {
    expect([...new Set(table.map(([name]) => name))].sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s %s', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(sent().method.toUpperCase()).toBe(method);
    expect(sent().url).toBe(url);
  });

  it('builds the listing bodies as documented, keyed by SKU for updates', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('flipkart_seller_update_price', { sku: 'HD 1920/29', product_id: 'ABCDEFGHIJKLMNOP', mrp: 999, selling_price: 799 });
    expect(sent().data).toEqual({ 'HD 1920/29': { product_id: 'ABCDEFGHIJKLMNOP', price: { mrp: 999, selling_price: 799, currency: 'INR' } } });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('flipkart_seller_update_inventory', { sku: 'A"1', product_id: 'ABCDEFGHIJKLMNOP', locations: [{ id: 'LOC1', inventory: 0 }, { id: 'LOC2', inventory: 7 }] });
    expect(sent().data).toEqual({ 'A"1': { product_id: 'ABCDEFGHIJKLMNOP', locations: [{ id: 'LOC1', inventory: 0 }, { id: 'LOC2', inventory: 7 }] } });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('flipkart_seller_get_listings', { skus: ['A1', 'B2'] });
    expect(sent().data).toEqual({ sku_ids: ['A1', 'B2'] });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('flipkart_seller_search_listings', { listing_status: 'ACTIVE' });
    expect(sent().data).toEqual({ filters: { listing_status: 'ACTIVE' } });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('flipkart_seller_search_products', { search_text: 'mug' });
    expect(sent().data).toEqual({ batchNo: 0, internalState: 'ACTIVE', searchText: 'mug' });
  });

  it('builds the shipment search with only the filters given', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('flipkart_seller_search_shipments', { states: ['APPROVED', 'PACKED'], order_date: { from: '2026-10-01T00:00:00+05:30', to: '2026-10-30T00:00:00+05:30' }, sort: { field: 'orderDate', order: 'desc' } });
    expect(sent().data).toEqual({
      filter: { type: 'preDispatch', states: ['APPROVED', 'PACKED'], orderDate: { from: '2026-10-01T00:00:00+05:30', to: '2026-10-30T00:00:00+05:30' } },
      pagination: { pageSize: 20 },
      sort: { field: 'orderDate', order: 'desc' },
    });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('flipkart_seller_next_shipments_page', { next_token: 'tok==' });
    expect(sent().params).toEqual({ next_token: 'tok==' });
  });

  it('builds the shipment action bodies as documented', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('flipkart_seller_mark_ready_to_dispatch', { shipment_ids: ['S1', 'S2'], location_id: 'LOC1' });
    expect(sent().data).toEqual({ shipmentIds: ['S1', 'S2'], locationId: 'LOC1' });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('flipkart_seller_cancel_shipments', { shipment_id: 'S1', location_id: 'LOC1', cancellation_group_ids: ['g1'], reason: 'not_enough_inventory' });
    expect(sent().data).toEqual({ shipments: [{ shipmentId: 'S1', locationId: 'LOC1', cancellationGroupIds: ['g1'], reason: 'not_enough_inventory' }] });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('flipkart_seller_download_manifest', { vendor_group_code: 'V1', location_id: 'LOC1' });
    expect(sent().data).toEqual({ params: { vendorGroupCode: 'V1', locationId: 'LOC1', isMps: false } });
    expect(sent().headers.Accept).toBe('application/pdf');
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('flipkart_seller_list_returns', { created_after: '2026-10-01T00:00:00+05:30' });
    expect(sent().params).toEqual({ source: 'customer_return', createdAfter: '2026-10-01T00:00:00+05:30' });
  });

  it('keeps the returns next-page path on /v2/returns and comma-separated ids in a safe shape', () => {
    const re = new RegExp(tool('flipkart_seller_next_returns_page').parameters.properties!.next_url.pattern);
    expect(re.test('/returns?source=customer_return&page=2')).toBe(true);
    for (const bad of ['/../v3/shipments/cancel', 'https://evil.example/returns?x', '/shipments?x']) expect(re.test(bad)).toBe(false);
    const ids = new RegExp(tool('flipkart_seller_get_shipment_details').parameters.properties!.shipment_ids.pattern);
    expect(ids.test(`${SHIP},S2`)).toBe(true);
    for (const bad of ['S1/labels', 'S1, S2', '../x']) expect(ids.test(bad)).toBe(false);
  });

  it('every tool is prefixed, every declared parameter reaches the request and vice versa, path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name).toMatch(/^flipkart_seller_[a-z0-9_]+$/);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters.required).toContain(p);
      if (t.endpointMapping.bodyTemplate) for (const [, p] of t.endpointMapping.bodyTemplate.matchAll(/\$\{(\w+)\}/g)) expect(`${t.name}:${p}:${(t.parameters.required ?? []).includes(p) || t.parameters.properties?.[p]?.default !== undefined}`).toBe(`${t.name}:${p}:true`);
    }
  });

  it('marks reads read-only, writes as writes with a confirmation, and installs cancellation switched off', () => {
    for (const t of a.tools) {
      const read = t.endpointMapping.method === 'GET' || READ_POSTS.includes(t.name);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${read}`);
    }
    expect(a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort()).toEqual([...WRITES].sort());
    for (const name of WRITES) expect(`${name}:${/confirm/i.test(tool(name).description)}`).toBe(`${name}:true`);
    expect(annotationsOf(tool('flipkart_seller_cancel_shipments')).destructiveHint).toBe(true);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['flipkart_seller_cancel_shipments']);
  });

  it('probes with a read tool without required parameters and documents every tool', () => {
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
    expect(annotationsOf(tool(a.probe.tool)).readOnlyHint).toBe(true);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [...a.instructions.matchAll(/\bflipkart_seller_[a-z0-9_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bflipkart_seller_[a-z0-9_]+/g)])].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const LIVE = process.env.RUN_FLIPKART_SELLER_LIVE === '1' && !!process.env.FLIPKART_APP_ID && !!process.env.FLIPKART_APP_SECRET;

(LIVE ? describe : describe.skip)('flipkart-seller adapter: live Seller API (reads only)', () => {
  const env: Record<string, string> = { FLIPKART_APP_ID: process.env.FLIPKART_APP_ID as string, FLIPKART_APP_SECRET: process.env.FLIPKART_APP_SECRET as string };
  // The real token service, so the live run also proves the token request (POST, form body, Basic).
  const tokens = new OAuth2TokenService({} as PrismaService, { get: () => 'live-spec-encryption-key-32-chars!' } as unknown as ConfigService);
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as never));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, params, tokens);

  it('reads listings, one listing in detail, open shipments and returns', async () => {
    const listings = await run('flipkart_seller_search_listings');
    expect(Array.isArray(listings.listings)).toBe(true);
    if (listings.listings[0]) {
      const details = await run('flipkart_seller_get_listings', { skus: [listings.listings[0].sku_id] });
      expect(details.available ?? details.unavailable).toBeDefined();
    }
    const shipments = await run('flipkart_seller_search_shipments', { states: ['APPROVED'], page_size: 5 });
    expect(Array.isArray(shipments.shipments)).toBe(true);
    const returns = await run('flipkart_seller_list_returns', { created_after: new Date(Date.now() - 14 * 86400_000).toISOString() });
    expect(returns).toBeDefined();
  }, 120_000);
});
