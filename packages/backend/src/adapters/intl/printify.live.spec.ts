import * as adapter from './printify.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  probe: { tool: string };
  tools: Array<{
    name: string;
    parameters?: { properties?: Record<string, unknown>; required?: string[] };
    endpointMapping: { method: string; path: string; queryParams?: Record<string, string>; bodyMapping?: Record<string, string> };
    annotations?: Record<string, boolean>;
  }>;
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

describe('printify adapter: static spec conformance', () => {
  it('uses the v1 API with a bearer token and a User-Agent', () => {
    expect(a.connector.baseUrl).toBe('https://api.printify.com/v1');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{PRINTIFY_API_TOKEN}}');
    expect(a.connector.headers['User-Agent']).toBeTruthy();
  });

  it('probes with the shop list, which needs no parameters', () => {
    expect(a.probe.tool).toBe('printify_list_shops');
    expect(tool('printify_list_shops').endpointMapping).toEqual({ method: 'GET', path: '/shops.json' });
  });

  it('every path ends in .json, as the API requires', () => {
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/\.json$/);
  });

  it('every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = new Set<string>();
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      for (const v of Object.values({ ...(m.queryParams ?? {}), ...(m.bodyMapping ?? {}) })) used.add(String(v).replace(/^\$/, ''));
      for (const p of Object.keys(t.parameters?.properties ?? {})) expect(`${t.name}:${used.has(p)}`).toBe(`${t.name}:true`);
    }
  });

  it('variant filter uses the documented hyphenated query name', () => {
    expect(tool('printify_list_variants').endpointMapping.queryParams).toEqual({ 'show-out-of-stock': '$show_out_of_stock' });
  });

  it('shipping calculation is a read; production, cancel, publish and delete are destructive', () => {
    expect(tool('printify_calculate_shipping').annotations).toEqual({ readOnlyHint: true });
    for (const n of ['printify_send_order_to_production', 'printify_cancel_order', 'printify_publish_product', 'printify_delete_product']) {
      expect(tool(n).annotations?.destructiveHint).toBe(true);
    }
  });
});
