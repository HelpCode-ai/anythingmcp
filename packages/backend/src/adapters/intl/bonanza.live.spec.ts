import * as adapter from './bonanza.json';
/**
 * Bonanza API (Bonapitit) adapter.
 *
 * Static checks always run: the dev id and cert id headers, the user token in
 * requesterCredentials of every secure call, the call name that wraps each JSON
 * body (getOrdersRequest, completeSaleRequest and so on) checked against the
 * reference at https://api.bonanza.com/docs/reference, the ack Failure rules,
 * and that removing items installs switched off. No tool refunds or moves money.
 *
 * Live checks run only with RUN_BONANZA_LIVE=1 and BONANZA_DEV_ID, BONANZA_CERT_ID,
 * BONANZA_USER_TOKEN set: they read the token status and one page of orders. Reads only.
 *
 *   RUN_BONANZA_LIVE=1 BONANZA_DEV_ID=... BONANZA_CERT_ID=... BONANZA_USER_TOKEN=... \
 *     npx jest src/adapters/intl/bonanza.live.spec.ts
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
  bonanza_get_token_status: ["POST", "/api_requests/secure_request"],
  bonanza_get_user: ["POST", "/api_requests/secure_request"],
  bonanza_fetch_token: ["POST", "/api_requests/secure_request"],
  bonanza_list_orders: ["POST", "/api_requests/secure_request"],
  bonanza_get_orders: ["POST", "/api_requests/secure_request"],
  bonanza_mark_order_shipped: ["POST", "/api_requests/secure_request"],
  bonanza_accept_offer: ["POST", "/api_requests/secure_request"],
  bonanza_deny_offer: ["POST", "/api_requests/secure_request"],
  bonanza_leave_feedback: ["POST", "/api_requests/secure_request"],
  bonanza_list_booth_items: ["POST", "/api_requests/secure_request"],
  bonanza_get_item: ["POST", "/api_requests/secure_request"],
  bonanza_add_item: ["POST", "/api_requests/secure_request"],
  bonanza_revise_item: ["POST", "/api_requests/secure_request"],
  bonanza_update_inventory: ["POST", "/api_requests/secure_request"],
  bonanza_end_items: ["POST", "/api_requests/secure_request"],
  bonanza_get_booth: ["POST", "/api_requests/standard_request"],
  bonanza_get_booth_stats: ["POST", "/api_requests/secure_request"],
  bonanza_get_categories: ["POST", "/api_requests/standard_request"],
  bonanza_get_category_traits: ["POST", "/api_requests/standard_request"],
  bonanza_list_message_threads: ["POST", "/api_requests/secure_request"],
  bonanza_get_messages: ["POST", "/api_requests/secure_request"],
  bonanza_send_message: ["POST", "/api_requests/secure_request"],
  bonanza_update_message: ["POST", "/api_requests/secure_request"],
};
const SWITCHED_OFF = [
  "bonanza_end_items"
];
const REQUIRED: Record<string, string[]> = {
  bonanza_get_token_status: [],
  bonanza_get_user: [],
  bonanza_fetch_token: [],
  bonanza_list_orders: [],
  bonanza_get_orders: ["order_ids"],
  bonanza_mark_order_shipped: ["order_id"],
  bonanza_accept_offer: ["order_id"],
  bonanza_deny_offer: ["order_id"],
  bonanza_leave_feedback: ["comment_text", "comment_type", "order_id", "target_user"],
  bonanza_list_booth_items: ["booth_id"],
  bonanza_get_item: ["item_id"],
  bonanza_add_item: ["price", "title"],
  bonanza_revise_item: ["item_id"],
  bonanza_update_inventory: ["updates"],
  bonanza_end_items: ["item_ids"],
  bonanza_get_booth: ["booth_id"],
  bonanza_get_booth_stats: [],
  bonanza_get_categories: [],
  bonanza_get_category_traits: ["category_id"],
  bonanza_list_message_threads: [],
  bonanza_get_messages: ["message_id"],
  bonanza_send_message: ["body"],
  bonanza_update_message: ["message_id"],
};
const PROBE = {"tool": "bonanza_get_token_status", "params": {}};
const PROBE_METHOD = "POST";

describe('bonanza adapter: static contract', () => {
  it('sends the dev id and cert id as headers and the user token inside each secure body', () => {
    expect(a.slug).toBe('bonanza');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.connector.baseUrl).toBe('https://api.bonanza.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-BONANZLE-API-CERT-NAME', apiKey: '{{BONANZA_CERT_ID}}' });
    expect(a.connector.headers?.['X-BONANZLE-API-DEV-NAME']).toBe('{{BONANZA_DEV_ID}}');
    expect(a.requiredEnvVars).toEqual(['BONANZA_DEV_ID', 'BONANZA_CERT_ID', 'BONANZA_USER_TOKEN']);
    expect(a.envVarMeta.BONANZA_CERT_ID.secret).toBe(true);
    expect(a.envVarMeta.BONANZA_USER_TOKEN.secret).toBe(true);
    for (const t of a.tools) {
      const body = t.endpointMapping.bodyMapping as Record<string, Record<string, unknown>>;
      const [call] = Object.keys(body);
      expect(`${t.name}:${/^[a-z][A-Za-z]+Request$/.test(call)}`).toBe(`${t.name}:true`);
      const secure = t.endpointMapping.path === '/api_requests/secure_request';
      if (!secure) expect(t.endpointMapping.path).toBe('/api_requests/standard_request');
      if (secure && call !== 'fetchTokenRequest') {
        expect(`${t.name}:${JSON.stringify(body[call].requesterCredentials)}`).toBe(`${t.name}:{"bonanzleAuthToken":"{{BONANZA_USER_TOKEN}}"}`);
      }
      if (!secure || call === 'fetchTokenRequest') expect(body[call].requesterCredentials).toBeUndefined();
    }
    const rules = a.connector.config?.errorWhen as { path: string; equals: string; status: number }[];
    expect(rules.every((r) => r.path === 'ack' && r.equals === 'Failure')).toBe(true);
    expect(rules[rules.length - 1].status).toBe(400);
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

  it('maps each tool to the documented call', () => {
    const call = (name: string) => Object.keys(tool(name).endpointMapping.bodyMapping as Record<string, unknown>)[0];
    expect(call('bonanza_list_orders')).toBe('getOrdersRequest');
    expect(call('bonanza_mark_order_shipped')).toBe('completeSaleRequest');
    expect(call('bonanza_accept_offer')).toBe('completeSaleRequest');
    expect(call('bonanza_update_inventory')).toBe('updateInventoryRequest');
    expect(call('bonanza_get_item')).toBe('getUnlistedItemRequest');
    expect(call('bonanza_end_items')).toBe('endFixedPriceItemRequest');
    const orders = (tool('bonanza_list_orders').endpointMapping.bodyMapping as Record<string, Record<string, unknown>>).getOrdersRequest;
    expect(orders.orderRole).toBe('seller');
    const ship = (tool('bonanza_mark_order_shipped').endpointMapping.bodyMapping as Record<string, Record<string, unknown>>).completeSaleRequest;
    expect(ship.shipment).toEqual({ shippingTrackingNumber: '$tracking_number', shippingCarrierUsed: '$carrier', notes: '$note_to_buyer', privateNote: '$private_note' });
  });
});

const live = process.env.RUN_BONANZA_LIVE === '1' ? describe : describe.skip;
live('bonanza adapter: live reads', () => {
  it('reads the token status and one page of orders', async () => {
    const headers = {
      'Content-Type': 'application/json',
      'X-BONANZLE-API-DEV-NAME': `${process.env.BONANZA_DEV_ID}`,
      'X-BONANZLE-API-CERT-NAME': `${process.env.BONANZA_CERT_ID}`,
    };
    const requesterCredentials = { bonanzleAuthToken: process.env.BONANZA_USER_TOKEN };
    for (const body of [
      { getTokenStatusRequest: { requesterCredentials } },
      { getOrdersRequest: { requesterCredentials, orderRole: 'seller', paginationInput: { entriesPerPage: 1 } } },
    ]) {
      const res = await fetch('https://api.bonanza.com/api_requests/secure_request', { method: 'POST', headers, body: JSON.stringify(body) });
      expect(((await res.json()) as { ack: string }).ack).not.toBe('Failure');
    }
  });
});
