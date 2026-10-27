import * as adapter from './shopware-6-admin.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Shopware 6 Admin API (developer.shopware.com/docs/guides/integrations-api, reference at
 * shopware.stoplight.io/docs/admin-api): {shop}/api, OAuth2 client credentials of an integration at
 * /api/oauth/token, entity routes /{entity}/{id}, criteria search /search/{entity}, /_action/sync,
 * /_action/media/{id}/upload, sw-language-id / sw-inheritance headers.
 * Live part: SHOPWARE_URL=... SHOPWARE_ACCESS_KEY_ID=... SHOPWARE_SECRET_ACCESS_KEY=... RUN_SHOPWARE_6_ADMIN_LIVE=1 npx jest src/adapters/de/shopware-6-admin
 * (reads only: version, languages, one product, one category, one layout with its sections).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string>; healthcheckPath?: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
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
const PREFIX = 'shopware_6_admin_';
const OFF = ['shopware_6_admin_create_entity', 'shopware_6_admin_delete_entity', 'shopware_6_admin_sync', 'shopware_6_admin_update_entity'];
const ON_WRITES = [
  'shopware_6_admin_update_product',
  'shopware_6_admin_add_product_property',
  'shopware_6_admin_remove_product_property',
  'shopware_6_admin_create_property_option',
  'shopware_6_admin_create_category',
  'shopware_6_admin_update_category',
  'shopware_6_admin_create_cms_page',
  'shopware_6_admin_update_cms_page',
  'shopware_6_admin_create_cms_block',
  'shopware_6_admin_update_cms_slot',
  'shopware_6_admin_create_media',
  'shopware_6_admin_upload_media_from_url',
  'shopware_6_admin_update_media',
  'shopware_6_admin_create_media_folder',
];
const SEARCHES: Record<string, string> = {
  shopware_6_admin_search_products: '/search/product',
  shopware_6_admin_search_categories: '/search/category',
  shopware_6_admin_search_cms_pages: '/search/cms-page',
  shopware_6_admin_search_media: '/search/media',
  shopware_6_admin_search_sales_channels: '/search/sales-channel',
  shopware_6_admin_search_promotions: '/search/promotion',
  shopware_6_admin_search_seo_urls: '/search/seo-url',
  shopware_6_admin_search_entities: '/search/{entity}',
};

describe('shopware-6-admin adapter: static spec conformance', () => {
  it('gets a token with the integration credentials at the shop and calls /api with JSON', () => {
    expect(a.slug).toBe('shopware-6-admin');
    expect(a.region).toBe('de');
    expect(a.icon).toBe('shopware');
    expect(a.requiredEnvVars).toEqual(['SHOPWARE_URL', 'SHOPWARE_ACCESS_KEY_ID', 'SHOPWARE_SECRET_ACCESS_KEY']);
    expect(a.connector.baseUrl).toBe('{{SHOPWARE_URL}}/api');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{SHOPWARE_ACCESS_KEY_ID}}',
      clientSecret: '{{SHOPWARE_SECRET_ACCESS_KEY}}',
      tokenUrl: '{{SHOPWARE_URL}}/api/oauth/token',
      tokenAuthMethod: 'client_secret_post',
    });
    // Plain JSON instead of JSON:API, which doubles the size of every answer.
    expect(a.connector.headers?.Accept).toBe('application/json');
    expect(a.connector.healthcheckPath).toBe('/_info/version');
    expect(a.envVarMeta?.SHOPWARE_SECRET_ACCESS_KEY.secret).toBe(true);
    expect(new RegExp(a.envVarMeta?.SHOPWARE_ACCESS_KEY_ID.pattern as string).test('SWIAQ0XHNKFQAZNXWJY1DEXAMPLE')).toBe(true);
    expect(new RegExp(a.envVarMeta?.SHOPWARE_URL.pattern as string).test('https://shop.example.com')).toBe(true);
    expect(new RegExp(a.envVarMeta?.SHOPWARE_URL.pattern as string).test('https://shop.example.com/api')).toBe(false);
  });

  it('maps every search tool to POST /search/{entity} with the criteria body and the language header, read-only', () => {
    for (const [name, path] of Object.entries(SEARCHES)) {
      const t = tool(name);
      expect(t.endpointMapping.method).toBe('POST');
      expect(t.endpointMapping.path).toBe(path);
      expect(t.endpointMapping.bodyMapping).toMatchObject({
        term: '$term', ids: '$ids', filter: '$filter', sort: '$sort', associations: '$associations',
        includes: '$includes', limit: '$limit', page: '$page', 'total-count-mode': '$total_count_mode',
      });
      expect(t.endpointMapping.headers).toMatchObject({ 'sw-language-id': '$language_id' });
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
    expect(tool('shopware_6_admin_search_entities').parameters?.required).toEqual(['entity']);
    expect(tool('shopware_6_admin_search_products').endpointMapping.headers).toEqual({ 'sw-language-id': '$language_id', 'sw-inheritance': '$inheritance' });
    expect(tool('shopware_6_admin_search_products').endpointMapping.bodyMapping).toMatchObject({ aggregations: '$aggregations' });
  });

  it('maps the reads: version, product, layout tree and any entity by id', () => {
    expect(tool('shopware_6_admin_get_version').endpointMapping).toEqual({ method: 'GET', path: '/_info/version' });
    expect(tool('shopware_6_admin_get_product').endpointMapping).toEqual({ method: 'GET', path: '/product/{product_id}', headers: { 'sw-language-id': '$language_id', 'sw-inheritance': '$inheritance' } });
    expect(tool('shopware_6_admin_get_entity').endpointMapping).toEqual({ method: 'GET', path: '/{entity}/{id}', headers: { 'sw-language-id': '$language_id' } });
    const cms = tool('shopware_6_admin_get_cms_page');
    expect(cms.endpointMapping).toMatchObject({ method: 'POST', path: '/search/cms-page' });
    expect(cms.annotations?.readOnlyHint).toBe(true);
    const body = cms.endpointMapping.bodyMapping as { ids: string[]; associations: { sections: { associations: { blocks: { associations: { slots: unknown } } } } } };
    expect(body.ids).toEqual(['$cms_page_id']);
    expect(body.associations.sections.associations.blocks.associations.slots).toEqual({});
  });

  it('maps product, property, category and layout writes to the documented entity routes', () => {
    expect(tool('shopware_6_admin_update_product').endpointMapping).toMatchObject({
      method: 'PATCH', path: '/product/{product_id}', headers: { 'sw-language-id': '$language_id' },
      bodyMapping: { name: '$name', metaTitle: '$meta_title', metaDescription: '$meta_description', customFields: '$custom_fields', isCloseout: '$is_closeout', __merge: '$fields' },
    });
    expect(tool('shopware_6_admin_add_product_property').endpointMapping).toEqual({ method: 'POST', path: '/product/{product_id}/properties', bodyMapping: { id: '$option_id' } });
    expect(tool('shopware_6_admin_remove_product_property').endpointMapping).toEqual({ method: 'DELETE', path: '/product/{product_id}/properties/{option_id}' });
    expect(tool('shopware_6_admin_create_property_option').endpointMapping).toMatchObject({ method: 'POST', path: '/property-group-option', queryParams: { _response: 'detail' }, bodyMapping: { groupId: '$group_id', name: '$name' } });
    expect(tool('shopware_6_admin_create_category').endpointMapping).toMatchObject({ method: 'POST', path: '/category', queryParams: { _response: 'detail' }, bodyMapping: { name: '$name', parentId: '$parent_id', afterCategoryId: '$after_category_id', cmsPageId: '$cms_page_id' } });
    expect(tool('shopware_6_admin_update_category').endpointMapping).toMatchObject({ method: 'PATCH', path: '/category/{category_id}', headers: { 'sw-language-id': '$language_id' } });
    expect(tool('shopware_6_admin_create_cms_page').endpointMapping).toMatchObject({ method: 'POST', path: '/cms-page', bodyMapping: { name: '$name', type: '$type', sections: '$sections' } });
    expect(tool('shopware_6_admin_update_cms_page').endpointMapping).toMatchObject({ method: 'PATCH', path: '/cms-page/{cms_page_id}' });
    expect(tool('shopware_6_admin_create_cms_block').endpointMapping).toMatchObject({ method: 'POST', path: '/cms-block', bodyMapping: { sectionId: '$section_id', type: '$type', position: '$position', slots: '$slots' } });
    expect(tool('shopware_6_admin_create_cms_block').parameters?.required).toEqual(['section_id', 'type', 'position']);
    expect(tool('shopware_6_admin_update_cms_slot').endpointMapping).toEqual({ method: 'PATCH', path: '/cms-slot/{slot_id}', headers: { 'sw-language-id': '$language_id' }, bodyMapping: { config: '$config', __merge: '$fields' } });
  });

  it('creates media, uploads its file from a URL and maintains folders', () => {
    expect(tool('shopware_6_admin_create_media').endpointMapping).toMatchObject({ method: 'POST', path: '/media', queryParams: { _response: 'detail' }, bodyMapping: { mediaFolderId: '$media_folder_id', alt: '$alt', title: '$title' } });
    expect(tool('shopware_6_admin_upload_media_from_url').endpointMapping).toEqual({
      method: 'POST', path: '/_action/media/{media_id}/upload', queryParams: { extension: '$extension', fileName: '$file_name' }, bodyMapping: { url: '$url' },
    });
    expect(tool('shopware_6_admin_upload_media_from_url').parameters?.required).toEqual(['media_id', 'url', 'extension']);
    expect(tool('shopware_6_admin_update_media').endpointMapping).toMatchObject({ method: 'PATCH', path: '/media/{media_id}' });
    expect(tool('shopware_6_admin_create_media_folder').endpointMapping).toMatchObject({ method: 'POST', path: '/media-folder', bodyMapping: { name: '$name', parentId: '$parent_id', useParentConfiguration: '$use_parent_configuration', configurationId: '$configuration_id', configuration: '$configuration' } });
  });

  it('maps generic writes and the Sync API, installed switched off', () => {
    expect(tool('shopware_6_admin_create_entity').endpointMapping).toEqual({ method: 'POST', path: '/{entity}', queryParams: { _response: 'detail' }, bodyMapping: { __raw: '$data' } });
    expect(tool('shopware_6_admin_update_entity').endpointMapping).toEqual({ method: 'PATCH', path: '/{entity}/{id}', headers: { 'sw-language-id': '$language_id' }, bodyMapping: { __raw: '$data' } });
    expect(tool('shopware_6_admin_delete_entity').endpointMapping).toEqual({ method: 'DELETE', path: '/{entity}/{id}' });
    expect(tool('shopware_6_admin_sync').endpointMapping).toEqual({
      method: 'POST', path: '/_action/sync', headers: { 'fail-on-error': '$fail_on_error', 'indexing-behavior': '$indexing_behavior' }, bodyMapping: { __raw: '$operations' },
    });
    for (const n of OFF) expect(tool(n).enabled).toBe(false);
    for (const n of ['shopware_6_admin_delete_entity', 'shopware_6_admin_sync', 'shopware_6_admin_update_entity']) {
      expect(tool(n).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
  });

  it('never hands the Store API access key or app secrets to the model', () => {
    const list = applyResponseTransform(
      { total: 1, data: [{ id: 'a', name: 'Storefront', accessKey: 'SWSCSECRET', navigationCategoryId: 'c' }] },
      tool('shopware_6_admin_search_sales_channels').responseMapping as never,
    ).value as { data: Record<string, unknown>[] };
    expect(list.data[0]).toEqual({ id: 'a', name: 'Storefront', navigationCategoryId: 'c' });
    const generic = applyResponseTransform(
      { total: 1, data: [{ id: 'b', accessKey: 'k', appSecret: 's', secretAccessKey: 'x', name: 'n' }] },
      tool('shopware_6_admin_search_entities').responseMapping as never,
    ).value;
    expect(generic).toEqual({ total: 1, data: [{ id: 'b', name: 'n' }] });
    const one = applyResponseTransform({ data: { id: 'c', accessKey: 'k', name: 'n' } }, tool('shopware_6_admin_get_entity').responseMapping as never).value;
    expect(one).toEqual({ data: { id: 'c', name: 'n' } });
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

  it('writes are annotated, the risky ones installed switched off; reads are GET or marked read-only', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...OFF].sort());
    const writes = a.tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name).sort();
    expect(writes).toEqual([...OFF, ...ON_WRITES].sort());
    for (const t of a.tools) {
      if (t.annotations?.readOnlyHint === false) continue;
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      if (t.endpointMapping.method !== 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
    }
    for (const n of ['shopware_6_admin_update_product', 'shopware_6_admin_update_category', 'shopware_6_admin_update_cms_slot', 'shopware_6_admin_remove_product_property', 'shopware_6_admin_upload_media_from_url']) {
      expect(tool(n).annotations?.destructiveHint).toBe(true);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).toMatch(/sw-language-id/);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live =
  process.env.RUN_SHOPWARE_6_ADMIN_LIVE === '1' && process.env.SHOPWARE_URL && process.env.SHOPWARE_ACCESS_KEY_ID && process.env.SHOPWARE_SECRET_ACCESS_KEY
    ? describe
    : describe.skip;
live('shopware-6-admin adapter: live (read-only)', () => {
  const api = `${(process.env.SHOPWARE_URL ?? '').replace(/\/$/, '')}/api`;
  let headers: Record<string, string> = {};
  const search = async (entity: string, body: Record<string, unknown>) => {
    const res = await fetch(`${api}/search/${entity}`, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    return (await res.json()) as { total: number; data: Array<Record<string, unknown>> };
  };

  beforeAll(async () => {
    // The same form-encoded client-credentials request the OAuth2 engine sends.
    const res = await fetch(`${api}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.SHOPWARE_ACCESS_KEY_ID as string,
        client_secret: process.env.SHOPWARE_SECRET_ACCESS_KEY as string,
      }).toString(),
    });
    expect(res.status).toBe(200);
    const token = (await res.json()) as { access_token: string; token_type: string };
    headers = { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json', 'Content-Type': 'application/json' };
  }, 30_000);

  it('reads the version, languages, a product, a category and a layout with its sections', async () => {
    const version = (await (await fetch(`${api}/_info/version`, { headers })).json()) as { version: string };
    expect(version.version).toMatch(/^6\./);
    const languages = await search('language', { limit: 5, includes: { language: ['id', 'name'] } });
    expect(languages.data.length).toBeGreaterThan(0);
    const products = await search('product', { limit: 1, 'total-count-mode': 1, includes: { product: ['id', 'productNumber', 'name', 'stock'] } });
    expect(typeof products.total).toBe('number');
    if (products.data[0]) {
      const res = await fetch(`${api}/product/${String(products.data[0].id)}`, { headers: { ...headers, 'sw-language-id': String(languages.data[0].id) } });
      expect(res.status).toBe(200);
      const one = (await res.json()) as { data: { id: string } };
      expect(one.data.id).toBe(products.data[0].id);
    }
    const categories = await search('category', { limit: 1, includes: { category: ['id', 'name', 'parentId'] } });
    expect(Array.isArray(categories.data)).toBe(true);
    const pages = await search('cms-page', { limit: 1, associations: { sections: { associations: { blocks: { associations: { slots: {} } } } } } });
    expect(Array.isArray(pages.data)).toBe(true);
  }, 60_000);
});
