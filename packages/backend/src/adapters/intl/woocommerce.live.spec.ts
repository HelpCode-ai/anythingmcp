import * as adapter from './woocommerce.json';
import { additiveQueryParams } from '../../connectors/catalog-resync.service';

type Tool = {
  name: string;
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string>; timeoutMs?: number };
};
const a = adapter as unknown as {
  probe: { tool: string; params: Record<string, unknown> };
  verifyHints: Record<string, string>;
  envVarMeta: Record<string, { help: string }>;
  connector: { baseUrl: string; type: string };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;

/**
 * WooCommerce REST API v3. Static: always runs. Live: RUN_WOOCOMMERCE_LIVE=1
 * with WOOCOMMERCE_URL, WOOCOMMERCE_CONSUMER_KEY, WOOCOMMERCE_CONSUMER_SECRET
 * (read-only calls).
 */
describe('woocommerce adapter: static spec conformance', () => {
  it('calls /wp-json/wc/v3 on the shop address', () => {
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{WOOCOMMERCE_URL}}/wp-json/wc/v3');
  });

  it('probes with one order id: proves order access with a tiny answer', () => {
    expect(a.probe).toEqual({ tool: 'woocommerce_list_orders', params: { per_page: 1, _fields: 'id' } });
  });

  it('list tools take optional _fields and bounded pages, with no default that would change existing calls', () => {
    for (const name of ['woocommerce_list_orders', 'woocommerce_search_products']) {
      const t = tool(name);
      expect(t.endpointMapping.queryParams?._fields).toBe('$_fields');
      expect(t.parameters.properties?._fields?.default).toBeUndefined();
      expect(t.parameters.properties?.per_page).toMatchObject({ minimum: 1, maximum: 100 });
    }
  });

  it('list_orders can ask only for orders changed since the last run', () => {
    const t = tool('woocommerce_list_orders');
    for (const p of ['modified_after', 'modified_before', 'dates_are_gmt']) {
      expect(t.endpointMapping.queryParams?.[p]).toBe(`$${p}`);
      expect(t.parameters.properties?.[p]).toBeDefined();
      expect(t.parameters.properties?.[p].default).toBeUndefined();
      expect(t.parameters.required ?? []).not.toContain(p);
    }
  });

  it('the new list_orders parameters reach installed connectors as a safe update', () => {
    // An installed list_orders from before #1619: no _fields, no modified_*.
    const t = tool('woocommerce_list_orders');
    const old = { ...t.endpointMapping, queryParams: { ...t.endpointMapping.queryParams } };
    for (const p of ['_fields', 'modified_after', 'modified_before', 'dates_are_gmt']) delete old.queryParams[p];
    expect(additiveQueryParams(t, { endpointMapping: old })?.sort()).toEqual(
      ['_fields', 'dates_are_gmt', 'modified_after', 'modified_before'],
    );
  });

  it('gives slow product writes 90 s', () => {
    for (const name of ['woocommerce_create_product', 'woocommerce_update_product', 'woocommerce_batch_update_products']) {
      expect(`${name}:${tool(name).endpointMapping.timeoutMs}`).toBe(`${name}:90000`);
    }
  });

  it('explains firewall, address and server errors at setup', () => {
    for (const key of ['401', '403', '404', 'unreachable', 'upstream_error']) {
      expect(a.verifyHints[key]).toBeTruthy();
    }
    expect(a.verifyHints['403']).toContain('104.248.242.235');
    expect(a.envVarMeta.WOOCOMMERCE_CONSUMER_KEY.help).toMatch(/Read is enough/);
  });
});

const live =
  process.env.RUN_WOOCOMMERCE_LIVE === '1' &&
  process.env.WOOCOMMERCE_URL &&
  process.env.WOOCOMMERCE_CONSUMER_KEY &&
  process.env.WOOCOMMERCE_CONSUMER_SECRET;
(live ? describe : describe.skip)('woocommerce: live read-only smoke test', () => {
  const base = `${(process.env.WOOCOMMERCE_URL || '').replace(/\/+$/, '')}/wp-json/wc/v3`;
  const auth = `consumer_key=${process.env.WOOCOMMERCE_CONSUMER_KEY}&consumer_secret=${process.env.WOOCOMMERCE_CONSUMER_SECRET}`;

  it('returns only the requested order fields and filters by modification date', async () => {
    const res = await fetch(`${base}/orders?per_page=2&_fields=id,status&modified_after=2020-01-01T00:00:00&${auth}`);
    expect(res.status).toBe(200);
    const orders = (await res.json()) as Array<Record<string, unknown>>;
    for (const o of orders) expect(Object.keys(o).sort()).toEqual(['id', 'status']);
  });
});
