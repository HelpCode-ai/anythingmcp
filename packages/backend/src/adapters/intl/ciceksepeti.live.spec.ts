import * as adapter from './ciceksepeti.json';
/**
 * Çiçeksepeti seller API adapter.
 *
 * Static checks always run: the x-api-key header, the Seller ID as User-Agent,
 * the environment choice, every route against Çiçeksepeti's published
 * documentation (https://ciceksepeti.dev), the item-list bodies, the read-only
 * POST searches, and that the return evaluation (refund or exchange) installs
 * switched off. No tool buys labels or moves money.
 *
 * Live checks run only with RUN_CICEKSEPETI_LIVE=1, CICEKSEPETI_API_KEY and
 * CICEKSEPETI_SELLER_ID set: they read the category tree. Reads only.
 *
 *   RUN_CICEKSEPETI_LIVE=1 CICEKSEPETI_API_KEY=... CICEKSEPETI_SELLER_ID=... \
 *     npx jest src/adapters/intl/ciceksepeti.live.spec.ts
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
  ciceksepeti_list_orders: ["POST", "/Order/GetOrders"],
  ciceksepeti_ready_for_cargo: ["PUT", "/Order/readyforcargowithcsintegration"],
  ciceksepeti_update_order_status: ["PUT", "/Order/statusupdatewithsupplierintegration"],
  ciceksepeti_change_cargo_company: ["PUT", "/Order/CargoCompany"],
  ciceksepeti_send_cargo_measurement: ["POST", "/Order/CargoMeasurement"],
  ciceksepeti_mark_digital_delivered: ["PUT", "/Order/digital-order-status-update"],
  ciceksepeti_update_labor_cost: ["PUT", "/Order/UpdateLaborCost"],
  ciceksepeti_send_invoice: ["POST", "/Branch/SendInvoiceMail"],
  ciceksepeti_list_products: ["GET", "/Products"],
  ciceksepeti_create_products: ["POST", "/Products"],
  ciceksepeti_update_products: ["PUT", "/Products"],
  ciceksepeti_update_price_and_stock: ["PUT", "/Products/price-and-stock"],
  ciceksepeti_get_batch_status: ["GET", "/Products/batch-status/{batch_id}"],
  ciceksepeti_list_categories: ["GET", "/Categories"],
  ciceksepeti_get_category_attributes: ["GET", "/Categories/{category_id}/attributes"],
  ciceksepeti_list_questions: ["GET", "/sellerquestions"],
  ciceksepeti_list_question_actions: ["GET", "/sellerquestions/actions"],
  ciceksepeti_answer_question: ["PUT", "/sellerquestions/{question_id}"],
  ciceksepeti_list_chats: ["GET", "/chats"],
  ciceksepeti_send_chat_message: ["POST", "/chats/{chat_id}/messages"],
  ciceksepeti_list_returns: ["POST", "/Order/getcanceledorders"],
  ciceksepeti_mark_return_received: ["POST", "/Order/refundprocessstartreceivedprocess"],
  ciceksepeti_evaluate_return: ["POST", "/Order/cancelevaluation"],
};
const SWITCHED_OFF = [
  "ciceksepeti_evaluate_return"
];
const REQUIRED: Record<string, string[]> = {
  ciceksepeti_list_orders: [],
  ciceksepeti_ready_for_cargo: ["order_item_ids"],
  ciceksepeti_update_order_status: ["order_items"],
  ciceksepeti_change_cargo_company: ["cargo_id", "order_item_id"],
  ciceksepeti_send_cargo_measurement: ["desi", "order_item_id", "quantity"],
  ciceksepeti_mark_digital_delivered: ["order_item_id"],
  ciceksepeti_update_labor_cost: ["labor_cost", "order_item_id"],
  ciceksepeti_send_invoice: ["document_url", "order_item_id"],
  ciceksepeti_list_products: [],
  ciceksepeti_create_products: ["products"],
  ciceksepeti_update_products: ["products"],
  ciceksepeti_update_price_and_stock: ["items"],
  ciceksepeti_get_batch_status: ["batch_id"],
  ciceksepeti_list_categories: [],
  ciceksepeti_get_category_attributes: ["category_id"],
  ciceksepeti_list_questions: [],
  ciceksepeti_list_question_actions: [],
  ciceksepeti_answer_question: ["branch_action_id", "question_id"],
  ciceksepeti_list_chats: ["page"],
  ciceksepeti_send_chat_message: ["chat_id", "message"],
  ciceksepeti_list_returns: [],
  ciceksepeti_mark_return_received: ["order_item_ids"],
  ciceksepeti_evaluate_return: ["order_item_id", "process"],
};
const PROBE = {"tool": "ciceksepeti_list_categories", "params": {}};
const PROBE_METHOD = "GET";

describe('ciceksepeti adapter: static contract', () => {
  it('sends the API key in x-api-key and the Seller ID as User-Agent to the chosen environment', () => {
    expect(a.slug).toBe('ciceksepeti');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.connector.baseUrl).toBe('{{CICEKSEPETI_API_URL}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'x-api-key', apiKey: '{{CICEKSEPETI_API_KEY}}' });
    expect(a.connector.headers?.['User-Agent']).toBe('{{CICEKSEPETI_SELLER_ID}}');
    expect(a.envVarMeta.CICEKSEPETI_API_URL.options?.map((o) => o.value)).toEqual([
      'https://apis.ciceksepeti.com/api/v1',
      'https://sandbox-apis.ciceksepeti.com/api/v1',
    ]);
    expect(a.envVarMeta.CICEKSEPETI_API_KEY.secret).toBe(true);
    expect(new RegExp(a.envVarMeta.CICEKSEPETI_SELLER_ID.pattern!).test('123456')).toBe(true);
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

  it('marks the POST order and return searches read-only and keeps the return evaluation switched off', () => {
    for (const name of ['ciceksepeti_list_orders', 'ciceksepeti_list_returns']) {
      expect(tool(name).endpointMapping.method).toBe('POST');
      expect(tool(name).annotations).toEqual({ readOnlyHint: true });
    }
    expect(tool('ciceksepeti_evaluate_return').enabled).toBe(false);
    expect(tool('ciceksepeti_ready_for_cargo').endpointMapping.bodyMapping).toEqual({ orderItemsGroup: [{ orderItemIds: '$order_item_ids' }] });
    expect(tool('ciceksepeti_send_invoice').endpointMapping.bodyMapping).toEqual({ items: [{ orderItemId: '$order_item_id', documentUrl: '$document_url' }] });
  });
});

const live = process.env.RUN_CICEKSEPETI_LIVE === '1' ? describe : describe.skip;
live('ciceksepeti adapter: live reads', () => {
  it('reads the category tree', async () => {
    const res = await fetch('https://apis.ciceksepeti.com/api/v1/Categories', {
      headers: { 'x-api-key': String(process.env.CICEKSEPETI_API_KEY), 'User-Agent': String(process.env.CICEKSEPETI_SELLER_ID), Accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { categories?: unknown }).categories).toBeDefined();
  });
});
