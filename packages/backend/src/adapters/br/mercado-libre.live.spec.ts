import axios from 'axios';
import * as adapter from './mercado-libre.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';

/**
 * Mercado Libre adapter.
 *
 *   1. Static: always runs. Pins the OAuth2 setup, every listing tool's method,
 *      URL and body, which tools are read-only, destructive or switched off,
 *      and the tool names workspaces already use for their own tools.
 *
 *   2. Live: skipped unless RUN_MERCADO_LIBRE_LIVE=1. The category predictor,
 *      a category and its attributes answer without a token, so the real
 *      engine reads them; the seller routes answer 403 without one.
 *
 *        RUN_MERCADO_LIBRE_LIVE=1 npx jest src/adapters/br/mercado-libre.live.spec.ts
 *
 * The write tools were checked against the developer docs and against the
 * request bodies of workspaces' own successful listing tools (POST /items with
 * family_name, PUT /items/{id} with attributes and sale_terms), not against a
 * live seller account: Mercado Libre has no sandbox.
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
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  description: string;
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const BASE = 'https://api.mercadolibre.com';
const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
const call = (name: string, params: Record<string, unknown>) =>
  engine.execute({ baseUrl: BASE, authType: 'NONE' }, tool(name).endpointMapping as never, params);
const sent = () => mockedAxios.mock.calls[0][0];

const LISTING_TOOLS = [
  'mercado_libre_predict_category',
  'mercado_libre_get_category',
  'mercado_libre_get_category_attributes',
  'mercado_libre_get_category_sale_terms',
  'mercado_libre_list_listing_types',
  'mercado_libre_list_seller_items',
  'mercado_libre_validate_listing',
  'mercado_libre_create_listing',
  'mercado_libre_update_listing',
  'mercado_libre_set_listing_status',
  'mercado_libre_close_listing',
  'mercado_libre_get_listing_description',
  'mercado_libre_add_listing_description',
  'mercado_libre_update_listing_description',
];

const LISTING = {
  category_id: 'MLB1055',
  family_name: 'Apple iPhone 15 128GB',
  price: 4999,
  currency_id: 'BRL',
  available_quantity: 3,
  buying_mode: 'buy_it_now',
  listing_type_id: 'gold_special',
  condition: 'new',
  pictures: [{ source: 'https://example.com/1.jpg' }],
  attributes: [{ id: 'BRAND', value_name: 'Apple' }],
};

describe('mercado-libre adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in with OAuth2 and asks for write, which the listing tools need', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig.scopes.split(' ')).toEqual(expect.arrayContaining(['offline_access', 'read', 'write']));
  });

  it('keeps the read tools and adds the listing tools, all prefixed', () => {
    const names = a.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['mercado_libre_get_item', ...LISTING_TOOLS]));
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^mercado_libre_[a-z_]+$/);
  });

  it('offers no marketplace search, which Mercado Libre refuses to third-party apps', () => {
    // mercado_libre_search_items (GET /sites/{site_id}/search) answered 403
    // "forbidden" on all 26 calls in 11 workspaces (5-22 Oct 2026), while the
    // same tokens read items fine.
    expect(a.tools.map((t) => t.name)).not.toContain('mercado_libre_search_items');
    expect(a.tools.filter((t) => /^\/sites\/\{site_id\}\/search\b/.test(t.endpointMapping.path))).toEqual([]);
    expect(a.description).not.toMatch(/search items/i);
  });

  it('tells the model that a validation with only warnings would be accepted', () => {
    // 21 of 28 validate calls came back 400 with only `type: warning` causes,
    // and the model reported them as a failed validation.
    const d = tool('mercado_libre_validate_listing').description;
    expect(d).toMatch(/type 'warning'/);
    expect(d).toMatch(/would still be accepted/);
    expect(a.instructions).toMatch(/all `type: warning` also means it would be accepted/);
  });

  it('says the notifications URL is not the redirect URI', () => {
    // 1,238 notification POSTs a day reached /api/mcp-oauth/callback because
    // an app had the redirect URI in its notifications field too.
    expect(a.instructions).toMatch(/notifications callback URL empty/);
    expect((adapter as unknown as { prerequisites: string }).prerequisites).toMatch(/notifications callback URL empty/);
  });

  it('never reuses a name workspaces gave their own tools on this connector', () => {
    // A catalog re-sync matches tools by name, so a catalog tool with one of
    // these names would overwrite the workspace's own tool.
    const names = new Set(a.tools.map((t) => t.name));
    for (const own of ['mercado_libre_list_my_items', 'create_item', 'cambios ia', 'compatibilidades']) {
      expect(names.has(own)).toBe(false);
    }
  });

  it('marks the reads read-only, including the POST validation', () => {
    for (const name of [
      'mercado_libre_predict_category',
      'mercado_libre_get_category',
      'mercado_libre_get_category_attributes',
      'mercado_libre_get_category_sale_terms',
      'mercado_libre_list_listing_types',
      'mercado_libre_list_seller_items',
      'mercado_libre_validate_listing',
      'mercado_libre_get_listing_description',
    ]) {
      expect(`${name}:${annotationsOf(tool(name)).readOnlyHint}`).toBe(`${name}:true`);
    }
  });

  it('asks for confirmation on every write, and installs only the close switched off', () => {
    for (const name of [
      'mercado_libre_create_listing',
      'mercado_libre_update_listing',
      'mercado_libre_set_listing_status',
      'mercado_libre_close_listing',
      'mercado_libre_add_listing_description',
      'mercado_libre_update_listing_description',
    ]) {
      expect(annotationsOf(tool(name)).readOnlyHint).toBe(false);
      expect(`${name}:${/confirm/i.test(tool(name).description)}`).toBe(`${name}:true`);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['mercado_libre_close_listing']);
    expect(annotationsOf(tool('mercado_libre_close_listing')).destructiveHint).toBe(true);
    expect(annotationsOf(tool('mercado_libre_set_listing_status')).destructiveHint).toBe(false);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const texts = [a.instructions, a.description, ...LISTING_TOOLS.map((n) => JSON.stringify(tool(n)))];
    const mentioned = texts.flatMap((s) => [...s.matchAll(/\bmercado_libre_[a-z_]+/g)].map((m) => m[0]));
    expect(mentioned.length).toBeGreaterThan(20);
    for (const name of mentioned) expect(names).toContain(name);
    for (const s of texts) expect(s).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['mercado_libre_predict_category', { site_id: 'MLB', q: 'celular iphone', limit: 3 }, 'GET', '/sites/MLB/domain_discovery/search'],
    ['mercado_libre_get_category', { category_id: 'MLB1055' }, 'GET', '/categories/MLB1055'],
    ['mercado_libre_get_category_attributes', { category_id: 'MLB1055' }, 'GET', '/categories/MLB1055/attributes'],
    ['mercado_libre_get_category_sale_terms', { category_id: 'MLB1055' }, 'GET', '/categories/MLB1055/sale_terms'],
    ['mercado_libre_list_listing_types', { site_id: 'MLM' }, 'GET', '/sites/MLM/listing_types'],
    ['mercado_libre_list_seller_items', { user_id: '123', status: 'active' }, 'GET', '/users/123/items/search'],
    ['mercado_libre_validate_listing', LISTING, 'POST', '/items/validate'],
    ['mercado_libre_create_listing', LISTING, 'POST', '/items'],
    ['mercado_libre_update_listing', { item_id: 'MLB1', price: 10 }, 'PUT', '/items/MLB1'],
    ['mercado_libre_set_listing_status', { item_id: 'MLB1', status: 'paused' }, 'PUT', '/items/MLB1'],
    ['mercado_libre_close_listing', { item_id: 'MLB1' }, 'PUT', '/items/MLB1'],
    ['mercado_libre_get_listing_description', { item_id: 'MLB1' }, 'GET', '/items/MLB1/description'],
    ['mercado_libre_add_listing_description', { item_id: 'MLB1', plain_text: 'x' }, 'POST', '/items/MLB1/description'],
    ['mercado_libre_update_listing_description', { item_id: 'MLB1', plain_text: 'x' }, 'PUT', '/items/MLB1/description'],
  ];

  it('lists every listing tool in the URL table', () => {
    expect(table.map(([n]) => n).sort()).toEqual([...LISTING_TOOLS].sort());
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(sent()).toEqual(expect.objectContaining({ method, url: `${BASE}${path}` }));
  });

  it('encodes ids in the path, so an id cannot reach another route', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('mercado_libre_get_listing_description', { item_id: '../users/me' });
    expect(sent().url).toBe(`${BASE}/items/..%2Fusers%2Fme/description`);
  });

  it('creates and validates a listing with the same body, family_name and no title', async () => {
    for (const name of ['mercado_libre_create_listing', 'mercado_libre_validate_listing']) {
      mockedAxios.mockReset();
      mockedAxios.mockResolvedValue({ data: {} });
      await call(name, LISTING);
      expect(sent().data).toEqual(LISTING);
    }
    expect(tool('mercado_libre_create_listing').endpointMapping.bodyMapping).toEqual(
      tool('mercado_libre_validate_listing').endpointMapping.bodyMapping,
    );
    expect(tool('mercado_libre_create_listing').parameters).toEqual(tool('mercado_libre_validate_listing').parameters);
  });

  it('sends only the fields to change, and attributes and sale terms as given', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const attributes = [{ id: 'COLOR', value_id: '52049', value_name: 'Preto' }];
    const sale_terms = [{ id: 'WARRANTY_TIME', value_name: '90 dias' }];
    await call('mercado_libre_update_listing', { item_id: 'MLB1', available_quantity: 0, attributes, sale_terms });
    expect(sent().data).toEqual({ available_quantity: 0, attributes, sale_terms });
  });

  it('pauses, reactivates and closes through the status field', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('mercado_libre_set_listing_status', { item_id: 'MLB1', status: 'active' });
    expect(sent().data).toEqual({ status: 'active' });
    expect(tool('mercado_libre_set_listing_status').parameters.properties!.status).toEqual(
      expect.objectContaining({ enum: ['paused', 'active'] }),
    );
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('mercado_libre_close_listing', { item_id: 'MLB1' });
    expect(sent().data).toEqual({ status: 'closed' });
  });

  it('adds a description with POST and replaces it with PUT on api_version 2', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('mercado_libre_add_listing_description', { item_id: 'MLB1', plain_text: 'Novo.\nSem uso.' });
    expect(sent().data).toEqual({ plain_text: 'Novo.\nSem uso.' });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('mercado_libre_update_listing_description', { item_id: 'MLB1', plain_text: 'x' });
    expect(sent().params).toEqual({ api_version: '2' });
  });

  it('filters the seller items and the predictor through the query string', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('mercado_libre_list_seller_items', { user_id: '1', seller_sku: 'SKU-1', limit: 100, offset: 0 });
    expect(sent().params).toEqual({ seller_sku: 'SKU-1', limit: 100, offset: 0 });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('mercado_libre_predict_category', { site_id: 'MLA', q: 'fiat uno', limit: 3 });
    expect(sent().params).toEqual({ q: 'fiat uno', limit: 3 });
  });
});

const maybe = process.env.RUN_MERCADO_LIBRE_LIVE ? describe : describe.skip;
maybe('mercado-libre adapter: live public routes', () => {
  beforeEach(() => mockedAxios.mockImplementation((cfg) => mockedAxios.__actual.request(cfg)));

  it('predicts a category for a title', async () => {
    const res = (await call('mercado_libre_predict_category', { site_id: 'MLB', q: 'celular iphone', limit: 2 })) as Array<{ category_id: string }>;
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].category_id).toMatch(/^MLB\d+$/);
  }, 30000);

  it('reads a category and its required attributes', async () => {
    const cat = (await call('mercado_libre_get_category', { category_id: 'MLB1055' })) as { id: string; settings: Record<string, unknown> };
    expect(cat.id).toBe('MLB1055');
    expect(cat.settings).toHaveProperty('max_title_length');
    const attrs = (await call('mercado_libre_get_category_attributes', { category_id: 'MLB1055' })) as Array<{ id: string; tags: Record<string, unknown> }>;
    expect(attrs.find((x) => x.id === 'BRAND')?.tags.required).toBe(true);
  }, 30000);

  it('refuses the seller routes without a token', async () => {
    let err: any;
    try {
      await call('mercado_libre_validate_listing', LISTING);
    } catch (e) {
      err = e;
    }
    expect([401, 403]).toContain(err?.response?.status);
  }, 30000);
});
