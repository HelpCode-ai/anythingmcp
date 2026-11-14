import axios from 'axios';
import * as adapter from './reverb.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Reverb API adapter for sellers (personal access token).
 *
 * Static checks always run: the Bearer token with the HAL media type, the
 * Accept-Version 3.0 header and a User-Agent on every call, every tool's
 * method and path against Reverb's own guides (https://www.reverb-api.com/docs/)
 * and the API index at https://api.reverb.com/api, the listing, ship, message,
 * offer and refund bodies, and which tools install switched off (ending a
 * listing, accepting or countering an offer, refunds). There is no keyless
 * tool here: public listing search is a separate adapter.
 *
 * Live checks run only with RUN_REVERB_LIVE=1. Without a token they read the
 * public API index and confirm it still links the paths this adapter uses, and
 * that a wrong token is refused; with REVERB_TOKEN they read one listing and
 * the shop. Reads only.
 *
 *   RUN_REVERB_LIVE=1 REVERB_TOKEN=... npx jest src/adapters/intl/reverb.live.spec.ts
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

const BASE = 'https://api.reverb.com/api';
const HAL = 'application/hal+json';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = ['7f', 'a'.repeat(56), '3c'].join('');
const ENV: Record<string, string> = { REVERB_TOKEN: FAKE_TOKEN };

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
  reverb_list_my_listings: 'GET /my/listings',
  reverb_list_my_drafts: 'GET /my/listings/drafts',
  reverb_get_listing: 'GET /listings/{listing_id}',
  reverb_create_listing: 'POST /listings',
  reverb_update_listing: 'PUT /listings/{listing_id}',
  reverb_publish_listing: 'PUT /listings/{listing_id}',
  reverb_end_listing: 'PUT /my/listings/{listing_id}/state/end',
  reverb_list_orders: 'GET /my/orders/selling/all',
  reverb_list_orders_awaiting_shipment: 'GET /my/orders/selling/awaiting_shipment',
  reverb_get_order: 'GET /my/orders/selling/{order_number}',
  reverb_ship_order: 'POST /my/orders/selling/{order_number}/ship',
  reverb_mark_order_picked_up: 'POST /my/orders/selling/{order_number}/mark_picked_up',
  reverb_list_shipping_providers: 'GET /shipping/providers',
  reverb_list_conversations: 'GET /my/conversations',
  reverb_get_conversation: 'GET /my/conversations/{conversation_id}',
  reverb_send_message: 'POST /my/conversations/{conversation_id}/messages',
  reverb_list_offers: 'GET /my/listings/negotiations',
  reverb_get_offer: 'GET /my/negotiations/{offer_id}',
  reverb_decline_offer: 'POST /my/negotiations/{offer_id}/decline',
  reverb_accept_offer: 'POST /my/negotiations/{offer_id}/accept',
  reverb_counter_offer: 'POST /my/negotiations/{offer_id}/counter',
  reverb_list_refund_requests: 'GET /my/refund_requests/selling',
  reverb_respond_to_refund_request: 'PUT /my/refund_requests/selling/{refund_request_id}',
  reverb_create_refund_request: 'POST /my/orders/selling/{order_number}/refund_requests',
  reverb_list_payouts: 'GET /my/payouts',
  reverb_list_payout_line_items: 'GET /my/payouts/{payout_id}/line_items',
  reverb_get_shop: 'GET /shop',
  reverb_list_categories: 'GET /categories/flat',
  reverb_list_listing_conditions: 'GET /listing_conditions',
};
const SWITCHED_OFF = [
  'reverb_end_listing',
  'reverb_accept_offer',
  'reverb_counter_offer',
  'reverb_respond_to_refund_request',
  'reverb_create_refund_request',
];

describe('reverb adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the personal access token as Bearer with the HAL headers and Accept-Version 3.0', async () => {
    expect(a.slug).toBe('reverb');
    expect(a.name).toBe('Reverb');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('reverb');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{REVERB_TOKEN}}' });
    expect(a.connector.headers).toEqual({ Accept: HAL, 'Content-Type': HAL, 'Accept-Version': '3.0', 'User-Agent': 'AnythingMCP' });
    expect(a.requiredEnvVars).toEqual(['REVERB_TOKEN']);
    expect(a.envVarMeta.REVERB_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.REVERB_TOKEN.link).toBe('https://www.reverb-api.com/docs/authentication');
    const pattern = new RegExp(a.envVarMeta.REVERB_TOKEN.pattern!);
    expect(pattern.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', 'short', `Bearer ${FAKE_TOKEN}`]) expect(pattern.test(bad)).toBe(false);

    ok();
    await call('reverb_list_my_listings', { sku: 'SKU-1', state: 'all' });
    expect(sent().url).toBe(`${BASE}/my/listings`);
    expect(method()).toBe('GET');
    expect(header(sent(), 'Authorization')).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(header(sent(), 'Accept')).toBe(HAL);
    expect(header(sent(), 'Content-Type')).toBe(HAL);
    expect(header(sent(), 'Accept-Version')).toBe('3.0');
    expect(header(sent(), 'User-Agent')).toBe('AnythingMCP');
    expect(sent().params).toEqual({ sku: 'SKU-1', state: 'all' });
  });

  it('probes the own listings and explains 401, 403, 404, 406, 412 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'reverb_list_my_listings', params: { per_page: 1 } });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).enabled).not.toBe(false);
    for (const key of ['401', '403', '404', '406', '412', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('has no keyless tool: every call needs the token of the seller', () => {
    expect(a.requiredEnvVars).toContain('REVERB_TOKEN');
    expect(a.optionalEnvVars ?? []).toEqual([]);
    for (const entry of a.tools) {
      // The public marketplace search (GET /listings with a query) belongs to another adapter.
      expect(`${entry.endpointMapping.method} ${entry.endpointMapping.path}`).not.toBe('GET /listings');
      expect(entry.endpointMapping.path).not.toMatch(/^\/(listings\/all|priceguide|autosuggest)/);
    }
  });

  it('maps every tool to the documented method and path', () => {
    const actual = Object.fromEntries(a.tools.map((t) => [t.name, `${t.endpointMapping.method} ${t.endpointMapping.path}`]));
    expect(actual).toEqual(ROUTES);
    expect(a.tools).toHaveLength(29);
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^reverb_[a-z0-9_]+$/);
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

  it('marks reads read-only and installs ending a listing, accepting or countering offers and refunds switched off', () => {
    for (const entry of a.tools) {
      const read = entry.endpointMapping.method === 'GET';
      expect(`${entry.name}:${annotationsOf(entry).readOnlyHint}`).toBe(`${entry.name}:${read}`);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual([...SWITCHED_OFF].sort());
    for (const entry of a.tools) {
      const { method: verb, path } = entry.endpointMapping;
      if (verb !== 'GET' && /refund_requests|\/state\/end|\/accept$|\/counter$/.test(path)) expect(entry.enabled).toBe(false);
      expect(verb).not.toBe('DELETE');
      // Payouts and payments are read only; no bump, sale or direct-offer spending.
      if (path.startsWith('/my/payouts')) expect(verb).toBe('GET');
      expect(path).not.toMatch(/bump|auto_offer|\/sales|vacation|shipping_label/);
    }
    // Declining an offer commits to nothing and stays on.
    expect(tool('reverb_decline_offer').enabled).not.toBe(false);
    // A seller-initiated refund is created conditionally approved, never approved in one step.
    expect(tool('reverb_create_refund_request').endpointMapping.bodyMapping!.state).toBe('conditionally_approved');
    // Creating a listing makes a draft: the publish flag is only sent by the publish tool.
    expect(JSON.stringify(tool('reverb_create_listing').endpointMapping.bodyMapping)).not.toContain('publish');
    expect(JSON.stringify(tool('reverb_update_listing').endpointMapping.bodyMapping)).not.toContain('"publish"');
  });

  it('names every tool and the setup facts in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions.startsWith('## Reverb\n')).toBe(true);
    expect(a.instructions.length).toBeGreaterThanOrEqual(1500);
    for (const fact of ['My Profile', 'API & Integrations', 'Generate New Token', 'read_listings', 'write_listings', 'read_orders', 'write_orders', 'read_messages', 'read_offers', 'read_payouts', 'do not expire', '_links.next', '412', '2,000 per minute', 'sandbox.reverb.com']) {
      expect(a.instructions).toContain(fact);
    }
  });

  it('reads listings, orders, conversations, offers, refunds, payouts and reference data on the documented paths', async () => {
    ok();
    await call('reverb_list_my_drafts', {});
    expect(sent().url).toBe(`${BASE}/my/listings/drafts`);
    expect(sent().params).toEqual({});

    ok();
    await call('reverb_get_listing', { listing_id: '39100123' });
    expect(sent().url).toBe(`${BASE}/listings/39100123`);

    ok();
    await call('reverb_list_orders', { updated_start_date: '2026-11-01T00:00:00-00:00', updated_end_date: '2026-11-02T00:00:00-00:00', page: 2, per_page: 50 });
    expect(sent().url).toBe(`${BASE}/my/orders/selling/all`);
    expect(sent().params).toEqual({ updated_start_date: '2026-11-01T00:00:00-00:00', updated_end_date: '2026-11-02T00:00:00-00:00', page: 2, per_page: 50 });

    ok();
    await call('reverb_list_orders_awaiting_shipment', {});
    expect(sent().url).toBe(`${BASE}/my/orders/selling/awaiting_shipment`);

    ok();
    await call('reverb_get_order', { order_number: '16448967' });
    expect(sent().url).toBe(`${BASE}/my/orders/selling/16448967`);

    ok();
    await call('reverb_list_shipping_providers', {});
    expect(sent().url).toBe(`${BASE}/shipping/providers`);

    ok();
    await call('reverb_list_conversations', { unread_only: true });
    expect(sent().url).toBe(`${BASE}/my/conversations`);
    expect(sent().params).toEqual({ unread_only: true });

    ok();
    await call('reverb_get_conversation', { conversation_id: '8812' });
    expect(sent().url).toBe(`${BASE}/my/conversations/8812`);

    ok();
    await call('reverb_list_offers', {});
    expect(sent().url).toBe(`${BASE}/my/listings/negotiations`);

    ok();
    await call('reverb_get_offer', { offer_id: '7001' });
    expect(sent().url).toBe(`${BASE}/my/negotiations/7001`);

    ok();
    await call('reverb_list_refund_requests', { state: 'approved', order_number: '123' });
    expect(sent().url).toBe(`${BASE}/my/refund_requests/selling`);
    expect(sent().params).toEqual({ state: 'approved', order_number: '123' });

    ok();
    await call('reverb_list_payouts', { created_start_date: '2026-10-15T12:00-00:00', created_end_date: '2026-10-30T12:00-00:00', per_page: 5 });
    expect(sent().url).toBe(`${BASE}/my/payouts`);
    expect(sent().params).toEqual({ created_start_date: '2026-10-15T12:00-00:00', created_end_date: '2026-10-30T12:00-00:00', per_page: 5 });

    ok();
    await call('reverb_list_payout_line_items', { payout_id: '54', per_page: 5 });
    expect(sent().url).toBe(`${BASE}/my/payouts/54/line_items`);
    expect(sent().params).toEqual({ per_page: 5 });

    ok();
    await call('reverb_get_shop', {});
    expect(sent().url).toBe(`${BASE}/shop`);

    ok();
    await call('reverb_list_categories', {});
    expect(sent().url).toBe(`${BASE}/categories/flat`);

    ok();
    await call('reverb_list_listing_conditions', {});
    expect(sent().url).toBe(`${BASE}/listing_conditions`);
  });

  it('creates a draft, updates only the given fields and publishes with the publish flag', async () => {
    const listing = {
      title: 'my favorite fender stratocaster',
      make: 'Fender',
      model: 'Stratocaster',
      description: 'Awesome guitar',
      finish: 'Sunburst',
      year: '1960s',
      sku: '12345',
      categories: [{ uuid: 'dfd39027-d134-4353-b9e4-57dc6be791b9' }],
      condition: { uuid: 'df268ad1-c462-4ba6-b6db-e007e23922ea' },
      photos: ['https://example.com/strat-1.jpg'],
      price: { amount: '5000.00', currency: 'USD' },
      has_inventory: false,
      offers_enabled: true,
      shipping_profile_id: '456',
    };
    ok(201);
    await call('reverb_create_listing', listing);
    expect(method()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/listings`);
    expect(sent().data).toEqual(listing);
    expect(header(sent(), 'Content-Type')).toBe(HAL);

    ok();
    await call('reverb_update_listing', { listing_id: '39100123', inventory: 3, price: { amount: '4500.00', currency: 'USD' } });
    expect(method()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/listings/39100123`);
    expect(sent().data).toEqual({ inventory: 3, price: { amount: '4500.00', currency: 'USD' } });

    ok();
    await call('reverb_publish_listing', { listing_id: '39100123' });
    expect(method()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/listings/39100123`);
    expect(sent().data).toEqual({ publish: 'true' });
  });

  it('marks an order shipped with provider and tracking, and answers a conversation', async () => {
    ok();
    await call('reverb_ship_order', { order_number: '16448967', provider: 'USPS', tracking_number: '12345678' });
    expect(method()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/my/orders/selling/16448967/ship`);
    expect(sent().data).toEqual({ provider: 'USPS', tracking_number: '12345678', send_notification: true });

    ok();
    await call('reverb_ship_order', { order_number: '16448967', provider: 'UPS', tracking_number: '1Z999', send_notification: false });
    expect(sent().data).toEqual({ provider: 'UPS', tracking_number: '1Z999', send_notification: false });

    ok();
    await call('reverb_mark_order_picked_up', { order_number: '16448967' });
    expect(method()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/my/orders/selling/16448967/mark_picked_up`);
    expect(sent().data ?? {}).toEqual({});

    ok();
    await call('reverb_send_message', { conversation_id: '8812', body: 'An example message' });
    expect(method()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/my/conversations/8812/messages`);
    expect(sent().data).toEqual({ body: 'An example message' });

    ok();
    await call('reverb_decline_offer', { offer_id: '7001' });
    expect(method()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/my/negotiations/7001/decline`);
    expect(sent().data ?? {}).toEqual({});
  });

  it('builds the switched-off end, accept, counter and refund requests', async () => {
    ok();
    await call('reverb_end_listing', { listing_id: '39100123', reason: 'not_sold' });
    expect(method()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/my/listings/39100123/state/end`);
    expect(sent().data).toEqual({ reason: 'not_sold' });

    ok();
    await call('reverb_accept_offer', { offer_id: '7001' });
    expect(method()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/my/negotiations/7001/accept`);

    ok();
    await call('reverb_counter_offer', { offer_id: '7001', price: { amount: '50.00', currency: 'USD' }, shipping_price: { amount: '10.00', currency: 'USD' } });
    expect(sent().url).toBe(`${BASE}/my/negotiations/7001/counter`);
    expect(sent().data).toEqual({ price: { amount: '50.00', currency: 'USD' }, shipping_price: { amount: '10.00', currency: 'USD' } });

    ok();
    await call('reverb_counter_offer', { offer_id: '7001', price: { amount: '55.00', currency: 'USD' } });
    expect(sent().data).toEqual({ price: { amount: '55.00', currency: 'USD' } });

    ok();
    await call('reverb_respond_to_refund_request', { refund_request_id: '47', state: 'conditionally_approved', note_to_buyer: 'hello' });
    expect(method()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/my/refund_requests/selling/47`);
    expect(sent().data).toEqual({ state: 'conditionally_approved', note_to_buyer: 'hello' });

    ok();
    await call('reverb_create_refund_request', { order_number: '290', reason: 'sold_elsewhere', refund_amount: { amount: '10.00', currency: 'USD' } });
    expect(method()).toBe('POST');
    expect(sent().url).toBe(`${BASE}/my/orders/selling/290/refund_requests`);
    expect(sent().data).toEqual({ state: 'conditionally_approved', reason: 'sold_elsewhere', refund_amount: { amount: '10.00', currency: 'USD' } });
  });
});

// Opt-in: RUN_REVERB_LIVE=1. The index and refusal checks need no account;
// the reads need REVERB_TOKEN. Nothing is written.
const live = process.env.RUN_REVERB_LIVE === '1';
const liveFetch = mockedAxios.__actual;
const liveHeaders = { Accept: HAL, 'Content-Type': HAL, 'Accept-Version': '3.0', 'User-Agent': 'AnythingMCP' };
(live ? describe : describe.skip)('Reverb: live', () => {
  it('finds the paths of the seller tools in the public API index', async () => {
    const index = await liveFetch.get(BASE, { headers: liveHeaders, validateStatus: () => true });
    expect(index.status).toBe(200);
    const links = index.data._links;
    expect(links.my.listings.href).toBe(`${BASE}/my/listings`);
    expect(links.my.drafts.href).toBe(`${BASE}/my/listings/drafts`);
    expect(links.my.conversations.href).toBe(`${BASE}/my/conversations`);
    expect(links.my.negotiations.selling.href).toBe(`${BASE}/my/listings/negotiations`);
    expect(links.my.orders.selling.all.href).toBe(`${BASE}/my/orders/selling/all`);
    expect(links.my.orders.selling.awaiting_shipment.href).toBe(`${BASE}/my/orders/selling/awaiting_shipment`);
    expect(links.shop.href).toBe(`${BASE}/shop`);
    expect(links.categories_flat.href).toBe(`${BASE}/categories/flat`);
    expect(links.shipping.providers.href).toBe(`${BASE}/shipping/providers`);
  });

  it('refuses a wrong token on a seller call', async () => {
    const response = await liveFetch.get(`${BASE}/my/listings`, {
      headers: { ...liveHeaders, Authorization: 'Bearer not-a-real-token' },
      params: { per_page: 1 },
      validateStatus: () => true,
    });
    expect([401, 403]).toContain(response.status);
  });

  it('reads one own listing and the shop', async () => {
    const token = process.env.REVERB_TOKEN;
    if (!token) throw new Error('Set REVERB_TOKEN for the live check');
    const headers = { ...liveHeaders, Authorization: `Bearer ${token}` };
    const listings = await liveFetch.get(`${BASE}/my/listings`, { headers, params: { per_page: 1, state: 'all' }, validateStatus: () => true });
    expect(listings.status).toBe(200);
    expect(Array.isArray(listings.data.listings)).toBe(true);
    const shop = await liveFetch.get(`${BASE}/shop`, { headers, validateStatus: () => true });
    expect(shop.status).toBe(200);
  });
});
