import axios from 'axios';
import * as adapter from './hornbach-shop.json';
import * as ssrf from '../../common/ssrf.util';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * HORNBACH Shop adapter (shopper side): HORNBACH's official catalog endpoint
 * for AI agents, published under the Universal Commerce Protocol (UCP 2026-08-25).
 * Each country shop serves a profile at /.well-known/ucp naming a REST endpoint
 * at <shop>/ucp with two capabilities, dev.ucp.shopping.catalog.search and
 * dev.ucp.shopping.catalog.lookup (schema
 * https://ucp.dev/2026-08-25/services/shopping/rest.openapi.json):
 *   POST /ucp/catalog/search   POST /ucp/catalog/lookup
 * No authentication. The REST schema requires the UCP-Agent and Request-Id
 * headers; HORNBACH's bot protection challenges browser User-Agents, so the
 * connector sends a plain agent User-Agent.
 *
 * Static checks always run: connector, headers, the country choice, tool
 * names and arguments, read-only hints, the requests both tools build through
 * the real RestEngine (axios mocked) and the response trimming.
 *
 * Live checks run only with RUN_HORNBACH_SHOP_LIVE=1 (no key needed). They read
 * the UCP profile of every listed shop, run one search and one lookup on
 * hornbach.de through the RestEngine with the real axios:
 *
 *   RUN_HORNBACH_SHOP_LIVE=1 npx jest src/adapters/de/hornbach-shop.live.spec.ts
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
  parameters: {
    properties?: Record<string, { description?: string; default?: unknown }>;
    required?: string[];
  };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  responseMapping?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  description: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<
    string,
    { pattern?: string; kind?: string; secret?: boolean; options?: { value: string; label: string }[] }
  >;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown>; failWhen?: { matches: string; hint: string }[] };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    headers: Record<string, string>;
    config?: { errorWhen?: unknown };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({
    name: entry.name,
    connectorType: 'REST',
    endpointMapping: entry.endpointMapping,
    annotations: entry.annotations,
  });
// Every argument a mapping reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (entry: Tool) => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (/^\$\w+$/.test(v)) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
// Text outside `code spans`: the website renders descriptions as MDX.
const prose = (text: string) => text.replace(/`[^`]*`/g, '');

const SHOPS = [
  'https://www.hornbach.de',
  'https://www.hornbach.at',
  'https://www.hornbach.ch',
  'https://www.hornbach.nl',
  'https://www.hornbach.lu',
  'https://www.hornbach.se',
  'https://www.hornbach.cz',
  'https://www.hornbach.sk',
  'https://www.hornbach.ro',
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const stubLogin = {} as LoginTokenService;

const call = (name: string, params: Record<string, unknown>, shop = 'https://www.hornbach.de') => {
  const env = { HORNBACH_SHOP_URL: shop };
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, stubLogin).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      headers: cfg.headers,
      errorWhen: a.connector.config?.errorWhen,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...env },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (data: unknown = { ucp: { version: '2026-08-25' }, products: [] }) =>
  mockedAxios.mockResolvedValueOnce({ status: 200, data, headers: { 'content-type': 'application/json' } });
const header = (req: { headers: Record<string, unknown> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

// A trimmed copy of a real hornbach.de search answer (2026-11-15).
const product = () => ({
  id: '12802554',
  title: 'Akkuschrauber Bosch IXO 8',
  handle: 'akkuschrauber-bosch-ixo-8',
  url: 'https://www.hornbach.de/p/akkuschrauber-bosch-ixo-8/12802554/',
  description: { html: '<p><b>Produkt-Highlights:</b></p>', plain: 'Produkt-Highlights: Akku-Allrounder' },
  categories: [{ taxonomy: 'hornbach-webshop', value: 'Maschinen, Werkzeug & Werkstatt > Maschinen > Akkuschrauber' }],
  media: [{ type: 'image', url: 'https://media.hornbach.de/hb/packshot/as.186910014.jpg?dvid=8', alt_text: 'Bosch IXO Set' }],
  price_range: { min: { amount: 6695, currency: 'EUR' }, max: { amount: 6695, currency: 'EUR' } },
  variants: [
    {
      id: '12802554',
      sku: '12802554_ST',
      title: 'Akkuschrauber Bosch IXO 8',
      price: { amount: 6695, currency: 'EUR' },
      availability: { available: true },
      barcodes: [{ type: 'gtin', value: '4053423629828' }],
      seller: { name: 'HORNBACH Webshop DE' },
      description: { html: '<p>…</p>', plain: '…' },
      media: [{ type: 'image', url: 'https://media.hornbach.de/hb/packshot/as.186910014.jpg?dvid=8', alt_text: 'Bosch IXO Set' }],
    },
  ],
});

describe('hornbach-shop adapter: static contract', () => {
  beforeEach(() => {
    mockedAxios.mockReset();
    jest.spyOn(ssrf, 'assertSafeOutboundUrl').mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('is a keyless REST connector on the chosen shop with the UCP agent headers', () => {
    expect(a.slug).toBe('hornbach-shop');
    expect(a.region).toBe('de');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('hornbach-shop');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.baseUrl).toBe('{{HORNBACH_SHOP_URL}}/ucp');
    expect(a.connector.headers['UCP-Agent']).toBe('profile="https://anythingmcp.com/.well-known/ucp"');
    expect(a.connector.headers['Request-Id']).toMatch(UUID);
    expect(a.connector.headers['User-Agent']).toMatch(/^AnythingMCP\//);
    expect(a.connector.headers['User-Agent']).not.toMatch(/Mozilla|Chrome|Safari/);
  });

  it('offers the nine country shops as a choice and nothing secret', () => {
    expect(a.requiredEnvVars).toEqual(['HORNBACH_SHOP_URL']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    const meta = a.envVarMeta.HORNBACH_SHOP_URL;
    expect(meta.secret).toBe(false);
    expect(meta.kind).toBe('address');
    expect(meta.options!.map((o) => o.value)).toEqual(SHOPS);
    const pattern = new RegExp(meta.pattern!);
    for (const shop of SHOPS) expect(pattern.test(shop)).toBe(true);
    for (const bad of ['https://www.hornbach.de/', 'https://www.hornbach.de/ucp', 'http://www.hornbach.de', 'https://hornbach.fr']) {
      expect(pattern.test(bad)).toBe(false);
    }
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((entry) => entry.name === 'HORNBACH_SHOP_URL')).toMatchObject({ secret: false, required: true });
  });

  it('probes with a one-product search and explains refusals, challenges and limits', () => {
    expect(a.probe.tool).toBe('hornbach_shop_search_products');
    expect(a.probe.params).toEqual({ query: 'Bosch', limit: 1 });
    expect(a.probe.failWhen?.[0].matches).toBe('Client Challenge');
    for (const key of ['400', '403', '404', '429']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    expect(a.tools.map((entry) => entry.name)).toEqual(['hornbach_shop_search_products', 'hornbach_shop_lookup_products']);
    const mine = new Set(a.tools.map((entry) => entry.name));
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(`${entry.name}:${declared.has(arg)}`).toBe(`${entry.name}:true`);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const [p, schema] of Object.entries(entry.parameters.properties ?? {})) {
        expect(`${entry.name}.${p}:${typeof schema.description}`).toBe(`${entry.name}.${p}:string`);
      }
    }
    expect(tool('hornbach_shop_search_products').parameters.required).toEqual(['query']);
    expect(tool('hornbach_shop_lookup_products').parameters.required).toEqual(['ids']);
  });

  it('marks both POST reads read-only and installs nothing switched off', () => {
    for (const entry of a.tools) {
      expect(entry.endpointMapping.method).toBe('POST');
      expect(entry.enabled).toBeUndefined();
      expect(annotationsOf(entry)).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    }
  });

  it('says prices are in cents of the shop currency, names every tool, and keeps the text MDX-safe', () => {
    for (const entry of a.tools) {
      expect(entry.description).toMatch(/minor units \(cents\)/);
      for (const currency of ['EUR', 'CHF', 'SEK', 'CZK']) expect(entry.description).toContain(currency);
      expect(a.instructions).toContain(`\`${entry.name}\``);
      expect(prose(entry.description)).not.toMatch(/[{}<]/);
      for (const schema of Object.values(entry.parameters.properties ?? {})) expect(prose(schema.description!)).not.toMatch(/[{}<]/);
    }
    expect(a.instructions.startsWith('## HORNBACH Shop\n')).toBe(true);
    expect(a.instructions).toContain('**Where to start**');
    expect(prose(a.instructions)).not.toMatch(/[{}<]/);
    expect(prose(a.description)).not.toMatch(/[{}<]/);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('searches with query, price filters, page size and cursor, and sends the UCP headers', async () => {
    ok();
    await call('hornbach_shop_search_products', { query: 'Akkuschrauber', price_min: 1000, price_max: 3000, limit: 5, cursor: 'eyJwYWdlIjoyfQ' });
    const req = sent();
    expect(req.url).toBe('https://www.hornbach.de/ucp/catalog/search');
    expect(String(req.method).toUpperCase()).toBe('POST');
    expect(header(req, 'UCP-Agent')).toBe('profile="https://anythingmcp.com/.well-known/ucp"');
    expect(header(req, 'Request-Id')).toMatch(UUID);
    expect(header(req, 'User-Agent')).toBe('AnythingMCP/1.0 (+https://anythingmcp.com)');
    expect(header(req, 'Accept')).toBe('application/json');
    expect(String(header(req, 'Content-Type'))).toMatch(/application\/json/);
    expect(req.data).toEqual({
      query: 'Akkuschrauber',
      filters: { price: { min: 1000, max: 3000 } },
      pagination: { limit: 5, cursor: 'eyJwYWdlIjoyfQ' },
    });
  });

  it('sends ten per page and no prices or cursor when only a query is given', async () => {
    ok();
    await call('hornbach_shop_search_products', { query: '4006825673906' });
    // HORNBACH accepts the empty price object (checked live on 2026-11-15).
    expect(sent().data).toEqual({ query: '4006825673906', filters: { price: {} }, pagination: { limit: 10 } });
  });

  it('looks up article numbers on the chosen country shop', async () => {
    ok();
    await call('hornbach_shop_lookup_products', { ids: ['12802554', '12080683'] });
    expect(sent().url).toBe('https://www.hornbach.de/ucp/catalog/lookup');
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({ ids: ['12802554', '12080683'] });
    expect(header(sent(), 'UCP-Agent')).toBe('profile="https://anythingmcp.com/.well-known/ucp"');
    expect(header(sent(), 'Request-Id')).toMatch(UUID);

    ok();
    await call('hornbach_shop_lookup_products', { ids: ['8489472'] }, 'https://www.hornbach.ch');
    expect(sent().url).toBe('https://www.hornbach.ch/ucp/catalog/lookup');
  });

  it('turns a UCP error inside a 200 answer into a failed call', async () => {
    ok({
      ucp: { version: '2026-08-25', status: 'error' },
      messages: [{ type: 'error', code: 'invalid_request', content: 'Bad request', severity: 'recoverable' }],
    });
    await expect(call('hornbach_shop_lookup_products', { ids: ['1'] })).rejects.toThrow(/Bad request/);
  });

  it('drops the HTML copy, image captions and per-variant duplicates but keeps prices, stock and GTINs', () => {
    for (const entry of a.tools) {
      const outcome = applyResponseTransform({ ucp: {}, products: [product()], pagination: { has_next_page: false } }, entry.responseMapping);
      expect(outcome.applied).toBe(true);
      const p = (outcome.value as { products: ReturnType<typeof product>[] }).products[0];
      expect(p.description).toEqual({ plain: 'Produkt-Highlights: Akku-Allrounder' });
      expect(p.media).toEqual([{ type: 'image', url: 'https://media.hornbach.de/hb/packshot/as.186910014.jpg?dvid=8' }]);
      expect(p.price_range.min).toEqual({ amount: 6695, currency: 'EUR' });
      expect(p.variants[0]).toEqual({
        id: '12802554',
        sku: '12802554_ST',
        title: 'Akkuschrauber Bosch IXO 8',
        price: { amount: 6695, currency: 'EUR' },
        availability: { available: true },
        barcodes: [{ type: 'gtin', value: '4053423629828' }],
        seller: { name: 'HORNBACH Webshop DE' },
      });
      expect((outcome.value as { pagination: unknown }).pagination).toEqual({ has_next_page: false });
    }
  });
});

// Opt-in: RUN_HORNBACH_SHOP_LIVE=1. Reads only; HORNBACH offers no cart or checkout here.
const live = process.env.RUN_HORNBACH_SHOP_LIVE === '1';
const real = mockedAxios.__actual;
(live ? describe : describe.skip)('HORNBACH Shop: live', () => {
  jest.setTimeout(60_000);
  beforeEach(() => {
    jest.restoreAllMocks();
    mockedAxios.mockReset();
    mockedAxios.mockImplementation((cfg) => real.request(cfg));
  });

  it('every listed shop publishes a UCP profile with search and lookup at <shop>/ucp', async () => {
    for (const shop of SHOPS) {
      const res = await real.get(`${shop}/.well-known/ucp`, {
        headers: { 'User-Agent': a.connector.headers['User-Agent'] },
        validateStatus: () => true,
      });
      expect(`${shop}:${res.status}`).toBe(`${shop}:200`);
      const ucp = res.data.ucp;
      expect(ucp.services['dev.ucp.shopping'][0]).toMatchObject({ transport: 'rest', endpoint: `${shop}/ucp` });
      expect(Object.keys(ucp.capabilities)).toEqual(
        expect.arrayContaining(['dev.ucp.shopping.catalog.search', 'dev.ucp.shopping.catalog.lookup']),
      );
    }
  });

  it('searches hornbach.de and looks up the first hit by article number', async () => {
    const found = (await call('hornbach_shop_search_products', { query: 'Akkuschrauber', limit: 2 })) as {
      products: ReturnType<typeof product>[];
      pagination: { has_next_page: boolean; cursor?: string };
    };
    expect(found.products.length).toBeGreaterThan(0);
    const first = found.products[0];
    expect(first.id).toMatch(/^[0-9]+$/);
    expect(first.url).toMatch(/^https:\/\/www\.hornbach\.de\/p\//);
    expect(Number.isInteger(first.price_range.min.amount)).toBe(true);
    expect(first.price_range.min.currency).toBe('EUR');
    expect(typeof first.variants[0].availability.available).toBe('boolean');
    if (found.pagination.has_next_page) expect(found.pagination.cursor).toBeTruthy();

    const looked = (await call('hornbach_shop_lookup_products', { ids: [first.id] })) as {
      products: ReturnType<typeof product>[];
    };
    expect(looked.products[0].id).toBe(first.id);
  });
});
