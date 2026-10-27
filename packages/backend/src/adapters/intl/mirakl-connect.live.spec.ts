import * as adapter from './mirakl-connect.json';
import { serializeRepeatedParams } from '../../connectors/engines/rest.engine';

/**
 * Mirakl Connect APIs (developer.mirakl.com/content/product/connect, OpenAPI bundle
 * openapi3.yaml): base https://miraklconnect.com/api, OAuth2 client credentials at the
 * Mirakl Authentication System (https://auth.mirakl.net/oauth/token, form-encoded),
 * Bearer token on every call, seek pagination with page_token / next_page_token.
 * Live part (reads only: orders, products):
 *   MIRAKL_CONNECT_CLIENT_ID=... MIRAKL_CONNECT_CLIENT_SECRET=... RUN_MIRAKL_CONNECT_LIVE=1 npx jest src/adapters/intl/mirakl-connect
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { type?: string; items?: { enum?: unknown[] } }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
const PREFIX = 'mirakl_connect_';
const WRITES = ['mirakl_connect_accept_order_lines', 'mirakl_connect_cancel_order_lines', 'mirakl_connect_ship_order'];

describe('mirakl-connect adapter: static spec conformance', () => {
  it('gets a bearer token with client credentials from the Mirakl Authentication System', () => {
    expect(a.requiredEnvVars).toEqual(['MIRAKL_CONNECT_CLIENT_ID', 'MIRAKL_CONNECT_CLIENT_SECRET']);
    expect(a.connector.baseUrl).toBe('https://miraklconnect.com/api');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{MIRAKL_CONNECT_CLIENT_ID}}',
      clientSecret: '{{MIRAKL_CONNECT_CLIENT_SECRET}}',
      tokenUrl: 'https://auth.mirakl.net/oauth/token',
      tokenAuthMethod: 'client_secret_post',
    });
    expect(a.envVarMeta?.MIRAKL_CONNECT_CLIENT_SECRET.secret).toBe(true);
    expect(a.category).toBe('e-commerce');
  });

  it('is told apart from the single-marketplace Mirakl Seller API', () => {
    expect(a.slug).toBe('mirakl-connect');
    expect(a.instructions).toMatch(/Mirakl Seller API/);
    expect(new URL(a.connector.baseUrl).hostname).toBe('miraklconnect.com');
  });

  it('maps the v2 order routes with the documented filters', () => {
    expect(tool('mirakl_connect_list_orders').endpointMapping).toEqual({
      method: 'GET',
      path: '/v2/orders',
      queryParams: { statuses: '$statuses', updated_from: '$updated_from', fulfillment_type: '$fulfillment_type', order_ids: '$order_ids', limit: '$limit', page_token: '$page_token' },
    });
    expect(tool('mirakl_connect_list_orders').parameters?.properties?.statuses.items?.enum).toEqual(['AWAITING_FRAUD_CHECK', 'AWAITING_ACCEPTANCE', 'AWAITING_PAYMENT', 'AWAITING_SHIPMENT', 'SHIPPED', 'DELIVERED', 'CLOSED']);
    // statuses is an exploded form array: repeated keys, as the OpenAPI description says.
    expect(serializeRepeatedParams({ statuses: ['SHIPPED', 'DELIVERED'], limit: 10 })).toBe('statuses=SHIPPED&statuses=DELIVERED&limit=10');
    expect(tool('mirakl_connect_get_order').endpointMapping).toEqual({ method: 'GET', path: '/v2/orders', queryParams: { order_ids: '$order_id' } });
    expect(tool('mirakl_connect_list_returns').endpointMapping.path).toBe('/v2/orders/returns');
    expect(tool('mirakl_connect_list_returns').parameters?.required).toEqual(['updated_from']);
    expect(tool('mirakl_connect_list_order_documents').endpointMapping.path).toBe('/v2/orders/documents');
    expect(tool('mirakl_connect_get_action_status').endpointMapping).toEqual({ method: 'GET', path: '/v2/orders/actions/{action_id}' });
    expect(tool('mirakl_connect_list_products').endpointMapping).toEqual({ method: 'GET', path: '/products', queryParams: { limit: '$limit', page_token: '$page_token' } });
    expect(tool('mirakl_connect_list_conversations').endpointMapping.path).toBe('/conversations');
    expect(tool('mirakl_connect_get_conversation').endpointMapping).toEqual({ method: 'GET', path: '/conversations/{conversation_id}', queryParams: { message_after: '$message_after' } });
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/^\/orders/); // deprecated v1 routes
  });

  it('maps shipping, cancelling and accepting to the v2 routes, switched off', () => {
    expect(tool('mirakl_connect_ship_order').endpointMapping).toEqual({
      method: 'POST',
      path: '/v2/orders/{order_id}/shipments',
      bodyMapping: { items: '$items', carrier: '$carrier', tracking_number: '$tracking_number', tracking_url: '$tracking_url', return_tracking_number: '$return_tracking_number', warehouse_id: '$warehouse_id' },
    });
    expect(tool('mirakl_connect_cancel_order_lines').endpointMapping).toEqual({ method: 'POST', path: '/v2/orders/{order_id}/cancel', bodyMapping: { cancelations: '$cancelations' } });
    expect(tool('mirakl_connect_accept_order_lines').endpointMapping).toEqual({ method: 'PUT', path: '/v2/orders/{order_id}/accept', bodyMapping: { order_lines: '$order_lines' } });
    expect(tool('mirakl_connect_ship_order').annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(tool('mirakl_connect_cancel_order_lines').annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(tool('mirakl_connect_accept_order_lines').annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('writes are annotated and installed switched off; reads are GET', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...WRITES].sort());
    for (const t of a.tools) {
      if (WRITES.includes(t.name)) continue;
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
    }
    for (const n of WRITES) expect(tool(n).annotations?.readOnlyHint).toBe(false);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).annotations?.readOnlyHint === false).toBe(false);
    expect(a.probe.params).toEqual({ limit: 1 });
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live =
  process.env.RUN_MIRAKL_CONNECT_LIVE === '1' && process.env.MIRAKL_CONNECT_CLIENT_ID && process.env.MIRAKL_CONNECT_CLIENT_SECRET ? describe : describe.skip;
live('mirakl-connect adapter: live (read-only)', () => {
  it('gets a token and reads orders and products', async () => {
    const tokenRes = await fetch('https://auth.mirakl.net/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.MIRAKL_CONNECT_CLIENT_ID as string,
        client_secret: process.env.MIRAKL_CONNECT_CLIENT_SECRET as string,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const headers = { Authorization: `Bearer ${access_token}`, Accept: 'application/json' };
    const orders = (await (await fetch(`${a.connector.baseUrl}/v2/orders?limit=2`, { headers })).json()) as { data: unknown[] };
    expect(Array.isArray(orders.data)).toBe(true);
    const products = (await (await fetch(`${a.connector.baseUrl}/products?limit=2`, { headers })).json()) as { data: unknown[] };
    expect(Array.isArray(products.data)).toBe(true);
  }, 60_000);
});
