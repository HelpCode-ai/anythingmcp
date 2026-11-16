import * as adapter from './qoo10.json';
/**
 * Qoo10 Japan QAPI adapter.
 *
 * Static checks always run: the GiosisCertificationKey header, the POST to
 * ebayjapan.qapi/<Class>.<Method> with a form body and the method's
 * QAPIVersion header, the errorWhen rules for negative ResultCode and
 * ErrorCode answers (HTTP 200 in every case), every tool's method name against
 * https://api.qoo10.jp/GMKT.INC.Front.QAPIService/Document/QAPIGuideIndex.aspx,
 * and the switched-off cancellation and item status change.
 *
 * Live checks run only with RUN_QOO10_LIVE=1 and QOO10_SELLER_AUTH_KEY set:
 * they read the shipping groups. Reads only.
 *
 *   RUN_QOO10_LIVE=1 QOO10_SELLER_AUTH_KEY=... npx jest src/adapters/jp/qoo10.live.spec.ts
 */
type Mapping = {
  method: string;
  path: string;
  queryParams?: Record<string, unknown>;
  bodyMapping?: unknown;
  headers?: Record<string, string>;
  bodyEncoding?: string;
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
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string; label?: string; help?: string; options?: Array<{ value: string; label: string }> }>;
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
    for (const m of value.matchAll(/\$\{(\w+)\}/g)) out.add(m[1]);
  } else if (Array.isArray(value)) {
    value.forEach((item) => refs(item, out));
  } else if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => refs(item, out));
  }
  return out;
};
const outsideBackticks = (text: string): string => text.replace(/`[^`]*`/g, '');

const ROUTES: Record<string, [string, string]> = {
  "qoo10_list_shipping_orders": [
    "POST",
    "/ShippingBasic.GetShippingInfo_v3"
  ],
  "qoo10_get_order": [
    "POST",
    "/ShippingBasic.GetShippingAndClaimInfoByOrderNo_V2"
  ],
  "qoo10_list_claims": [
    "POST",
    "/ShippingBasic.GetClaimInfo_V3"
  ],
  "qoo10_confirm_order": [
    "POST",
    "/ShippingBasic.SetSellerCheckYN_V2"
  ],
  "qoo10_set_shipping_info": [
    "POST",
    "/ShippingBasic.SetSendingInfo"
  ],
  "qoo10_list_inquiries": [
    "POST",
    "/CSCenter.GetInquiryMessage"
  ],
  "qoo10_get_inquiry": [
    "POST",
    "/CSCenter.GetInquiryMessageByQuestionNo"
  ],
  "qoo10_reply_inquiry": [
    "POST",
    "/CSCenter.SetInquiryMessage"
  ],
  "qoo10_list_items": [
    "POST",
    "/ItemsLookup.GetAllGoodsInfo"
  ],
  "qoo10_get_item": [
    "POST",
    "/ItemsLookup.GetItemDetailInfo"
  ],
  "qoo10_get_item_options": [
    "POST",
    "/ItemsLookup.GetGoodsInventoryInfo"
  ],
  "qoo10_list_shipping_groups": [
    "POST",
    "/ItemsLookup.GetSellerDeliveryGroupInfo"
  ],
  "qoo10_list_categories": [
    "POST",
    "/CommonInfoLookup.GetCatagoryListAll"
  ],
  "qoo10_search_brands": [
    "POST",
    "/CommonInfoLookup.SearchBrand"
  ],
  "qoo10_set_price_qty": [
    "POST",
    "/ItemsOrder.SetGoodsPriceQty"
  ],
  "qoo10_update_option_qty": [
    "POST",
    "/ItemsOptions.UpdateInventoryQtyUnit"
  ],
  "qoo10_set_item_status": [
    "POST",
    "/ItemsBasic.EditGoodsStatus"
  ],
  "qoo10_cancel_order": [
    "POST",
    "/Claim.SetCancelProcess"
  ]
};
const SWITCHED_OFF = [
  "qoo10_cancel_order",
  "qoo10_set_item_status"
];
const REQUIRED: Record<string, string[]> = {
  "qoo10_list_shipping_orders": [],
  "qoo10_get_order": [
    "order_no"
  ],
  "qoo10_list_claims": [
    "search_end_date",
    "search_start_date"
  ],
  "qoo10_confirm_order": [
    "order_no"
  ],
  "qoo10_set_shipping_info": [
    "order_no",
    "shipping_corp",
    "tracking_no"
  ],
  "qoo10_list_inquiries": [
    "search_end_date",
    "search_start_date"
  ],
  "qoo10_get_inquiry": [
    "inquiry_type",
    "question_no"
  ],
  "qoo10_reply_inquiry": [
    "contents",
    "inquiry_type",
    "question_no",
    "seq_no"
  ],
  "qoo10_list_items": [
    "item_status"
  ],
  "qoo10_get_item": [],
  "qoo10_get_item_options": [],
  "qoo10_list_shipping_groups": [],
  "qoo10_list_categories": [],
  "qoo10_search_brands": [
    "keyword"
  ],
  "qoo10_set_price_qty": [],
  "qoo10_update_option_qty": [
    "option_code",
    "option_name",
    "option_value",
    "qty"
  ],
  "qoo10_set_item_status": [
    "status"
  ],
  "qoo10_cancel_order": [
    "order_no"
  ]
};
const PROBE = {
  "tool": "qoo10_list_shipping_groups",
  "params": {}
};

describe('qoo10 adapter: static contract', () => {
  it('sends the Seller Authorization Key as a header and posts form bodies to the method path', () => {
    expect(a.slug).toBe('qoo10');
    expect(a.region).toBe('jp');
    expect(a.connector.baseUrl).toBe('https://api.qoo10.jp/GMKT.INC.Front.QAPIService/ebayjapan.qapi');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'GiosisCertificationKey', apiKey: '{{QOO10_SELLER_AUTH_KEY}}' });
    expect(a.requiredEnvVars).toEqual(['QOO10_SELLER_AUTH_KEY']);
    expect(a.envVarMeta.QOO10_SELLER_AUTH_KEY.secret).toBe(true);
    // api.qoo10.jp answers a curl user agent with an HTML block page.
    expect(a.connector.headers!['User-Agent']).toBe('AnythingMCP');
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('POST');
      expect(t.endpointMapping.path).toMatch(/^\/[A-Za-z]+\.[A-Za-z0-9_]+$/);
      expect(t.endpointMapping.bodyEncoding).toBe('form-urlencoded');
      expect(t.endpointMapping.headers!.QAPIVersion).toMatch(/^1\.[0-9]$/);
      expect((t.endpointMapping.bodyMapping as Record<string, unknown>).returnType).toBe('application/json');
    }
    expect(tool('qoo10_get_item').endpointMapping.headers!.QAPIVersion).toBe('1.2');
    expect(tool('qoo10_set_price_qty').endpointMapping.headers!.QAPIVersion).toBe('1.1');
  });

  it('turns negative ResultCode and ErrorCode answers into failed calls', () => {
    const rules = a.connector.config!.errorWhen as Array<Record<string, unknown>>;
    expect(rules[0]).toMatchObject({ path: 'ResultCode', status: 401 });
    expect(rules[0].in).toContain(-10000);
    expect(rules[1]).toMatchObject({ path: 'ErrorCode', status: 401 });
    expect(rules[2]).toMatchObject({ path: 'ResultCode', matches: '^-', status: 400 });
    expect(new RegExp(rules[2].matches as string).test(String(-10001))).toBe(true);
    expect(new RegExp(rules[2].matches as string).test(String(0))).toBe(false);
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

  it('marks reads as read-only and never marks a write read-only', () => {
    for (const t of a.tools) {
      if (t.endpointMapping.method === 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
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
        if (d.pattern) expect(() => new RegExp(d.pattern!)).not.toThrow();
      }
    }
    expect(outsideBackticks(a.instructions)).not.toMatch(/[{}<]/);
    expect(outsideBackticks(a.description)).not.toMatch(/[{}<]/);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });

  it('describes every variable and probes with a cheap read', () => {
    for (const v of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) {
      expect(a.envVarMeta[v]).toMatchObject({ label: expect.any(String), kind: expect.any(String), help: expect.any(String) });
      if (a.envVarMeta[v].pattern) expect(() => new RegExp(a.envVarMeta[v].pattern!)).not.toThrow();
    }
    expect(a.probe).toEqual(PROBE);
    expect(tool(a.probe.tool).enabled).not.toBe(false);
    expect(tool(a.probe.tool).annotations?.readOnlyHint).toBe(true);
    for (const status of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[status]).toBeDefined();
  });
});

const live = process.env.RUN_QOO10_LIVE === '1' ? describe : describe.skip;
live('qoo10 adapter: live reads', () => {
  it('reads the shipping groups with the key', async () => {
    const res = await fetch('https://api.qoo10.jp/GMKT.INC.Front.QAPIService/ebayjapan.qapi/ItemsLookup.GetSellerDeliveryGroupInfo', {
      method: 'POST',
      headers: {
        GiosisCertificationKey: process.env.QOO10_SELLER_AUTH_KEY ?? '',
        QAPIVersion: '1.0',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'AnythingMCP',
      },
      body: 'returnType=application/json',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ResultCode?: number };
    expect(body.ResultCode).toBe(0);
  });
});

