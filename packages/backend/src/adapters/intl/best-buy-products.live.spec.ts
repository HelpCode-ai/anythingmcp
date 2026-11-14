import axios from 'axios';
import * as adapter from './best-buy-products.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { setupKind } from '../env-var-meta';

/**
 * Best Buy Products: the read APIs of api.bestbuy.com/v1 (Products, Stores,
 * Categories, Recommendations), with the key as the `apiKey` query parameter.
 * https://bestbuyapis.github.io/api-documentation/
 *
 * Static checks always run: the key placement, and every tool's URL as the
 * REST engine sends it. Best Buy puts its filter in the path
 * (`/products(search=tv&salePrice<500)`), so the URLs are pinned exactly.
 *
 * Live checks run only with RUN_BEST_BUY_PRODUCTS_LIVE=1 and BEST_BUY_API_KEY.
 * We have no key, so they have never run. Reads only.
 *
 *   RUN_BEST_BUY_PRODUCTS_LIVE=1 BEST_BUY_API_KEY=... \
 *     npx jest src/adapters/intl/best-buy-products.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
    AxiosHeaders: actual.AxiosHeaders,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown; pattern?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; encodePathParams?: boolean; queryParams?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind: string; secret: boolean; link: string; pattern?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const KEY = process.env.BEST_BUY_API_KEY || 'testkey0123456789abcdefgh';
const call = (name: string, params: Record<string, unknown>) =>
  new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: a.connector.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, { BEST_BUY_API_KEY: KEY }),
      headers: a.connector.headers,
    } as never,
    tool(`best_buy_products_${name}`).endpointMapping as never,
    applySchemaDefaults(tool(`best_buy_products_${name}`).parameters as never, params),
  );
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = () => mockedAxios.mockResolvedValueOnce({ status: 200, data: {}, headers: {} });
const V1 = 'https://api.bestbuy.com/v1';
const SHOW =
  'sku,name,manufacturer,modelNumber,salePrice,regularPrice,onSale,customerReviewAverage,customerReviewCount,onlineAvailability,inStoreAvailability,url,image,shortDescription';

const TOOLS = [
  'search_products',
  'list_category_products',
  'get_products_by_sku',
  'query_products',
  'get_product',
  'find_stores',
  'get_store_availability',
  'list_categories',
  'get_trending_products',
  'get_most_viewed_products',
  'get_also_viewed_products',
].map((n) => `best_buy_products_${n}`);

describe('best-buy-products adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('calls api.bestbuy.com/v1 with the key as the apiKey query parameter', async () => {
    expect(a.slug).toBe('best-buy-products');
    expect(a.name).toBe('Best Buy Products');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('best-buy-products');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(V1);
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ apiKey: '{{BEST_BUY_API_KEY}}' });
    expect(a.requiredEnvVars).toEqual(['BEST_BUY_API_KEY']);
    expect(a.envVarMeta.BEST_BUY_API_KEY).toMatchObject({ kind: 'credential', secret: true, link: 'https://developer.bestbuy.com' });
    expect(setupKind(a as never)).toBe('credentials');
    expect(a.probe).toEqual({ tool: 'best_buy_products_list_categories', params: { page_size: 1 } });

    ok();
    await call('get_product', { sku: 8880044 });
    expect(sent().params.apiKey).toBe(KEY);
    expect(JSON.stringify(sent().headers)).not.toContain(KEY);
    expect(sent().url).not.toContain(KEY);
  });

  it('has eleven read tools, none switched off', () => {
    expect(a.tools.map((t) => t.name)).toEqual(TOOLS);
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(t.enabled).not.toBe(false);
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, def] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}: ${def.description ? 'ok' : 'missing'}`).toBe(`${t.name}.${p}: ok`);
      }
      for (const r of t.parameters.required ?? []) expect(t.parameters.properties).toHaveProperty(r);
      // Every {param} of the path is a declared parameter that is required or has a default.
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) {
        const def = t.parameters.properties?.[p];
        expect(`${t.name}.${p}: ${def ? 'declared' : 'missing'}`).toBe(`${t.name}.${p}: declared`);
        const filled = (t.parameters.required ?? []).includes(p) || def?.default !== undefined;
        expect(`${t.name}.${p}: ${filled ? 'always filled' : 'can be empty'}`).toBe(`${t.name}.${p}: always filled`);
      }
    }
  });

  it('searches by keyword with the price range in the path filter and asks for JSON', async () => {
    ok();
    await call('search_products', { search: 'oled tv' });
    expect(sent().url).toBe(`${V1}/products(search=oled%20tv&salePrice>=0&salePrice<=1000000)`);
    expect(sent().params).toEqual({ format: 'json', show: SHOW, page: 1, pageSize: 10, apiKey: KEY });

    ok();
    await call('search_products', { search: 'laptop', min_price: 300, max_price: 799.99, sort: 'salePrice.asc', page: 2, page_size: 25, show: 'sku,name' });
    expect(sent().url).toBe(`${V1}/products(search=laptop&salePrice>=300&salePrice<=799.99)`);
    expect(sent().params).toEqual({ format: 'json', show: 'sku,name', sort: 'salePrice.asc', page: 2, pageSize: 25, apiKey: KEY });
    expect(tool('best_buy_products_search_products').parameters.required).toEqual(['search']);
  });

  it('cannot be made to leave the filter: a keyword with filter characters is percent-encoded', async () => {
    ok();
    await call('search_products', { search: 'tv)&sku=*|(name=a' });
    expect(sent().url).toBe(`${V1}/products(search=tv)%26sku%3D*%7C(name%3Da&salePrice>=0&salePrice<=1000000)`);
  });

  it('lists a category, reads SKUs in one call and passes a raw filter through', async () => {
    ok();
    await call('list_category_products', { category_id: 'abcat0502000', max_price: 800 });
    expect(sent().url).toBe(`${V1}/products(categoryPath.id=abcat0502000&salePrice>=0&salePrice<=800)`);

    ok();
    await call('get_products_by_sku', { skus: '6534009,8880044' });
    expect(sent().url).toBe(`${V1}/products(sku%20in(6534009,8880044))`);
    expect(sent().params).toMatchObject({ format: 'json', show: SHOW });
    const skus = new RegExp(tool('best_buy_products_get_products_by_sku').parameters.properties!.skus.pattern!);
    expect(skus.test('6534009,8880044')).toBe(true);
    expect(skus.test('6534009, 8880044')).toBe(false);
    expect(skus.test('1)|(sku=*')).toBe(false);

    ok();
    await call('query_products', { query: 'manufacturer=canon&salePrice<1000' });
    expect(sent().url).toBe(`${V1}/products(manufacturer=canon&salePrice<1000)`);
    expect(sent().params).toMatchObject({ format: 'json', page: 1, pageSize: 10 });
    expect(tool('best_buy_products_query_products').description).toMatch(/`&` \(and\) or `\|` \(or\)/);
    expect(tool('best_buy_products_query_products').description).toMatch(/%20/);
  });

  it('reads one product with the .json extension', async () => {
    ok();
    await call('get_product', { sku: 8880044, show: 'sku,name,salePrice' });
    expect(sent().url).toBe(`${V1}/products/8880044.json`);
    expect(sent().params).toEqual({ show: 'sku,name,salePrice', apiKey: KEY });
  });

  it('finds stores around a ZIP code and checks where a SKU is in stock', async () => {
    ok();
    await call('find_stores', { postal_code: '55423' });
    expect(sent().url).toBe(`${V1}/stores(area(55423,10))`);
    expect(sent().params).toMatchObject({ format: 'json', page: 1, pageSize: 10 });
    ok();
    await call('find_stores', { postal_code: '55423', radius_miles: 25 });
    expect(sent().url).toBe(`${V1}/stores(area(55423,25))`);

    ok();
    await call('get_store_availability', { sku: 4807511, postal_code: '55423' });
    expect(sent().url).toBe(`${V1}/products/4807511/stores.json`);
    expect(sent().params).toEqual({ postalCode: '55423', apiKey: KEY });
    ok();
    await call('get_store_availability', { sku: 4807511, store_id: 281 });
    expect(sent().params).toEqual({ storeId: 281, apiKey: KEY });
  });

  it('lists every category by default, and finds one by name or id', async () => {
    ok();
    await call('list_categories', {});
    expect(sent().url).toBe(`${V1}/categories(name=*&id=*)`);
    expect(sent().params).toEqual({ format: 'json', show: 'id,name,url,path,subCategories', page: 1, pageSize: 10, apiKey: KEY });
    ok();
    await call('list_categories', { name: 'Sony DSLR Camera*' });
    expect(sent().url).toBe(`${V1}/categories(name=Sony%20DSLR%20Camera*&id=*)`);
    ok();
    await call('list_categories', { category_id: 'abcat0100000' });
    expect(sent().url).toBe(`${V1}/categories(name=*&id=abcat0100000)`);
  });

  it('reads the recommendation lists by category and by SKU', async () => {
    ok();
    await call('get_trending_products', { category_id: 'abcat0400000' });
    expect(sent().url).toBe(`${V1}/products/trendingViewed(categoryId=abcat0400000)`);
    ok();
    await call('get_most_viewed_products', { category_id: 'abcat0107000' });
    expect(sent().url).toBe(`${V1}/products/mostViewed(categoryId=abcat0107000)`);
    ok();
    await call('get_also_viewed_products', { sku: 8880044 });
    expect(sent().url).toBe(`${V1}/products/8880044/alsoViewed`);
    expect(sent().params).toEqual({ apiKey: KEY });
  });

  it('says how to get a key as the developer portal does, names every tool and the read-only scope', () => {
    expect(a.instructions).toMatch(/^## Best Buy Products\n/);
    expect(a.instructions).toMatch(/Get API Key/);
    expect(a.instructions).toMatch(/sign up with your email address/);
    expect(a.instructions).toMatch(/Commerce API is by invitation/);
    expect(a.instructions).toMatch(/does not publish its rate limits/);
    expect(String(a.prerequisites)).toContain('developer.bestbuy.com');
    for (const t of a.tools) expect(a.instructions).toContain(`\`${t.name}\``);
    expect(Object.keys(a.verifyHints).sort()).toEqual(['400', '403', '404', 'rate_limited']);
  });

  it('keeps braces and angle brackets out of the texts the website renders, and uses no em or en dashes', () => {
    const outsideBackticks = (s: string) => s.replace(/`[^`]*`/g, '');
    for (const text of [a.instructions, ...a.tools.map((t) => t.description)]) {
      expect(outsideBackticks(text)).not.toMatch(/[{}<]/);
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const live = process.env.RUN_BEST_BUY_PRODUCTS_LIVE === '1' && process.env.BEST_BUY_API_KEY ? describe : describe.skip;

live('best-buy-products adapter: live reads with a key', () => {
  jest.setTimeout(60_000);
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockImplementation((cfg: unknown) => (mockedAxios.__actual as unknown as (c: unknown) => unknown)(cfg));
  });

  it('lists categories, searches products and reads one', async () => {
    const categories = (await call('list_categories', { name: 'Laptops*', page_size: 2 })) as any;
    expect(categories.categories.length).toBeGreaterThan(0);
    const found = (await call('search_products', { search: 'laptop', max_price: 800, page_size: 2 })) as any;
    expect(found.products.length).toBeGreaterThan(0);
    expect(found.products[0].salePrice).toBeLessThanOrEqual(800);
    const one = (await call('get_product', { sku: found.products[0].sku, show: 'sku,name,salePrice' })) as any;
    expect(one.sku).toBe(found.products[0].sku);
    const many = (await call('get_products_by_sku', { skus: String(found.products[0].sku) })) as any;
    expect(many.products[0].sku).toBe(found.products[0].sku);
    const stores = (await call('find_stores', { postal_code: '55423', page_size: 1 })) as any;
    expect(stores.stores.length).toBe(1);
  });
});
