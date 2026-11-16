import * as adapter from './magalu.json';
/**
 * Magalu Marketplace seller API (API Magalu) adapter.
 *
 * Static checks always run: the ID Magalu authorization-code sign-in (store
 * choice via choose_tenants, the seller scopes), every route against the
 * operations of Magalu's published reference (https://developers.magalu.com/docs/),
 * the absolute services.magalu.com paths of questions and chat, the X-Tenant-Id
 * header, the constant BRL currency and normalizer of the price bodies, and which
 * tools install switched off (labels, ticket creation, reverse shipments, ticket
 * events). No tool authorises a refund or moves money.
 *
 * Live checks run only with RUN_MAGALU_LIVE=1 and MAGALU_ACCESS_TOKEN (a token
 * from a finished sign-in) set: they read the seller. Reads only.
 *
 *   RUN_MAGALU_LIVE=1 MAGALU_ACCESS_TOKEN=... npx jest src/adapters/br/magalu.live.spec.ts
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
  magalu_get_seller: ["GET", "/seller/v1/portfolios/me"],
  magalu_list_warehouses: ["GET", "/seller/v1/portfolios/me/warehouses"],
  magalu_list_orders: ["GET", "/seller/v1/orders"],
  magalu_get_order: ["GET", "/seller/v1/orders/{code}"],
  magalu_list_deliveries: ["GET", "/seller/v1/deliveries"],
  magalu_get_delivery: ["GET", "/seller/v1/deliveries/{delivery_id}"],
  magalu_list_delivery_history: ["GET", "/seller/v1/deliveries/{delivery_id}/histories"],
  magalu_list_delivery_invoices: ["GET", "/seller/v1/deliveries/{delivery_id}/invoices"],
  magalu_list_skus: ["GET", "/seller/v1/portfolios/skus"],
  magalu_get_sku: ["GET", "/seller/v1/portfolios/skus/{sku}"],
  magalu_get_sku_validation_info: ["GET", "/seller/v1/portfolios/skus/{sku}/validation-info"],
  magalu_get_price: ["GET", "/seller/v1/portfolios/prices/{sku}"],
  magalu_get_stock: ["GET", "/seller/v1/portfolios/stocks/{sku}"],
  magalu_list_traces: ["GET", "/v0/traces"],
  magalu_get_trace: ["GET", "/v0/traces/{trace_id}"],
  magalu_find_categories: ["GET", "/seller/v1/portfolios/categories"],
  magalu_list_category_hierarchy: ["GET", "/seller/v1/portfolios/categories/hierarchy"],
  magalu_list_category_attributes: ["GET", "/seller/v1/portfolios/categories/{category_id}/attributes"],
  magalu_list_category_datasheet: ["GET", "/seller/v1/portfolios/categories/{category_id}/datasheet"],
  magalu_list_questions: ["GET", "https://services.magalu.com/v0/questions"],
  magalu_get_question: ["GET", "https://services.magalu.com/v0/questions/{question_id}"],
  magalu_list_conversations: ["GET", "https://services.magalu.com/v0/conversations"],
  magalu_get_conversation: ["GET", "https://services.magalu.com/v0/conversations/{conversation_id}"],
  magalu_list_conversation_messages: ["GET", "https://services.magalu.com/v0/conversations/{conversation_id}/messages"],
  magalu_list_tickets: ["GET", "/seller/v0/tickets"],
  magalu_get_ticket: ["GET", "/seller/v0/tickets/{ticket_id}"],
  magalu_list_ticket_messages: ["GET", "/seller/v0/tickets/{ticket_id}/messages"],
  magalu_list_ticket_events: ["GET", "/seller/v0/tickets/{ticket_id}/events"],
  magalu_list_ticket_returns: ["GET", "/seller/v0/tickets/{ticket_id}/returns"],
  magalu_list_transactions: ["GET", "/seller/v0/transactions"],
  magalu_get_transaction: ["GET", "/seller/v0/transactions/{transaction_id}"],
  magalu_add_delivery_invoice: ["POST", "/seller/v1/deliveries/{delivery_id}/invoices"],
  magalu_replace_delivery_invoice: ["PUT", "/seller/v1/deliveries/{delivery_id}/invoices/{key}"],
  magalu_ship_delivery: ["POST", "/seller/v1/deliveries/{delivery_id}/shippings"],
  magalu_mark_delivery_delivered: ["POST", "/seller/v1/deliveries/{delivery_id}/finishing"],
  magalu_create_sku: ["POST", "/seller/v1/portfolios/skus"],
  magalu_update_sku: ["PATCH", "/seller/v1/portfolios/skus/{sku}"],
  magalu_set_price: ["POST", "/seller/v1/portfolios/prices/{sku}"],
  magalu_update_price: ["PATCH", "/seller/v1/portfolios/prices/{sku}"],
  magalu_set_stock: ["POST", "/seller/v1/portfolios/stocks/{sku}"],
  magalu_update_stock: ["PATCH", "/seller/v1/portfolios/stocks/{sku}"],
  magalu_answer_question: ["POST", "https://services.magalu.com/v0/questions/{question_id}/answer"],
  magalu_send_conversation_message: ["POST", "https://services.magalu.com/v0/conversations/{conversation_id}/messages"],
  magalu_mark_conversation_read: ["PATCH", "https://services.magalu.com/v0/conversations/{conversation_id}/read_by"],
  magalu_send_ticket_message: ["POST", "/seller/v0/tickets/{ticket_id}/messages"],
  magalu_create_ticket_event: ["POST", "/seller/v0/tickets/{ticket_id}/events"],
  magalu_create_ticket: ["POST", "/seller/v0/tickets"],
  magalu_create_ticket_return: ["POST", "/seller/v0/tickets/{ticket_id}/returns"],
  magalu_generate_shipping_labels: ["POST", "/seller/v1/logistics/shipping-labels"],
};
const SWITCHED_OFF = [
  "magalu_create_ticket",
  "magalu_create_ticket_event",
  "magalu_create_ticket_return",
  "magalu_generate_shipping_labels"
];
const REQUIRED: Record<string, string[]> = {
  magalu_get_seller: [],
  magalu_list_warehouses: [],
  magalu_list_orders: [],
  magalu_get_order: ["code"],
  magalu_list_deliveries: [],
  magalu_get_delivery: ["delivery_id"],
  magalu_list_delivery_history: ["delivery_id"],
  magalu_list_delivery_invoices: ["delivery_id"],
  magalu_list_skus: [],
  magalu_get_sku: ["sku"],
  magalu_get_sku_validation_info: ["sku", "tenant_id"],
  magalu_get_price: ["sku"],
  magalu_get_stock: ["sku"],
  magalu_list_traces: [],
  magalu_get_trace: ["trace_id"],
  magalu_find_categories: [],
  magalu_list_category_hierarchy: [],
  magalu_list_category_attributes: ["category_id"],
  magalu_list_category_datasheet: ["category_id"],
  magalu_list_questions: [],
  magalu_get_question: ["question_id"],
  magalu_list_conversations: [],
  magalu_get_conversation: ["conversation_id"],
  magalu_list_conversation_messages: ["conversation_id"],
  magalu_list_tickets: [],
  magalu_get_ticket: ["ticket_id"],
  magalu_list_ticket_messages: ["ticket_id"],
  magalu_list_ticket_events: ["ticket_id"],
  magalu_list_ticket_returns: ["ticket_id"],
  magalu_list_transactions: ["created_from", "created_to"],
  magalu_get_transaction: ["transaction_id"],
  magalu_add_delivery_invoice: ["amount", "channel_id", "delivery_id", "issued_at", "key", "xml"],
  magalu_replace_delivery_invoice: ["amount", "channel_id", "delivery_id", "issued_at", "key", "xml"],
  magalu_ship_delivery: ["carrier_name", "channel_id", "delivery_id", "estimated_delivery_at", "protocol", "shipped_at", "tracking_url"],
  magalu_mark_delivery_delivered: ["channel_id", "delivered_at", "delivery_id"],
  magalu_create_sku: ["active", "brand", "channel_id", "description", "dimensions", "group", "images", "sku", "title"],
  magalu_update_sku: ["sku"],
  magalu_set_price: ["channel_id", "list_price", "price", "sku"],
  magalu_update_price: ["channel_id", "sku"],
  magalu_set_stock: ["channel_id", "quantity", "sku"],
  magalu_update_stock: ["channel_id", "quantity", "sku"],
  magalu_answer_question: ["message", "owner_id", "owner_name", "question_id"],
  magalu_send_conversation_message: ["content", "conversation_id", "owner_id", "owner_name"],
  magalu_mark_conversation_read: ["conversation_id"],
  magalu_send_ticket_message: ["destination", "message", "owner_code", "owner_name", "ticket_id"],
  magalu_create_ticket_event: ["ticket_id", "type"],
  magalu_create_ticket: ["channel_id", "delivery_id", "items", "order_code", "order_id", "type"],
  magalu_create_ticket_return: ["ticket_id"],
  magalu_generate_shipping_labels: ["channel_id", "deliveries", "format", "type"],
};
const PROBE = {"tool": "magalu_get_seller", "params": {}};
const PROBE_METHOD = "GET";

describe('magalu adapter: static contract', () => {
  it('signs in with ID Magalu, letting the user pick the store', () => {
    expect(a.slug).toBe('magalu');
    expect(a.region).toBe('br');
    expect(a.category).toBe('e-commerce');
    expect(a.connector.baseUrl).toBe('https://api.magalu.com');
    expect(a.connector.authType).toBe('OAUTH2');
    const { scopes, ...rest } = a.connector.authConfig as { scopes: string } & Record<string, unknown>;
    expect(rest).toEqual({
      clientId: '{{MAGALU_CLIENT_ID}}',
      clientSecret: '{{MAGALU_CLIENT_SECRET}}',
      authorizationUrl: 'https://id.magalu.com/login?choose_tenants=true&prompt=consent',
      tokenUrl: 'https://id.magalu.com/oauth/token',
    });
    for (const s of ['open:order-order-seller:read', 'open:order-delivery-seller:write', 'open:portfolio-skus-seller:write', 'open:portfolio-prices-seller:write', 'open:portfolio-stocks-seller:write', 'open:trace:read', 'services:questions-seller:write', 'services:conversations-seller:write', 'open:ticket-messages-seller:write']) {
      expect(scopes.split(' ')).toContain(s);
    }
    expect(a.requiredEnvVars).toEqual(['MAGALU_CLIENT_ID', 'MAGALU_CLIENT_SECRET']);
    expect(a.envVarMeta.MAGALU_CLIENT_SECRET.secret).toBe(true);
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

  it('sends questions and chat to services.magalu.com and everything else to the API host', () => {
    for (const t of a.tools) {
      const p = t.endpointMapping.path;
      const services = /^magalu_(list_questions|get_question|answer_question|list_conversations|get_conversation|list_conversation_messages|send_conversation_message|mark_conversation_read)$/.test(t.name);
      if (services) expect(p.startsWith('https://services.magalu.com/v0/')).toBe(true);
      else expect(p.startsWith('/')).toBe(true);
    }
    expect(tool('magalu_get_sku_validation_info').endpointMapping.headers).toEqual({ 'X-Tenant-Id': '$tenant_id' });
  });

  it('sends BRL with normalizer 100 and never authorises a refund', () => {
    for (const name of ['magalu_set_price', 'magalu_update_price']) {
      expect(tool(name).endpointMapping.bodyMapping).toMatchObject({ currency: 'BRL', normalizer: 100, channel: { id: '$channel_id' } });
    }
    expect(JSON.stringify(a.tools.map((t) => t.parameters))).not.toContain('authorize_refund');
    for (const name of SWITCHED_OFF) expect(tool(name).endpointMapping.method).not.toBe('GET');
    expect(SWITCHED_OFF).toEqual(['magalu_create_ticket', 'magalu_create_ticket_event', 'magalu_create_ticket_return', 'magalu_generate_shipping_labels']);
  });
});

const live = process.env.RUN_MAGALU_LIVE === '1' ? describe : describe.skip;
live('magalu adapter: live reads', () => {
  it('reads the seller behind the token', async () => {
    const res = await fetch('https://api.magalu.com/seller/v1/portfolios/me', {
      headers: { Authorization: `Bearer ${process.env.MAGALU_ACCESS_TOKEN}`, Accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { channel?: unknown }).channel).toBeDefined();
  });
});
