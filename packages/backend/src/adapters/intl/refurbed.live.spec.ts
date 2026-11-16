import * as adapter from './refurbed.json';
/**
 * refurbed Seller API (formerly Merchant API) adapter.
 *
 * Static checks always run: the `Authorization: Plain <token>` header, every
 * route against refurbed's published Swagger and protos
 * (https://gitlab.com/refurbed-community/public-apis, refb/merchant/v1),
 * that every call is a POST to /refb.merchant.v1.<Service>/<Method>, that
 * reads carry readOnlyHint, that no refund (only the Calculate dry runs) is
 * reachable, the write bodies, and which tools install switched off
 * (reject/cancel, label creation, offer and market price deletes).
 *
 * Live checks run only with RUN_REFURBED_LIVE=1. Without a token they confirm
 * GetCurrency answers 401; with REFURBED_API_TOKEN they list one market and
 * one order. Reads only.
 *
 *   RUN_REFURBED_LIVE=1 REFURBED_API_TOKEN=... npx jest src/adapters/intl/refurbed.live.spec.ts
 */
type Mapping = {
  method: string;
  path: string;
  queryParams?: Record<string, unknown>;
  bodyMapping?: unknown;
  headers?: Record<string, string>;
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; pattern?: string }>; required?: string[] };
  endpointMapping: Mapping;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  description: string;
  selfHostOnly?: boolean;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string; label?: string; help?: string; options?: { value: string; label: string }[] }>;
  verifyHints: Record<string, unknown>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string>; config?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string): Tool => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const pathParams = (path: string): string[] => [...path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)].map((m) => m[1]);
const refs = (value: unknown, out: Set<string> = new Set<string>()): Set<string> => {
  if (typeof value === 'string') {
    if (/^\$\w+$/.test(value)) out.add(value.slice(1));
  } else if (Array.isArray(value)) {
    value.forEach((item) => refs(item, out));
  } else if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => refs(item, out));
  }
  return out;
};
const outsideBackticks = (text: string): string => text.replace(/`[^`]*`/g, '');

const ROUTES: Record<string, [string, string]> = {
  refurbed_list_orders: ["POST", "/refb.merchant.v1.OrderService/ListOrders"],
  refurbed_get_order: ["POST", "/refb.merchant.v1.OrderService/GetOrder"],
  refurbed_list_order_items: ["POST", "/refb.merchant.v1.OrderItemService/ListOrderItemsByOrder"],
  refurbed_get_order_item: ["POST", "/refb.merchant.v1.OrderItemService/GetOrderItem"],
  refurbed_accept_order_item: ["POST", "/refb.merchant.v1.OrderItemService/UpdateOrderItemState"],
  refurbed_ship_order_item: ["POST", "/refb.merchant.v1.OrderItemService/UpdateOrderItemState"],
  refurbed_update_order_item: ["POST", "/refb.merchant.v1.OrderItemService/UpdateOrderItem"],
  refurbed_batch_update_order_item_states: ["POST", "/refb.merchant.v1.OrderItemService/BatchUpdateOrderItemsState"],
  refurbed_reject_order_item: ["POST", "/refb.merchant.v1.OrderItemService/UpdateOrderItemState"],
  refurbed_calculate_item_refund: ["POST", "/refb.merchant.v1.OrderItemService/CalculateRefundOrderItem"],
  refurbed_calculate_order_refund: ["POST", "/refb.merchant.v1.OrderService/CalculateRefundOrder"],
  refurbed_list_shipping_labels: ["POST", "/refb.merchant.v1.OrderService/ListShippingLabels"],
  refurbed_create_shipping_label: ["POST", "/refb.merchant.v1.OrderService/CreateShippingLabel"],
  refurbed_get_order_invoice: ["POST", "/refb.merchant.v1.OrderService/GetOrderInvoice"],
  refurbed_list_returns: ["POST", "/refb.merchant.v1.OrderItemReturnService/ListOrderItemReturns"],
  refurbed_list_tickets: ["POST", "/refb.merchant.v1.TicketService/ListTickets"],
  refurbed_get_ticket: ["POST", "/refb.merchant.v1.TicketService/GetTicket"],
  refurbed_list_offers: ["POST", "/refb.merchant.v1.OfferService/ListOffers"],
  refurbed_get_offer: ["POST", "/refb.merchant.v1.OfferService/GetOffer"],
  refurbed_create_offer: ["POST", "/refb.merchant.v1.OfferService/CreateOffer"],
  refurbed_update_offer: ["POST", "/refb.merchant.v1.OfferService/UpdateOffer"],
  refurbed_batch_update_offers: ["POST", "/refb.merchant.v1.OfferService/BatchUpdateOffers"],
  refurbed_delete_offer: ["POST", "/refb.merchant.v1.OfferService/DeleteOffer"],
  refurbed_list_market_offers: ["POST", "/refb.merchant.v1.MarketOfferService/ListMarketOffersByOffer"],
  refurbed_create_market_offer: ["POST", "/refb.merchant.v1.MarketOfferService/CreateMarketOffer"],
  refurbed_update_market_offer: ["POST", "/refb.merchant.v1.MarketOfferService/UpdateMarketOffer"],
  refurbed_delete_market_offer: ["POST", "/refb.merchant.v1.MarketOfferService/DeleteMarketOffer"],
  refurbed_get_instance: ["POST", "/refb.merchant.v1.InstanceService/GetInstance"],
  refurbed_list_shipping_profiles: ["POST", "/refb.merchant.v1.ShippingProfileService/ListShippingProfiles"],
  refurbed_list_available_carriers: ["POST", "/refb.merchant.v1.ShippingProfileService/ListAvailableCarriers"],
  refurbed_list_markets: ["POST", "/refb.merchant.v1.MarketService/ListMarkets"],
  refurbed_list_merchant_addresses: ["POST", "/refb.merchant.v1.MerchantService/ListMerchantAddresses"],
  refurbed_get_currency: ["POST", "/refb.merchant.v1.CurrencyService/GetCurrency"],
};
const SWITCHED_OFF = [
  "refurbed_create_shipping_label",
  "refurbed_delete_market_offer",
  "refurbed_delete_offer",
  "refurbed_reject_order_item"
];
const REQUIRED: Record<string, string[]> = {
  refurbed_list_orders: [],
  refurbed_get_order: ["order_id"],
  refurbed_list_order_items: ["order_id"],
  refurbed_get_order_item: ["order_item_id"],
  refurbed_accept_order_item: ["order_item_id"],
  refurbed_ship_order_item: ["order_item_id"],
  refurbed_update_order_item: ["order_item_id"],
  refurbed_batch_update_order_item_states: ["updates"],
  refurbed_reject_order_item: ["order_item_id", "state"],
  refurbed_calculate_item_refund: ["currency_code", "order_item_id", "target_paid_amount"],
  refurbed_calculate_order_refund: ["order_id"],
  refurbed_list_shipping_labels: ["order_id"],
  refurbed_create_shipping_label: ["merchant_address_id", "order_id", "parcel_weight"],
  refurbed_get_order_invoice: ["order_id"],
  refurbed_list_returns: [],
  refurbed_list_tickets: [],
  refurbed_get_ticket: ["ticket_id"],
  refurbed_list_offers: [],
  refurbed_get_offer: [],
  refurbed_create_offer: ["grading", "reference_currency_code", "reference_price", "shipping_profile_id", "sku", "stock", "taxation", "warranty"],
  refurbed_update_offer: [],
  refurbed_batch_update_offers: ["offers"],
  refurbed_delete_offer: [],
  refurbed_list_market_offers: [],
  refurbed_create_market_offer: ["currency_code", "market_code", "price"],
  refurbed_update_market_offer: ["market_code"],
  refurbed_delete_market_offer: ["market_code"],
  refurbed_get_instance: [],
  refurbed_list_shipping_profiles: [],
  refurbed_list_available_carriers: [],
  refurbed_list_markets: [],
  refurbed_list_merchant_addresses: [],
  refurbed_get_currency: [],
};
const PROBE = {"tool": "refurbed_list_merchant_addresses", "params": {}};
const PROBE_METHOD = "POST";

describe('refurbed adapter: static contract', () => {
  it('sends the token as Authorization: Plain to api.refurbed.com', () => {
    expect(a.slug).toBe('refurbed');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.connector.baseUrl).toBe('https://api.refurbed.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'Plain {{REFURBED_API_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['REFURBED_API_TOKEN']);
    expect(a.envVarMeta.REFURBED_API_TOKEN.secret).toBe(true);
    const pattern = new RegExp(a.envVarMeta.REFURBED_API_TOKEN.pattern!);
    expect(pattern.test('f4e133d1-6cc4-4792-be5d-80a446a3d0dd')).toBe(true);
    expect(pattern.test('Plain f4e133d1-6cc4-4792-be5d-80a446a3d0dd')).toBe(false);
  });

  it('pins the method and path of every tool', () => {
    const actual: Record<string, [string, string]> = {};
    for (const t of a.tools) actual[t.name] = [t.endpointMapping.method, t.endpointMapping.path];
    expect(actual).toEqual(ROUTES);
  });

  it('installs exactly the risky tools switched off', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...SWITCHED_OFF].sort());
  });

  it('wires every parameter into the request and requires every path parameter', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = refs([m.queryParams ?? {}, m.bodyMapping ?? {}, m.headers ?? {}]);
      for (const p of pathParams(m.path)) used.add(p);
      for (const p of Object.keys(t.parameters.properties ?? {})) expect(`${t.name}:${p}:${used.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of pathParams(m.path)) expect(`${t.name}:${p}:${(t.parameters.required ?? []).includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const r of t.parameters.required ?? []) expect(`${t.name}:${r}:${r in (t.parameters.properties ?? {})}`).toBe(`${t.name}:${r}:true`);
    }
  });

  it('pins the required parameters of every tool', () => {
    const actual: Record<string, string[]> = {};
    for (const t of a.tools) actual[t.name] = [...(t.parameters.required ?? [])].sort();
    expect(actual).toEqual(REQUIRED);
  });

  it('keeps parameter patterns compilable', () => {
    for (const t of a.tools) {
      for (const d of Object.values(t.parameters.properties ?? {})) if (d.pattern) expect(() => new RegExp(d.pattern as string)).not.toThrow();
    }
  });

  it('names every tool in the instructions, prefixes it with the slug and keeps the text MDX-safe', () => {
    const prefix = `${a.slug.replace(/-/g, '_')}_`;
    for (const t of a.tools) {
      expect(t.name.startsWith(prefix)).toBe(true);
      expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
      expect(outsideBackticks(t.description)).not.toMatch(/[{}<]/);
      for (const [p, d] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${Boolean(d.description)}`).toBe(`${t.name}.${p}:true`);
        expect(outsideBackticks(d.description ?? '')).not.toMatch(/[{}<]/);
      }
    }
    expect(outsideBackticks(a.instructions)).not.toMatch(/[{}<]/);
    expect(outsideBackticks(a.description)).not.toMatch(/[{}<]/);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });

  it('describes every variable and probes with a cheap read', () => {
    for (const v of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) {
      expect(a.envVarMeta[v]).toMatchObject({ label: expect.any(String), kind: expect.any(String), help: expect.any(String) });
    }
    expect(a.probe).toEqual(PROBE);
    expect(tool(a.probe.tool).endpointMapping.method).toBe(PROBE_METHOD);
    for (const status of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[status]).toBeDefined();
  });

  it('posts every call to a refb.merchant.v1 method and marks the reads read-only', () => {
    const writes = new Set([
      'refurbed_accept_order_item', 'refurbed_ship_order_item', 'refurbed_update_order_item', 'refurbed_batch_update_order_item_states',
      'refurbed_reject_order_item', 'refurbed_create_shipping_label', 'refurbed_create_offer', 'refurbed_update_offer',
      'refurbed_batch_update_offers', 'refurbed_delete_offer', 'refurbed_create_market_offer', 'refurbed_update_market_offer',
      'refurbed_delete_market_offer',
    ]);
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('POST');
      expect(t.endpointMapping.path).toMatch(/^\/refb\.merchant\.v1\.[A-Za-z]+Service\/[A-Za-z]+$/);
      if (writes.has(t.name)) expect(t.annotations?.readOnlyHint).toBeUndefined();
      else expect(`${t.name}:${JSON.stringify(t.annotations)}`).toBe(`${t.name}:${JSON.stringify({ readOnlyHint: true })}`);
    }
  });

  it('reaches no refund, invoice upload or buyback method and fixes the item states per tool', () => {
    const paths = a.tools.map((t) => t.endpointMapping.path);
    for (const p of paths) {
      expect(p).not.toMatch(/\/Refund|SetOrderInvoiceStream|UploadOrderCommercialInvoice|DeleteOrder|Buyback/);
      if (/Refund/.test(p)) expect(p).toMatch(/\/CalculateRefund/);
    }
    expect(tool('refurbed_accept_order_item').endpointMapping.bodyMapping).toMatchObject({ state: 'ACCEPTED' });
    expect(tool('refurbed_ship_order_item').endpointMapping.bodyMapping).toMatchObject({ state: 'SHIPPED', parcel_carrier_tracking_number: '$parcel_carrier_tracking_number' });
    expect(JSON.stringify(tool('refurbed_batch_update_order_item_states').parameters)).not.toMatch(/REJECTED|CANCELLED/);
    expect(tool('refurbed_get_offer').endpointMapping.bodyMapping).toEqual({ identifier: { sku: '$sku', id: '$offer_id' } });
    expect(tool('refurbed_update_market_offer').endpointMapping.bodyMapping).toMatchObject({ identifier: { offer_id: { sku: '$sku', id: '$offer_id' }, market_code: '$market_code' } });
  });
});

const live = process.env.RUN_REFURBED_LIVE === '1' ? describe : describe.skip;
live('refurbed adapter: live', () => {
  const call = (method: string, body: unknown, token?: string) =>
    fetch(`https://api.refurbed.com/refb.merchant.v1.${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Plain ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  it('refuses a call without a token', async () => {
    const res = await call('CurrencyService/GetCurrency', { code: 'EUR' });
    expect(res.status).toBe(401);
  });

  it('lists one market and one order with a token', async () => {
    const token = process.env.REFURBED_API_TOKEN;
    if (!token) throw new Error('Set REFURBED_API_TOKEN for the live reads');
    expect((await call('MarketService/ListMarkets', { pagination: { limit: 1 } }, token)).status).toBe(200);
    expect((await call('OrderService/ListOrders', { pagination: { limit: 1 } }, token)).status).toBe(200);
  });
});
