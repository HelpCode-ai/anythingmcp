import axios from 'axios';
import * as adapter from './reverb-listings.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { setupKind } from '../env-var-meta';

/**
 * Reverb Listings: the public, keyless reads of the Reverb API (what is for
 * sale on reverb.com). The seller side, with a personal access token, is the
 * separate `reverb` adapter; the two share no tool name.
 *
 * Static checks always run: no credentials, the headers Reverb asks for, and
 * every tool's method, URL, query and headers as the REST engine sends them.
 * Each endpoint and filter was answered without a token on 2026-11-14; the
 * price guide answered 403 ("no longer publicly available") and is left out.
 *
 * Live checks run only with RUN_REVERB_LISTINGS_LIVE=1: one search, the
 * listing and shop it leads to, and the category list. Reads only, no token.
 *
 *   RUN_REVERB_LISTINGS_LIVE=1 npx jest src/adapters/intl/reverb-listings.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; enum?: string[]; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; headers?: Record<string, string> };
  responseMapping?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig?: unknown; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
const config = () => ({ baseUrl: a.connector.baseUrl, authType: a.connector.authType, headers: a.connector.headers }) as never;
const call = (name: string, params: Record<string, unknown>) =>
  engine().execute(config(), tool(name).endpointMapping as never, applySchemaDefaults(tool(name).parameters as never, params));
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = () => mockedAxios.mockResolvedValueOnce({ status: 200, data: {}, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

const TOOLS = [
  'reverb_listings_search_listings',
  'reverb_listings_get_listing',
  'reverb_listings_list_categories',
  'reverb_listings_get_shop',
  'reverb_listings_list_shop_listings',
];

describe('reverb-listings adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('reads the public Reverb API without credentials, with the headers Reverb asks for', () => {
    expect(a.slug).toBe('reverb-listings');
    expect(a.name).toBe('Reverb Listings');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('reverb-listings');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://api.reverb.com/api');
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector).not.toHaveProperty('authConfig');
    expect(a.connector.headers).toEqual({
      Accept: 'application/hal+json',
      'Accept-Version': '3.0',
      'User-Agent': 'AnythingMCP',
    });
    expect(a.requiredEnvVars).toEqual([]);
    expect(setupKind(a as never)).toBe('none');
    expect(a.probe).toEqual({ tool: 'reverb_listings_search_listings', params: { query: 'guitar', per_page: 1 } });
  });

  it('has five read tools, none switched off, none sharing a name with the seller adapter', () => {
    expect(a.tools.map((t) => t.name)).toEqual(TOOLS);
    for (const t of a.tools) {
      expect(t.name.startsWith('reverb_listings_')).toBe(true);
      expect(t.endpointMapping.method).toBe('GET');
      expect(t.enabled).not.toBe(false);
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, def] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}: ${def.description ? 'ok' : 'missing'}`).toBe(`${t.name}.${p}: ok`);
      }
      for (const r of t.parameters.required ?? []) expect(t.parameters.properties).toHaveProperty(r);
    }
    expect(JSON.stringify(a.tools.map((t) => t.endpointMapping.path))).not.toMatch(/priceguide|\/my\//);
  });

  it('searches listings with every filter as a query parameter and no Authorization header', async () => {
    ok();
    await call('reverb_listings_search_listings', {
      query: 'fender telecaster',
      make: 'fender',
      condition: 'used',
      price_min: 500,
      price_max: 900,
      year_min: 1990,
      year_max: 2010,
      category_uuid: '14d6cc96-ed7b-4521-bc21-7713c61e9dc5',
      item_region: 'US',
      ships_to: 'DE',
      sort: 'price|asc',
      page: 2,
      per_page: 5,
      display_currency: 'EUR',
    });
    const req = sent();
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://api.reverb.com/api/listings');
    expect(req.params).toEqual({
      query: 'fender telecaster',
      make: 'fender',
      condition: 'used',
      price_min: 500,
      price_max: 900,
      year_min: 1990,
      year_max: 2010,
      category_uuid: '14d6cc96-ed7b-4521-bc21-7713c61e9dc5',
      item_region: 'US',
      ships_to: 'DE',
      sort: 'price|asc',
      page: 2,
      per_page: 5,
    });
    expect(header(req, 'Accept')).toBe('application/hal+json');
    expect(header(req, 'Accept-Version')).toBe('3.0');
    expect(header(req, 'User-Agent')).toBe('AnythingMCP');
    expect(header(req, 'X-Display-Currency')).toBe('EUR');
    expect(header(req, 'Authorization')).toBeUndefined();
  });

  it('sends only what was asked: a bare search has the query, the first page and no currency header', async () => {
    ok();
    await call('reverb_listings_search_listings', { query: 'sm57' });
    expect(sent().params).toEqual({ query: 'sm57', page: 1 });
    expect(header(sent(), 'X-Display-Currency')).toBeUndefined();
    const props = tool('reverb_listings_search_listings').parameters.properties!;
    expect(props.condition.enum).toEqual(['new', 'used']);
    expect(props.sort.enum).toEqual(['price|asc', 'price|desc']);
    expect(tool('reverb_listings_search_listings').parameters.required).toBeUndefined();
  });

  it('reads a listing and a shop by path, and a shop\'s listings through the shop filter', async () => {
    ok();
    await call('reverb_listings_get_listing', { listing_id: '102787080' });
    expect(sent().url).toBe('https://api.reverb.com/api/listings/102787080');
    expect(tool('reverb_listings_get_listing').parameters.required).toEqual(['listing_id']);

    ok();
    await call('reverb_listings_get_shop', { shop_slug: 'gear-junkie' });
    expect(sent().url).toBe('https://api.reverb.com/api/shops/gear-junkie');

    ok();
    await call('reverb_listings_list_shop_listings', { shop_slug: 'gear-junkie', price_max: 300, per_page: 10 });
    expect(sent().url).toBe('https://api.reverb.com/api/listings');
    expect(sent().params).toEqual({ shop: 'gear-junkie', price_max: 300, page: 1, per_page: 10 });
    expect(tool('reverb_listings_list_shop_listings').parameters.required).toEqual(['shop_slug']);
  });

  it('lists the categories flat and keeps only what a search needs from each', async () => {
    ok();
    await call('reverb_listings_list_categories', {});
    expect(sent().url).toBe('https://api.reverb.com/api/categories/flat');

    const upstream = {
      categories: [
        {
          uuid: '14d6cc96-ed7b-4521-bc21-7713c61e9dc5',
          full_name: 'Acoustic Guitars / 12-String',
          name: '12-String',
          root_uuid: '3ca3eb03-7eac-477d-b253-15ce603d2550',
          root_slug: 'acoustic-guitars',
          slug: '12-string',
          collection_title: '12-String Acoustic Guitars',
          listable: true,
          _links: { self: { href: 'https://api.reverb.com/api/categories/14d6cc96' }, image: { href: 'https://example.test/i.jpg' } },
        },
      ],
    };
    const shaped = applyResponseTransform(upstream, tool('reverb_listings_list_categories').responseMapping);
    expect(shaped.applied).toBe(true);
    expect(shaped.value).toEqual({
      categories: [
        {
          uuid: '14d6cc96-ed7b-4521-bc21-7713c61e9dc5',
          full_name: 'Acoustic Guitars / 12-String',
          slug: '12-string',
          root_slug: 'acoustic-guitars',
        },
      ],
    });
  });

  it('names every tool, the seller connector and the limits in the instructions', () => {
    expect(a.instructions).toMatch(/^## Reverb Listings\n/);
    expect(a.instructions).toMatch(/needs no Reverb account/);
    expect(a.instructions).toMatch(/use the \*\*Reverb\*\* connector/);
    expect(a.instructions).toMatch(/page 50/);
    expect(a.instructions).toMatch(/2,000 read requests per minute/);
    expect(a.instructions).toMatch(/price guide is not offered/);
    for (const t of a.tools) expect(a.instructions).toContain(`\`${t.name}\``);
    expect(Object.keys(a.verifyHints).sort()).toEqual(['403', '404', '429', 'rate_limited']);
  });

  it('keeps braces and angle brackets out of the texts the website renders, and uses no em or en dashes', () => {
    const outsideBackticks = (s: string) => s.replace(/`[^`]*`/g, '');
    for (const text of [a.instructions, ...a.tools.map((t) => t.description)]) {
      expect(outsideBackticks(text)).not.toMatch(/[{}<]/);
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const live = process.env.RUN_REVERB_LISTINGS_LIVE === '1' ? describe : describe.skip;

live('reverb-listings adapter: live reads without a token', () => {
  jest.setTimeout(60_000);
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockImplementation((cfg: unknown) => (mockedAxios.__actual as unknown as (c: unknown) => unknown)(cfg));
  });
  let listing: { id: number; shop: { slug: string } };

  it('searches listings', async () => {
    const out = (await call('reverb_listings_search_listings', { query: 'fender stratocaster', condition: 'used', price_max: 900, per_page: 2 })) as any;
    expect(out.total).toBeGreaterThan(0);
    expect(out.listings.length).toBeLessThanOrEqual(2);
    listing = out.listings[0];
    expect(listing.id).toEqual(expect.any(Number));
    expect(out.listings[0].price.currency).toBe('USD');
  });

  it('reads that listing, its shop and the shop listings', async () => {
    const one = (await call('reverb_listings_get_listing', { listing_id: String(listing.id) })) as any;
    expect(one.id).toBe(listing.id);
    const shop = (await call('reverb_listings_get_shop', { shop_slug: listing.shop.slug })) as any;
    expect(shop.slug).toBe(listing.shop.slug);
    const theirs = (await call('reverb_listings_list_shop_listings', { shop_slug: listing.shop.slug, per_page: 2 })) as any;
    expect(theirs.listings.every((l: any) => l.shop.slug === listing.shop.slug)).toBe(true);
  });

  it('lists the categories', async () => {
    const raw = (await call('reverb_listings_list_categories', {})) as any;
    const shaped = applyResponseTransform(raw, tool('reverb_listings_list_categories').responseMapping).value as any;
    expect(shaped.categories.length).toBeGreaterThan(100);
    expect(Object.keys(shaped.categories[0]).sort()).toEqual(['full_name', 'root_slug', 'slug', 'uuid']);
  });
});
