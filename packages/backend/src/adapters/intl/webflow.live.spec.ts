import axios from 'axios';
import * as adapter from './webflow.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Webflow adapter (Data API v2, site API token):
 *
 *   1. Static: always runs. Pins the Bearer token on api.webflow.com/v2, the
 *      token pattern, the token introspection probe, every tool's method and
 *      URL through the real RestEngine (with {{VAR}} interpolation as in
 *      DynamicMcpTools), the request bodies of every write (staged item create
 *      through /items/insert, update, delete, item publish, live create, update
 *      and unpublish, site publish, page settings), the read-only, destructive
 *      and switched-off sets, and the "confirm first" wording on publishing.
 *
 *   2. Live: skipped unless WEBFLOW_API_TOKEN is set (a site API token from
 *      Site settings → Apps & integrations → API access, with the read scopes).
 *      WEBFLOW_SITE_ID picks the site (else the first, and with a site token the
 *      only one); WEBFLOW_COLLECTION_ID picks the collection (else the first):
 *
 *        WEBFLOW_API_TOKEN=... npx jest src/adapters/intl/webflow.live.spec.ts
 *
 *      Runs every read tool. E-commerce reads on a site without e-commerce may
 *      be refused (403, 404 or 409); that refusal counts as an API answer.
 *
 *      WEBFLOW_LIVE_WRITE=1 (needs cms:write, and a collection whose only
 *      required fields are name and slug) creates a STAGED draft item named
 *      "AnythingMCP live spec (safe to delete)", reads it, updates it and
 *      deletes it in `finally`. Nothing reaches the public site.
 *
 *      WEBFLOW_LIVE_PUBLISH=1 on top of that also publishes that one item,
 *      reads and updates its live version, creates a live item, then
 *      unpublishes and deletes both. Use a test site: this touches the public
 *      site, and per-item publishing may need a paid CMS plan. The spec never
 *      publishes the whole site and never changes page settings.
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
    encodePathParams?: boolean;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string; link?: string }>;
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

const BASE = 'https://api.webflow.com/v2';
// Fake ids and a fake token, built at runtime.
const hex = (c: string) => c.repeat(24);
const SITE = hex('a');
const COLL = hex('b');
const ITEM = hex('c');
const PAGE = hex('d');
const LOCALE = hex('e');
const FAKE_TOKEN = ['fake', 'token', 'x'.repeat(40)].join('-');
const ENV = { WEBFLOW_API_TOKEN: FAKE_TOKEN };

// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, token: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token }, headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...ENV },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, FAKE_TOKEN, params);
const sent = () => mockedAxios.mock.calls[0][0];

const READ_ONLY = [
  'webflow_get_asset',
  'webflow_get_collection',
  'webflow_get_form',
  'webflow_get_form_submission',
  'webflow_get_item',
  'webflow_get_live_item',
  'webflow_get_order',
  'webflow_get_page',
  'webflow_get_product',
  'webflow_get_site',
  'webflow_get_token_info',
  'webflow_list_assets',
  'webflow_list_collections',
  'webflow_list_custom_domains',
  'webflow_list_form_submissions',
  'webflow_list_form_submissions_by_form',
  'webflow_list_forms',
  'webflow_list_items',
  'webflow_list_live_items',
  'webflow_list_orders',
  'webflow_list_pages',
  'webflow_list_products',
  'webflow_list_sites',
];
const OFF = ['webflow_delete_item', 'webflow_unpublish_live_item'];
const PUBLIC_WRITES = [
  'webflow_create_live_item',
  'webflow_publish_items',
  'webflow_publish_site',
  'webflow_update_live_item',
  'webflow_update_page_settings',
];

describe('webflow adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until verified against a real account', () => {
    expect(a.unlisted).toBe(true);
  });

  it('sends the site token as Bearer to api.webflow.com/v2', () => {
    expect(a.category).toBe('cms');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{WEBFLOW_API_TOKEN}}' });
    expect(interpolateDeep(a.connector.authConfig, ENV)).toEqual({ token: FAKE_TOKEN });
    expect(a.connector.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'AnythingMCP' });
    expect(a.connector.healthcheckPath).toBe('/token/introspect');
  });

  it('asks for one secret token, without a Bearer prefix', () => {
    expect(a.requiredEnvVars).toEqual(['WEBFLOW_API_TOKEN']);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'WEBFLOW_API_TOKEN')!.secret).toBe(true);
    expect(a.envVarMeta.WEBFLOW_API_TOKEN.kind).toBe('credential');
    expect(a.envVarMeta.WEBFLOW_API_TOKEN.link).toMatch(/^https:\/\/webflow\.com\//);
    const token = new RegExp(a.envVarMeta.WEBFLOW_API_TOKEN.pattern!);
    const fake = 'a'.repeat(64);
    expect(token.test(fake)).toBe(true);
    expect(token.test(`Bearer ${fake}`)).toBe(false);
    expect(token.test('short')).toBe(false);
    expect(token.test(`${fake.slice(0, 30)} ${fake.slice(30)}`)).toBe(false);
  });

  it('probes with token introspection, which needs no scope and no argument', async () => {
    expect(a.probe).toEqual({ tool: 'webflow_get_token_info' });
    expect(tool('webflow_get_token_info').parameters.required).toBeUndefined();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('webflow_get_token_info', {});
    expect(sent().url).toBe(`${BASE}/token/introspect`);
    expect(sent().headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(sent().headers['User-Agent']).toBe('AnythingMCP');
  });

  it('prefixes every tool with webflow_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^webflow_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks every GET read-only and nothing else', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual(READ_ONLY);
    for (const t of a.tools) expect(annotationsOf(t).readOnlyHint === true).toBe(t.endpointMapping.method === 'GET');
  });

  it('marks overwriting the public site destructive, keeps drafts additive and installs deletes switched off', () => {
    for (const name of ['webflow_publish_site', 'webflow_publish_items', 'webflow_update_live_item']) {
      const ann = annotationsOf(tool(name));
      expect(`${name}:${ann.readOnlyHint}:${ann.destructiveHint}:${ann.idempotentHint}`).toBe(`${name}:false:true:false`);
    }
    for (const name of [...OFF, 'webflow_update_item', 'webflow_update_page_settings']) {
      expect(`${name}:${annotationsOf(tool(name)).destructiveHint}`).toBe(`${name}:true`);
    }
    for (const name of ['webflow_create_item', 'webflow_create_live_item']) {
      expect(`${name}:${annotationsOf(tool(name)).destructiveHint}`).toBe(`${name}:false`);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(OFF);
  });

  it('publishing the site is a non-idempotent POST, limited to one a minute, and every public write asks to confirm', () => {
    const publish = tool('webflow_publish_site');
    expect(publish.endpointMapping.method).toBe('POST');
    expect(annotationsOf(publish).idempotentHint).toBe(false);
    expect(publish.description).toMatch(/one successful publish per minute/);
    for (const name of [...PUBLIC_WRITES, ...OFF]) expect(`${name}: ${tool(name).description}`).toMatch(/confirm/i);
    expect(tool('webflow_create_item').description).toMatch(/nothing appears on the public site/);
  });

  it('URL-encodes every path argument', () => {
    for (const t of a.tools.filter((x) => /\{[a-z_]+\}/.test(x.endpointMapping.path))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('documents setup, scopes and the read-only setup, mentions only existing tools and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bwebflow_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bwebflow_[a-z_]+/g)]),
      ...a.tools.flatMap((t) => [...JSON.stringify(t.parameters).matchAll(/\bwebflow_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(20);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions).toContain('## Webflow');
    expect(a.instructions).toContain('https://api.webflow.com/v2');
    expect(a.instructions).toContain('**Apps & integrations**');
    expect(a.instructions).toContain('**API access**');
    expect(a.instructions).toContain('**Generate API token**');
    for (const scope of ['sites:read', 'sites:write', 'pages:read', 'pages:write', 'cms:read', 'cms:write', 'forms:read', 'assets:read', 'ecommerce:read']) {
      expect(a.instructions).toContain(`\`${scope}\``);
    }
    expect(a.instructions).toContain('**Read-only setup**');
    expect(a.instructions).toContain('**Out of scope here**');
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['webflow_get_token_info', {}, 'GET', `${BASE}/token/introspect`],
    ['webflow_list_sites', {}, 'GET', `${BASE}/sites`],
    ['webflow_get_site', { site_id: SITE }, 'GET', `${BASE}/sites/${SITE}`],
    ['webflow_list_custom_domains', { site_id: SITE }, 'GET', `${BASE}/sites/${SITE}/custom_domains`],
    ['webflow_publish_site', { site_id: SITE, publish_to_webflow_subdomain: true }, 'POST', `${BASE}/sites/${SITE}/publish`],
    ['webflow_list_pages', { site_id: SITE }, 'GET', `${BASE}/sites/${SITE}/pages`],
    ['webflow_get_page', { page_id: PAGE }, 'GET', `${BASE}/pages/${PAGE}`],
    ['webflow_update_page_settings', { page_id: PAGE, title: 'T' }, 'PUT', `${BASE}/pages/${PAGE}`],
    ['webflow_list_collections', { site_id: SITE }, 'GET', `${BASE}/sites/${SITE}/collections`],
    ['webflow_get_collection', { collection_id: COLL }, 'GET', `${BASE}/collections/${COLL}`],
    ['webflow_list_items', { collection_id: COLL }, 'GET', `${BASE}/collections/${COLL}/items`],
    ['webflow_get_item', { collection_id: COLL, item_id: ITEM }, 'GET', `${BASE}/collections/${COLL}/items/${ITEM}`],
    ['webflow_create_item', { collection_id: COLL, field_data: { name: 'N', slug: 'n' } }, 'POST', `${BASE}/collections/${COLL}/items/insert`],
    ['webflow_update_item', { collection_id: COLL, item_id: ITEM, field_data: { name: 'N' } }, 'PATCH', `${BASE}/collections/${COLL}/items`],
    ['webflow_delete_item', { collection_id: COLL, item_id: ITEM }, 'DELETE', `${BASE}/collections/${COLL}/items`],
    ['webflow_publish_items', { collection_id: COLL, item_ids: [ITEM] }, 'POST', `${BASE}/collections/${COLL}/items/publish`],
    ['webflow_list_live_items', { collection_id: COLL }, 'GET', `${BASE}/collections/${COLL}/items/live`],
    ['webflow_get_live_item', { collection_id: COLL, item_id: ITEM }, 'GET', `${BASE}/collections/${COLL}/items/${ITEM}/live`],
    ['webflow_create_live_item', { collection_id: COLL, field_data: { name: 'N', slug: 'n' } }, 'POST', `${BASE}/collections/${COLL}/items/live`],
    ['webflow_update_live_item', { collection_id: COLL, item_id: ITEM, field_data: { name: 'N' } }, 'PATCH', `${BASE}/collections/${COLL}/items/live`],
    ['webflow_unpublish_live_item', { collection_id: COLL, item_id: ITEM }, 'DELETE', `${BASE}/collections/${COLL}/items/live`],
    ['webflow_list_forms', { site_id: SITE }, 'GET', `${BASE}/sites/${SITE}/forms`],
    ['webflow_get_form', { form_id: 'F1' }, 'GET', `${BASE}/forms/F1`],
    ['webflow_list_form_submissions', { site_id: SITE }, 'GET', `${BASE}/sites/${SITE}/form_submissions`],
    ['webflow_list_form_submissions_by_form', { site_id: SITE, form_id: 'F1' }, 'GET', `${BASE}/sites/${SITE}/forms/F1/submissions`],
    ['webflow_get_form_submission', { site_id: SITE, form_submission_id: 'S1' }, 'GET', `${BASE}/sites/${SITE}/form_submissions/S1`],
    ['webflow_list_assets', { site_id: SITE }, 'GET', `${BASE}/sites/${SITE}/assets`],
    ['webflow_get_asset', { asset_id: 'A1' }, 'GET', `${BASE}/assets/A1`],
    ['webflow_list_products', { site_id: SITE }, 'GET', `${BASE}/sites/${SITE}/products`],
    ['webflow_get_product', { site_id: SITE, product_id: 'P1' }, 'GET', `${BASE}/sites/${SITE}/products/P1`],
    ['webflow_list_orders', { site_id: SITE }, 'GET', `${BASE}/sites/${SITE}/orders`],
    ['webflow_get_order', { site_id: SITE, order_id: 'O1' }, 'GET', `${BASE}/sites/${SITE}/orders/O1`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ method, url, headers: expect.objectContaining({ Authorization: `Bearer ${FAKE_TOKEN}` }) }),
    );
    if (method === 'GET') expect(sent().data).toBeUndefined();
  });

  it('encodes ids that carry a slash instead of escaping the path', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('webflow_get_item', { collection_id: COLL, item_id: '../x' });
    expect(sent().url).toBe(`${BASE}/collections/${COLL}/items/..%2Fx`);
  });

  it('creates a staged draft item through /items/insert by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const fieldData = { name: 'AnythingMCP', slug: 'anythingmcp', summary: 'Hi' };
    await call('webflow_create_item', { collection_id: COLL, field_data: fieldData });
    expect(sent().data).toEqual({ items: [{ fieldData, isDraft: true }] });
    mockedAxios.mockClear();
    await call('webflow_create_item', { collection_id: COLL, field_data: fieldData, is_draft: false, is_archived: false, cms_locale_ids: [LOCALE] });
    expect(sent().data).toEqual({ items: [{ fieldData, isDraft: false, isArchived: false, cmsLocaleIds: [LOCALE] }] });
  });

  it('updates, deletes and unpublishes one item through the items arrays', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('webflow_update_item', { collection_id: COLL, item_id: ITEM, field_data: { summary: 'New' }, is_draft: true });
    expect(sent().data).toEqual({ items: [{ id: ITEM, fieldData: { summary: 'New' }, isDraft: true }] });
    mockedAxios.mockClear();
    await call('webflow_update_item', { collection_id: COLL, item_id: ITEM, is_archived: true, cms_locale_id: LOCALE });
    expect(sent().data).toEqual({ items: [{ id: ITEM, cmsLocaleId: LOCALE, isArchived: true }] });
    mockedAxios.mockClear();
    await call('webflow_delete_item', { collection_id: COLL, item_id: ITEM });
    expect(sent().data).toEqual({ items: [{ id: ITEM }] });
    mockedAxios.mockClear();
    await call('webflow_unpublish_live_item', { collection_id: COLL, item_id: ITEM, cms_locale_ids: [LOCALE] });
    expect(sent().data).toEqual({ items: [{ id: ITEM, cmsLocaleIds: [LOCALE] }] });
  });

  it('creates and updates live items with the documented bodies', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const fieldData = { name: 'Live', slug: 'live' };
    await call('webflow_create_live_item', { collection_id: COLL, field_data: fieldData });
    expect(sent().data).toEqual({ isArchived: false, isDraft: false, fieldData });
    mockedAxios.mockClear();
    await call('webflow_update_live_item', { collection_id: COLL, item_id: ITEM, field_data: { name: 'Live 2' }, cms_locale_id: LOCALE });
    expect(sent().data).toEqual({ items: [{ id: ITEM, cmsLocaleId: LOCALE, fieldData: { name: 'Live 2' } }] });
  });

  it('publishes items by id, or per locale', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('webflow_publish_items', { collection_id: COLL, item_ids: [ITEM] });
    expect(sent().data).toEqual({ itemIds: [ITEM] });
    mockedAxios.mockClear();
    const items = [{ id: ITEM, cmsLocaleIds: [LOCALE] }];
    await call('webflow_publish_items', { collection_id: COLL, items });
    expect(sent().data).toEqual({ items });
  });

  it('publishes the site to the chosen domains, or one page', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('webflow_publish_site', { site_id: SITE, custom_domain_ids: ['D1', 'D2'], publish_to_webflow_subdomain: false });
    expect(sent().data).toEqual({ customDomains: ['D1', 'D2'], publishToWebflowSubdomain: false });
    mockedAxios.mockClear();
    await call('webflow_publish_site', { site_id: SITE, publish_to_webflow_subdomain: true, page_id: PAGE });
    expect(sent().data).toEqual({ publishToWebflowSubdomain: true, pageId: PAGE });
  });

  it('updates page settings with seo and openGraph objects and the locale as a query parameter', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const seo = { title: 'Spring sale | Acme', description: 'Ten days of deals.' };
    const openGraph = { title: 'Spring sale', titleCopied: false, description: 'Ten days only', descriptionCopied: false };
    await call('webflow_update_page_settings', { page_id: PAGE, locale_id: LOCALE, seo, open_graph: openGraph });
    expect(sent().method).toBe('PUT');
    expect(sent().params).toEqual({ localeId: LOCALE });
    expect(sent().data).toEqual({ seo, openGraph });
    mockedAxios.mockClear();
    await call('webflow_update_page_settings', { page_id: PAGE, title: 'About', slug: 'about-us' });
    expect(sent().params).toEqual({});
    expect(sent().data).toEqual({ title: 'About', slug: 'about-us' });
  });

  it('lists items 25 at a time, with custom field filters passed through in bracket notation', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('webflow_list_items', {
      collection_id: COLL,
      cms_locale_id: LOCALE,
      sort_by: 'lastUpdated',
      sort_order: 'desc',
      offset: 25,
      filter_query: 'filter[price][gte]=10&filter[title][contains]=shirt&sort[price]=desc',
    });
    expect(sent().params).toEqual({
      cmsLocaleId: LOCALE,
      sortBy: 'lastUpdated',
      sortOrder: 'desc',
      offset: 25,
      limit: 25,
      'filter[price][gte]': '10',
      'filter[title][contains]': 'shirt',
      'sort[price]': 'desc',
    });
    mockedAxios.mockClear();
    await call('webflow_list_live_items', { collection_id: COLL, slug: 'spring-sale' });
    expect(sent().params).toEqual({ slug: 'spring-sale', limit: 25 });
  });

  it('passes paging, status and filters of the other lists', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('webflow_list_orders', { site_id: SITE, status: 'unfulfilled' });
    expect(sent().params).toEqual({ status: 'unfulfilled', limit: 25 });
    mockedAxios.mockClear();
    await call('webflow_list_form_submissions', { site_id: SITE, element_id: 'E1', offset: 100, limit: 100 });
    expect(sent().params).toEqual({ elementId: 'E1', offset: 100, limit: 100 });
    mockedAxios.mockClear();
    await call('webflow_list_assets', { site_id: SITE, folder_id: hex('f'), locale_id: LOCALE });
    expect(sent().params).toEqual({ folderId: hex('f'), localeId: LOCALE });
    mockedAxios.mockClear();
    await call('webflow_list_pages', { site_id: SITE, locale_id: LOCALE, limit: 10 });
    expect(sent().params).toEqual({ localeId: LOCALE, limit: 10 });
  });
});

const TOKEN = process.env.WEBFLOW_API_TOKEN;
const live = TOKEN ? describe : describe.skip;
const WRITE = process.env.WEBFLOW_LIVE_WRITE === '1';
const PUBLISH = WRITE && process.env.WEBFLOW_LIVE_PUBLISH === '1';
type HttpError = { response?: { status: number } };

live('webflow adapter: live Data API', () => {
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, TOKEN as string, params);
  // A refusal for a plan or feature the site lacks is still an API answer.
  const refusedOr = async (promise: Promise<any>, statuses: number[]): Promise<any> => {
    try {
      return await promise;
    } catch (e) {
      const status = (e as HttpError).response?.status;
      if (status === undefined || !statuses.includes(status)) throw e;
      return undefined;
    }
  };
  let siteId = '';
  let collectionId = '';

  beforeAll(async () => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
    const sites = await run('webflow_list_sites');
    siteId = process.env.WEBFLOW_SITE_ID || sites.sites?.[0]?.id;
    expect(siteId).toBeTruthy();
    if (process.env.WEBFLOW_COLLECTION_ID) {
      collectionId = process.env.WEBFLOW_COLLECTION_ID;
    } else {
      const collections = await run('webflow_list_collections', { site_id: siteId });
      collectionId = collections.collections?.[0]?.id ?? '';
    }
  }, 30_000);
  afterAll(() => mockedAxios.mockReset());

  it('introspects the token and reads the site and its custom domains', async () => {
    const info = await run('webflow_get_token_info');
    expect(typeof info.authorization.scope).toBe('string');
    expect(Array.isArray(info.authorization.authorizedTo.siteIds)).toBe(true);
    const site = await run('webflow_get_site', { site_id: siteId });
    expect(site.id).toBe(siteId);
    const domains = await run('webflow_list_custom_domains', { site_id: siteId });
    expect(Array.isArray(domains.customDomains ?? [])).toBe(true);
  }, 60_000);

  it('reads pages and one page', async () => {
    const pages = await run('webflow_list_pages', { site_id: siteId, limit: 5 });
    expect(Array.isArray(pages.pages)).toBe(true);
    expect(pages.pagination.limit).toBe(5);
    if (pages.pages[0]) {
      const page = await run('webflow_get_page', { page_id: pages.pages[0].id });
      expect(page.id).toBe(pages.pages[0].id);
    }
  }, 60_000);

  it('reads collections, the schema, staged and live items', async () => {
    const collections = await run('webflow_list_collections', { site_id: siteId });
    expect(Array.isArray(collections.collections ?? [])).toBe(true);
    if (!collectionId) return;
    const schema = await run('webflow_get_collection', { collection_id: collectionId });
    expect(Array.isArray(schema.fields)).toBe(true);
    const items = await run('webflow_list_items', { collection_id: collectionId, limit: 5 });
    expect(Array.isArray(items.items)).toBe(true);
    if (items.items[0]) {
      const item = await run('webflow_get_item', { collection_id: collectionId, item_id: items.items[0].id });
      expect(item.id).toBe(items.items[0].id);
    }
    const liveItems = await refusedOr(run('webflow_list_live_items', { collection_id: collectionId, limit: 5 }), [403, 409]);
    if (liveItems?.items?.[0]) {
      const one = await run('webflow_get_live_item', { collection_id: collectionId, item_id: liveItems.items[0].id });
      expect(one.id).toBe(liveItems.items[0].id);
    }
  }, 60_000);

  it('reads forms and their submissions', async () => {
    const forms = await run('webflow_list_forms', { site_id: siteId, limit: 5 });
    expect(Array.isArray(forms.forms)).toBe(true);
    const submissions = await run('webflow_list_form_submissions', { site_id: siteId, limit: 5 });
    expect(Array.isArray(submissions.formSubmissions ?? [])).toBe(true);
    const form = forms.forms[0];
    if (form) {
      expect((await run('webflow_get_form', { form_id: form.id })).id).toBe(form.id);
      const byForm = await run('webflow_list_form_submissions_by_form', { site_id: siteId, form_id: form.id, limit: 5 });
      expect(Array.isArray(byForm.formSubmissions ?? [])).toBe(true);
    }
    const first = submissions.formSubmissions?.[0];
    if (first) {
      expect((await run('webflow_get_form_submission', { site_id: siteId, form_submission_id: first.id })).id).toBe(first.id);
    }
  }, 60_000);

  it('reads assets and one asset', async () => {
    const assets = await run('webflow_list_assets', { site_id: siteId, limit: 5 });
    expect(Array.isArray(assets.assets)).toBe(true);
    if (assets.assets[0]) {
      expect((await run('webflow_get_asset', { asset_id: assets.assets[0].id })).id).toBe(assets.assets[0].id);
    }
  }, 60_000);

  it('reads products and orders, or gets a clear refusal on a site without e-commerce', async () => {
    const ecommerce = [403, 404, 409];
    const products = await refusedOr(run('webflow_list_products', { site_id: siteId, limit: 5 }), ecommerce);
    const product = products?.items?.[0]?.product;
    if (product) {
      expect((await run('webflow_get_product', { site_id: siteId, product_id: product.id })).product.id).toBe(product.id);
    }
    const orders = await refusedOr(run('webflow_list_orders', { site_id: siteId, limit: 5 }), ecommerce);
    const order = orders?.orders?.[0];
    if (order) {
      expect((await run('webflow_get_order', { site_id: siteId, order_id: order.orderId })).orderId).toBe(order.orderId);
    }
  }, 60_000);

  it('a wrong token is a 401', async () => {
    await expect(execute('webflow_get_token_info', ['wrong', 'x'.repeat(40)].join('-'), {})).rejects.toMatchObject({
      response: { status: 401 },
    });
  }, 30_000);

  (WRITE ? it : it.skip)('creates a staged draft item, reads, updates and deletes it', async () => {
    expect(collectionId).toBeTruthy();
    const slug = `anythingmcp-live-spec-${Date.now()}`;
    const created = await run('webflow_create_item', {
      collection_id: collectionId,
      field_data: { name: 'AnythingMCP live spec (safe to delete)', slug },
    });
    const id = created.items[0].id;
    try {
      expect(created.items[0].isDraft).toBe(true);
      const read = await run('webflow_get_item', { collection_id: collectionId, item_id: id });
      expect(read.fieldData.slug).toBe(slug);
      await run('webflow_update_item', {
        collection_id: collectionId,
        item_id: id,
        field_data: { name: 'AnythingMCP live spec (safe to delete, updated)' },
      });
      const again = await run('webflow_get_item', { collection_id: collectionId, item_id: id });
      expect(again.fieldData.name).toBe('AnythingMCP live spec (safe to delete, updated)');
      const found = await run('webflow_list_items', { collection_id: collectionId, slug });
      expect(found.items.map((i: { id: string }) => i.id)).toContain(id);
    } finally {
      await run('webflow_delete_item', { collection_id: collectionId, item_id: id });
    }
    await expect(run('webflow_get_item', { collection_id: collectionId, item_id: id })).rejects.toMatchObject({
      response: { status: 404 },
    });
  }, 120_000);

  (PUBLISH ? it : it.skip)('publishes one test item, changes it live, creates a live item, then unpublishes and deletes both', async () => {
    expect(collectionId).toBeTruthy();
    const stamp = Date.now();
    const ids: string[] = [];
    const published: string[] = [];
    try {
      const created = await run('webflow_create_item', {
        collection_id: collectionId,
        field_data: { name: 'AnythingMCP live spec (safe to delete)', slug: `anythingmcp-live-spec-p-${stamp}` },
      });
      ids.push(created.items[0].id);
      const result = await run('webflow_publish_items', { collection_id: collectionId, item_ids: [ids[0]] });
      expect(result.publishedItemIds).toContain(ids[0]);
      published.push(ids[0]);
      await run('webflow_update_live_item', {
        collection_id: collectionId,
        item_id: ids[0],
        field_data: { name: 'AnythingMCP live spec (safe to delete, live)' },
      });
      const liveOne = await run('webflow_get_live_item', { collection_id: collectionId, item_id: ids[0] });
      expect(liveOne.fieldData.name).toBe('AnythingMCP live spec (safe to delete, live)');
      const direct = await run('webflow_create_live_item', {
        collection_id: collectionId,
        field_data: { name: 'AnythingMCP live spec (safe to delete)', slug: `anythingmcp-live-spec-l-${stamp}` },
      });
      ids.push(direct.id);
      published.push(direct.id);
    } finally {
      const problems: string[] = [];
      for (const id of published) {
        await run('webflow_unpublish_live_item', { collection_id: collectionId, item_id: id }).catch((e: Error) => problems.push(`unpublish ${id}: ${e.message}`));
      }
      for (const id of ids) {
        await run('webflow_delete_item', { collection_id: collectionId, item_id: id }).catch((e: Error) => problems.push(`delete ${id}: ${e.message}`));
      }
      expect(problems).toEqual([]);
    }
  }, 180_000);
});
