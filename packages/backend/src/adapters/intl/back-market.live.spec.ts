import axios from 'axios';
import * as adapter from './back-market.json';
import FormData from 'form-data';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Back Market seller API adapter (the /ws/ web services).
 *
 * Static checks always run: the token sent as `Authorization: Basic <token>`
 * through an API-key header (the token is already the encoded value, so no
 * user and password), the mandatory User-Agent and Accept-Language, the host
 * and market choices, every tool's method and path against Back Market's
 * published OpenAPI file (https://api.backmarket.dev/bundled_openapi.yaml),
 * the fixed order-line states of the order tools, the multipart care message,
 * and which tools install switched off (cancel, refunds, CSV import).
 *
 * Live checks run only with RUN_BACK_MARKET_LIVE=1. Without a token they
 * confirm the API refuses a wrong one; with BACK_MARKET_HOST,
 * BACK_MARKET_TOKEN and BACK_MARKET_MARKET they read one page of orders and
 * listings. Reads only.
 *
 *   RUN_BACK_MARKET_LIVE=1 BACK_MARKET_HOST=https://www.backmarket.fr \
 *     BACK_MARKET_TOKEN=... BACK_MARKET_MARKET=fr-fr \
 *     npx jest src/adapters/intl/back-market.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: unknown[] }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    bodyEncoding?: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
};
type EnvMeta = {
  label?: string;
  pattern?: string;
  patternMessage?: string;
  kind?: string;
  secret?: boolean;
  link?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
};
type Adapter = {
  slug: string;
  name: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  description: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, EnvMeta>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  prerequisites: string;
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const a = adapter as unknown as Adapter;
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({ name: entry.name, connectorType: 'REST', endpointMapping: entry.endpointMapping, annotations: entry.annotations });
const used = (entry: Tool) => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) out.add(p);
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
// The website renders descriptions and instructions as MDX: braces and angle
// brackets are only safe inside backticks.
const outsideBackticks = (text: string) => text.replace(/`[^`]*`/g, '');

const HOSTS = ['https://www.backmarket.fr', 'https://www.backmarket.com', 'https://www.backmarket.co.jp'];
const MARKETS = ['fr-fr', 'fr-be', 'es-es', 'de-de', 'de-at', 'it-it', 'en-gb', 'nl-nl', 'pt-pt', 'en-ie', 'el-gr', 'sk-sk', 'sv-se', 'en-us', 'ja-jp', 'en-au'];
const BASE = HOSTS[0];
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = ['Ym0', 'x'.repeat(40), '=='].join('');
const ENV: Record<string, string> = { BACK_MARKET_HOST: BASE, BACK_MARKET_TOKEN: FAKE_TOKEN, BACK_MARKET_MARKET: 'fr-fr' };
const USER_AGENT = 'BM-AnythingMCP-Connector;support@anythingmcp.com';

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: cfg.headers,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (status = 200, data: unknown = {}) => mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const method = () => String(sent().method).toUpperCase();

// Every tool with its HTTP method and path, as documented by the vendor.
const ROUTES: Record<string, string> = {
  back_market_list_orders: 'GET /ws/orders',
  back_market_get_order: 'GET /ws/orders/{order_id}',
  back_market_accept_order_line: 'POST /ws/orders/{order_id}',
  back_market_ship_order: 'POST /ws/orders/{order_id}',
  back_market_cancel_order_line: 'POST /ws/orders/{order_id}',
  back_market_refund_order_line: 'POST /ws/orders/{order_id}',
  back_market_set_order_line_identifiers: 'PATCH /ws/orderlines/{orderline_id}',
  back_market_list_listings: 'GET /ws/listings',
  back_market_get_listing: 'GET /ws/listings/detail',
  back_market_update_listing: 'POST /ws/listings/{listing_id}',
  back_market_import_listings: 'POST /ws/listings',
  back_market_get_task: 'GET /ws/tasks/{task_id}',
  back_market_list_backbox: 'GET /ws/listings_bi',
  back_market_get_competitors: 'GET /ws/backbox/v1/competitors/{listing_id}',
  back_market_get_category_tree: 'GET /ws/category/tree',
  back_market_get_category_branch: 'GET /ws/category/tree/{category_id}',
  back_market_list_care_folders: 'GET /ws/sav',
  back_market_get_care_folder: 'GET /ws/sav/{care_folder_id}',
  back_market_send_care_message: 'POST /ws/sav/{care_folder_id}/msg',
  back_market_create_care_refund: 'POST /ws/sav/refund',
  back_market_list_deliveries: 'GET /ws/shipping/v1/deliveries',
  back_market_list_returns: 'GET /ws/shipping/v1/returns',
  back_market_list_buyback_orders: 'GET /ws/buyback/v1/orders',
  back_market_get_buyback_order: 'GET /ws/buyback/v1/orders/{buyback_order_id}',
};
const SWITCHED_OFF = [
  'back_market_cancel_order_line',
  'back_market_refund_order_line',
  'back_market_import_listings',
  'back_market_create_care_refund',
];

describe('back-market adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the token as Authorization: Basic through an API-key header, with User-Agent and Accept-Language', async () => {
    expect(a.slug).toBe('back-market');
    expect(a.name).toBe('Back Market');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('back-market');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{BACK_MARKET_HOST}}');
    // Not BASIC_AUTH: the back office hands out the value that follows "Basic".
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'Basic {{BACK_MARKET_TOKEN}}' });
    expect(a.connector.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Accept-Language': '{{BACK_MARKET_MARKET}}',
      'User-Agent': USER_AGENT,
    });
    // BM-{CompanyName}-{IntegrationName};contact address, as Back Market asks.
    expect(USER_AGENT).toMatch(/^BM-[A-Za-z0-9]+-[A-Za-z0-9]+;[^@\s]+@[^@\s]+$/);
    expect(a.requiredEnvVars).toEqual(['BACK_MARKET_HOST', 'BACK_MARKET_TOKEN', 'BACK_MARKET_MARKET']);

    ok();
    await call('back_market_list_orders', { state: 1 });
    expect(sent().url).toBe(`${BASE}/ws/orders`);
    expect(method()).toBe('GET');
    expect(header(sent(), 'Authorization')).toBe(`Basic ${FAKE_TOKEN}`);
    expect(sent().auth).toBeUndefined();
    expect(header(sent(), 'User-Agent')).toBe(USER_AGENT);
    expect(header(sent(), 'Accept-Language')).toBe('fr-fr');
    expect(header(sent(), 'Accept')).toBe('application/json');
    expect(sent().params).toEqual({ state: 1, page: 1, 'page-size': 10 });
  });

  it('offers the three platforms and the sixteen markets as fixed choices, backed by patterns', () => {
    const host = a.envVarMeta.BACK_MARKET_HOST;
    expect(host.kind).toBe('address');
    expect(host.options!.map((o) => o.value)).toEqual(HOSTS);
    for (const option of host.options!) expect(option.label.length).toBeGreaterThan(5);
    const hostPattern = new RegExp(host.pattern!);
    for (const value of HOSTS) expect(hostPattern.test(value)).toBe(true);
    for (const bad of ['https://preprod.backmarket.fr', 'https://www.backmarket.de', 'http://www.backmarket.fr', 'https://www.backmarket.fr/', 'www.backmarket.com']) {
      expect(hostPattern.test(bad)).toBe(false);
    }

    const market = a.envVarMeta.BACK_MARKET_MARKET;
    expect(market.kind).toBe('setting');
    expect(market.options!.map((o) => o.value)).toEqual(MARKETS);
    expect(new Set(market.options!.map((o) => o.value)).size).toBe(16);
    expect(market.options!.length).toBeGreaterThanOrEqual(2);
    expect(market.options!.length).toBeLessThanOrEqual(20);
    const marketPattern = new RegExp(market.pattern!);
    for (const value of MARKETS) expect(marketPattern.test(value)).toBe(true);
    for (const bad of ['fr', 'FR-fr', 'en-ca', 'fr-fr ']) expect(marketPattern.test(bad)).toBe(false);
    // Every tool that takes a market offers the same codes.
    for (const entry of a.tools) {
      const prop = entry.parameters.properties?.market;
      if (!prop) continue;
      expect(prop.enum).toEqual(MARKETS);
      expect(entry.endpointMapping.headers).toEqual({ 'Accept-Language': '$market' });
    }

    const token = a.envVarMeta.BACK_MARKET_TOKEN;
    expect(token).toMatchObject({ kind: 'credential', secret: true });
    const tokenPattern = new RegExp(token.pattern!);
    expect(tokenPattern.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', 'short', `Basic ${FAKE_TOKEN}`]) expect(tokenPattern.test(bad)).toBe(false);
    for (const meta of Object.values(a.envVarMeta)) expect(meta.link).toBe('https://api.backmarket.dev/');
  });

  it('probes the order list and explains 400, 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'back_market_list_orders', params: { page_size: 1 } });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).enabled).not.toBe(false);
    for (const key of ['400', '401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    // A 403 can come from Cloudflare rather than from a wrong token.
    expect(a.verifyHints['403']).toContain('cf-ray');
  });

  it('maps every tool to the documented method and path', () => {
    const actual = Object.fromEntries(a.tools.map((t) => [t.name, `${t.endpointMapping.method} ${t.endpointMapping.path}`]));
    expect(actual).toEqual(ROUTES);
    expect(a.tools).toHaveLength(24);
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^back_market_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      const reads = used(entry);
      for (const arg of reads) expect(`${entry.name}:${arg}:${declared.has(arg) || envNames.has(arg)}`).toBe(`${entry.name}:${arg}:true`);
      for (const arg of declared) expect(`${entry.name}:${arg}:${reads.has(arg)}`).toBe(`${entry.name}:${arg}:true`);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(80);
      for (const [name, prop] of Object.entries(entry.parameters.properties ?? {})) {
        expect(`${entry.name}.${name}: ${prop.description ?? ''}`.length).toBeGreaterThan(entry.name.length + name.length + 12);
      }
    }
  });

  it('keeps braces and angle brackets inside backticks and uses no em dash', () => {
    const texts = [a.description, a.instructions, a.prerequisites, ...a.tools.map((entry) => entry.description)];
    for (const text of texts) {
      expect(outsideBackticks(text)).not.toMatch(/[{}<]/);
      expect(text).not.toMatch(/—/);
    }
  });

  it('marks reads read-only and installs cancellation, refunds and the CSV import switched off', () => {
    for (const entry of a.tools) {
      const read = entry.endpointMapping.method === 'GET';
      expect(`${entry.name}:${annotationsOf(entry).readOnlyHint}`).toBe(`${entry.name}:${read}`);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual([...SWITCHED_OFF].sort());

    // POST /ws/orders/{order_id} carries the new order-line state. Accepting
    // (2) and shipping (3) are on; cancelling (4) and refunding (5, 6) are off.
    const states = Object.fromEntries(
      a.tools
        .filter((entry) => entry.endpointMapping.path === '/ws/orders/{order_id}' && entry.endpointMapping.method === 'POST')
        .map((entry) => [entry.name, [entry.endpointMapping.bodyMapping!.new_state, entry.enabled !== false]]),
    );
    expect(states).toEqual({
      back_market_accept_order_line: [2, true],
      back_market_ship_order: [3, true],
      back_market_cancel_order_line: [4, false],
      back_market_refund_order_line: ['$new_state', false],
    });
    expect(tool('back_market_refund_order_line').parameters.properties!.new_state.enum).toEqual([5, 6]);

    for (const entry of a.tools) {
      const { method: verb, path } = entry.endpointMapping;
      if (path.includes('refund')) expect(entry.enabled).toBe(false);
      expect(verb).not.toBe('DELETE');
      // BuyBack orders and BackShip are read only; nothing validates a trade-in or pays a customer.
      if (path.startsWith('/ws/buyback') || path.startsWith('/ws/shipping')) expect(verb).toBe('GET');
      expect(path).not.toMatch(/validate|suspend|counter-offers|invoice/);
    }
  });

  it('names every tool and the setup facts in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions.startsWith('## Back Market\n')).toBe(true);
    expect(a.instructions.length).toBeGreaterThanOrEqual(1500);
    for (const fact of ['bo-seller', 'Integrations', 'without the word Basic', 'BACK_MARKET_HOST', 'BACK_MARKET_MARKET', 'Accept-Language', 'BM-AnythingMCP-Connector', 'Cloudflare', 'cf-ray', '200 calls in 10 seconds', 'Backbox', 'BackShip', 'BuyBack']) {
      expect(a.instructions).toContain(fact);
    }
  });

  it('reads orders, listings, Backbox data, tasks and care folders on the documented paths', async () => {
    ok();
    await call('back_market_list_orders', { date_modification: '2026-11-01T00:00:00Z', country_code: 'de-de', page: 2, page_size: 50 });
    expect(sent().url).toBe(`${BASE}/ws/orders`);
    expect(sent().params).toEqual({ date_modification: '2026-11-01T00:00:00Z', country_code: 'de-de', page: 2, 'page-size': 50 });

    ok();
    await call('back_market_get_order', { order_id: 5978 });
    expect(sent().url).toBe(`${BASE}/ws/orders/5978`);

    ok();
    await call('back_market_list_listings', { min_quantity: 1 });
    expect(sent().url).toBe(`${BASE}/ws/listings`);
    expect(sent().params).toEqual({ min_quantity: 1, page: 1, 'page-size': 10 });
    expect(header(sent(), 'Accept-Language')).toBe('fr-fr');

    ok();
    await call('back_market_get_listing', { sku: 'IPHONE 12/64 BLK' });
    expect(sent().url).toBe(`${BASE}/ws/listings/detail`);
    expect(sent().params).toEqual({ sku: 'IPHONE 12/64 BLK' });

    ok();
    await call('back_market_list_backbox', {});
    expect(sent().url).toBe(`${BASE}/ws/listings_bi`);
    expect(sent().params).toEqual({ page: 1, 'page-size': 10 });

    ok();
    await call('back_market_get_competitors', { listing_id: 'da72cf47-1b1f-434a-9224-1f8684ac1bd4' });
    expect(sent().url).toBe(`${BASE}/ws/backbox/v1/competitors/da72cf47-1b1f-434a-9224-1f8684ac1bd4`);

    ok();
    await call('back_market_get_task', { task_id: 1011013 });
    expect(sent().url).toBe(`${BASE}/ws/tasks/1011013`);

    ok();
    await call('back_market_get_category_branch', { category_id: 42 });
    expect(sent().url).toBe(`${BASE}/ws/category/tree/42`);

    ok();
    await call('back_market_list_care_folders', { state: 0, last_modification_date: '2026-11-01-00-00' });
    expect(sent().url).toBe(`${BASE}/ws/sav`);
    expect(sent().params).toEqual({ state: 0, last_modification_date: '2026-11-01-00-00', page: 1 });

    ok();
    await call('back_market_get_care_folder', { care_folder_id: 100000123 });
    expect(sent().url).toBe(`${BASE}/ws/sav/100000123`);

    ok();
    await call('back_market_list_deliveries', { order_id: 5978, hub_scanned: false });
    expect(sent().url).toBe(`${BASE}/ws/shipping/v1/deliveries`);
    expect(sent().params).toEqual({ order_id: 5978, hub_scanned: false, page: 1 });

    ok();
    await call('back_market_list_buyback_orders', { status: 'RECEIVED', creation_date: '2026-11-01T00:00:00Z' });
    expect(sent().url).toBe(`${BASE}/ws/buyback/v1/orders`);
    expect(sent().params).toEqual({ status: 'RECEIVED', creationDate: '2026-11-01T00:00:00Z', page: 1 });

    ok();
    await call('back_market_get_buyback_order', { buyback_order_id: 'GB-24-ABCDEF' });
    expect(sent().url).toBe(`${BASE}/ws/buyback/v1/orders/GB-24-ABCDEF`);
  });

  it('looks at another market of the platform when a tool is given one', async () => {
    ok();
    await call('back_market_list_listings', { market: 'de-de', page_size: 50 });
    expect(header(sent(), 'Accept-Language')).toBe('de-de');
    expect(sent().params).toEqual({ page: 1, 'page-size': 50 });
    expect(Object.keys(sent().headers).filter((k) => k.toLowerCase() === 'accept-language')).toHaveLength(1);

    ok();
    await call('back_market_get_category_tree', { market: 'en-gb' });
    expect(sent().url).toBe(`${BASE}/ws/category/tree`);
    expect(header(sent(), 'Accept-Language')).toBe('en-gb');
  });

  it('calls the platform chosen in BACK_MARKET_HOST', async () => {
    for (const host of HOSTS) {
      const mapping = interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, tool('back_market_list_orders').endpointMapping, {
        ...ENV,
        BACK_MARKET_HOST: host,
      });
      expect(mapping.config.baseUrl).toBe(host);
    }
  });

  it('accepts a line with state 2 and ships an order with state 3 and the tracking number', async () => {
    ok();
    await call('back_market_accept_order_line', { order_id: 5978, sku: 'IPHONE416GONLIB0' });
    expect(method()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/ws/orders/5978`);
    expect(sent().data).toEqual({ order_id: 5978, new_state: 2, sku: 'IPHONE416GONLIB0' });

    ok();
    await call('back_market_ship_order', { order_id: 5978, tracking_number: '6A12345678901', shipper: 'Colissimo' });
    expect(method()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/ws/orders/5978`);
    expect(sent().data).toEqual({ order_id: 5978, new_state: 3, tracking_number: '6A12345678901', shipper: 'Colissimo' });
    expect(tool('back_market_ship_order').parameters.required).toEqual(['order_id', 'tracking_number']);

    ok();
    await call('back_market_set_order_line_identifiers', { orderline_id: 1234, imei: '011415009341234' });
    expect(method()).toBe('PATCH');
    expect(sent().url).toBe(`${BASE}/ws/orderlines/1234`);
    expect(sent().data).toEqual({ imei: '011415009341234' });
  });

  it('updates a listing with only the given fields, keeping a quantity of 0', async () => {
    ok();
    await call('back_market_update_listing', { listing_id: 'da72cf47-1b1f-434a-9224-1f8684ac1bd4', price: '160.99', quantity: 0, market: 'en-gb', currency: 'GBP' });
    expect(method()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/ws/listings/da72cf47-1b1f-434a-9224-1f8684ac1bd4`);
    expect(sent().data).toEqual({ price: '160.99', currency: 'GBP', quantity: 0 });
    expect(header(sent(), 'Accept-Language')).toBe('en-gb');
  });

  it('posts a care message as a multipart form with the message field', async () => {
    ok(201);
    await call('back_market_send_care_message', { care_folder_id: 100000123, message: 'Bonjour, le colis part demain.' });
    expect(method()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/ws/sav/100000123/msg`);
    expect(tool('back_market_send_care_message').endpointMapping.bodyEncoding).toBe('form-data');
    expect(sent().data).toBeInstanceOf(FormData);
    const body = String((sent().data as FormData).getBuffer());
    expect(body).toContain('name="message"');
    expect(body).toContain('Bonjour, le colis part demain.');
    // The connector's JSON Content-Type gives way to the form's, as axios merges headers.
    const { AxiosHeaders } = jest.requireActual('axios') as typeof import('axios');
    expect(String(AxiosHeaders.from(sent().headers).get('content-type'))).toMatch(/^multipart\/form-data; boundary=/);
  });

  it('builds the switched-off cancel, refund and import requests', async () => {
    ok();
    await call('back_market_cancel_order_line', { order_id: 5978, sku: 'IPHONE416GONLIB0' });
    expect(sent().url).toBe(`${BASE}/ws/orders/5978`);
    expect(sent().data).toEqual({ order_id: 5978, new_state: 4, sku: 'IPHONE416GONLIB0' });

    ok();
    await call('back_market_refund_order_line', { order_id: 5978, sku: 'IPHONE416GONLIB0', new_state: 6, return_reason: 21, return_message: 'Sorry.' });
    expect(sent().data).toEqual({ order_id: 5978, new_state: 6, sku: 'IPHONE416GONLIB0', return_reason: 21, return_message: 'Sorry.' });

    ok(201);
    await call('back_market_create_care_refund', { orderline_pk: 123, refund_type: 6, amount: 89.99 });
    expect(method()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/ws/sav/refund`);
    expect(sent().data).toEqual({ orderline_pk: 123, refund_type: 6, amount: 89.99 });

    ok();
    await call('back_market_import_listings', { catalog: 'sku,quantity,price\nMY_SKU,50,123.45', delimiter: ',' });
    expect(method()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/ws/listings`);
    expect(sent().data).toEqual({ catalog: 'sku,quantity,price\nMY_SKU,50,123.45', quotechar: '"', delimiter: ',', encoding: 'utf-8' });
  });
});

// Opt-in: RUN_BACK_MARKET_LIVE=1. The refusal check needs no account; the
// reads need BACK_MARKET_HOST, BACK_MARKET_TOKEN and BACK_MARKET_MARKET.
// Nothing is written. A 403 with an HTML body is Cloudflare, not the API.
const live = process.env.RUN_BACK_MARKET_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('Back Market: live', () => {
  it('refuses a wrong token', async () => {
    const response = await liveFetch.get(`${BASE}/ws/orders`, {
      headers: { Authorization: 'Basic bm90LWEtcmVhbC10b2tlbg==', Accept: 'application/json', 'Accept-Language': 'fr-fr', 'User-Agent': USER_AGENT },
      params: { 'page-size': 1 },
      validateStatus: () => true,
    });
    expect([401, 403]).toContain(response.status);
  });

  it('reads one page of orders and listings', async () => {
    const host = process.env.BACK_MARKET_HOST;
    const token = process.env.BACK_MARKET_TOKEN;
    const market = process.env.BACK_MARKET_MARKET;
    if (!host || !token || !market) throw new Error('Set BACK_MARKET_HOST, BACK_MARKET_TOKEN and BACK_MARKET_MARKET for the live check');
    expect(HOSTS).toContain(host);
    const headers = { Authorization: `Basic ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', 'Accept-Language': market, 'User-Agent': USER_AGENT };
    const orders = await liveFetch.get(`${host}/ws/orders`, { headers, params: { 'page-size': 1 }, validateStatus: () => true });
    expect(orders.status).toBe(200);
    expect(Array.isArray(orders.data.results)).toBe(true);
    const listings = await liveFetch.get(`${host}/ws/listings`, { headers, params: { 'page-size': 1 }, validateStatus: () => true });
    expect(listings.status).toBe(200);
    expect(Array.isArray(listings.data.results)).toBe(true);
  });
});
