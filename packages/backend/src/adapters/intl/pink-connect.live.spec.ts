import * as adapter from './pink-connect.json';

/**
 * Veepee Pink Connect API v4 (api.pink-connect.com/v4, Bearer token). The reference
 * sits behind the Pink Connect login; paths and filters were checked read-only
 * against a seller account on 19 Oct 2026: limit (max 100) and offset page, per-page
 * and page are ignored, orders come oldest first and filter by updateDateGTE/LTE
 * and shopChannelId, offers need shopChannelId.
 * Live part: PINK_CONNECT_TOKEN=... RUN_PINK_CONNECT_LIVE=1 npx jest src/adapters/intl/pink-connect
 */

type Tool = {
  name: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; bodyEncoding?: string };
  annotations?: { readOnlyHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string' && v.startsWith('$')) out.add(v.slice(1));
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  return out;
};
const PREFIX = 'pink_connect_';
const WRITES: string[] = ["pink_connect_reply_notification", "pink_connect_create_order_message", "pink_connect_update_return_request"];
// Tool names of the customers' own connectors for this API on the Cloud (read 19 Oct 2026).
const HAND_BUILT = ["pinkconnect_create_order_message", "pinkconnect_get_notification", "pinkconnect_get_order", "pinkconnect_list_notifications", "pinkconnect_list_orders", "pinkconnect_list_return_requests", "pinkconnect_reply_notification", "pinkconnect_update_return_request"];

describe('pink-connect adapter: static spec conformance', () => {
  it('sends a Bearer token to api.pink-connect.com/v4', () => {
    expect(a.requiredEnvVars).toEqual(['PINK_CONNECT_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://api.pink-connect.com/v4');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{PINK_CONNECT_TOKEN}}' });
  });

  it('pages with limit and offset (Pink Connect ignores per-page and page) and caps limit at 100', () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.queryParams?.limit)) {
      expect(t.endpointMapping.queryParams?.offset).toBe('$offset');
      expect(t.endpointMapping.queryParams).not.toHaveProperty('per-page');
      expect(t.endpointMapping.queryParams).not.toHaveProperty('page');
      expect((t.parameters?.properties?.limit as { maximum: number }).maximum).toBe(100);
    }
  });

  it('filters orders by update date, shop channel and marketplace order code', () => {
    expect(tool('pink_connect_list_orders').endpointMapping.queryParams).toEqual({
      updateDateGTE: '$updated_from',
      updateDateLTE: '$updated_to',
      shopChannelId: '$shop_channel_id',
      marketplaceCode: '$marketplace_code',
      marketplaceOrderCode: '$marketplace_order_code',
      limit: '$limit',
      offset: '$offset',
    });
    expect(tool('pink_connect_list_offers').parameters?.required).toEqual(['shop_channel_id']);
  });

  it('writes use the paths of the working hand-built connector', () => {
    expect(tool('pink_connect_reply_notification').endpointMapping).toMatchObject({ method: 'POST', path: '/notifications/{notification_id}', bodyEncoding: 'form-data' });
    expect(tool('pink_connect_create_order_message').endpointMapping).toMatchObject({ method: 'POST', path: '/orders/{order_id}/notifications', bodyEncoding: 'form-data' });
    expect(tool('pink_connect_update_return_request').endpointMapping).toMatchObject({ method: 'PUT', path: '/return-requests/{return_request_id}/{new_status}' });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('writes are installed switched off and annotated; reads are not switched off', () => {
    const writes = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(writes).toEqual([...WRITES].sort());
    for (const t of a.tools) {
      if (WRITES.includes(t.name)) expect(t.annotations?.readOnlyHint).toBe(false);
      else {
        expect(t.enabled).toBeUndefined();
        if (t.endpointMapping.method !== 'GET') expect(t.annotations?.readOnlyHint).toBe(true);
      }
    }
  });

  it('never reuses the tool names of hand-built Cloud connectors for the same API', () => {
    const names = new Set(a.tools.map((t) => t.name));
    for (const n of HAND_BUILT) expect(`${n}:${names.has(n)}`).toBe(`${n}:false`);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(WRITES).not.toContain(a.probe.tool);
    tool(a.probe.tool);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).not.toMatch(/—/);
  });
});

const live = process.env.RUN_PINK_CONNECT_LIVE === '1' && process.env.PINK_CONNECT_TOKEN ? describe : describe.skip;
live('pink-connect adapter: live (read-only)', () => {
  const headers = { Authorization: `Bearer ${process.env.PINK_CONNECT_TOKEN}`, Accept: 'application/json' };
  it('reads carriers and honours limit on orders', async () => {
    const carriers = (await (await fetch(`${a.connector.baseUrl}/carriers`, { headers })).json()) as unknown[];
    expect(carriers.length).toBeGreaterThan(10);
    const orders = (await (await fetch(`${a.connector.baseUrl}/orders?limit=2`, { headers })).json()) as unknown[];
    expect(orders.length).toBeLessThanOrEqual(2);
  }, 90_000);
});
