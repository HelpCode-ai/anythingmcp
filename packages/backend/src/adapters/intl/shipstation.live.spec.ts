import * as adapter from './shipstation.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  probe: { tool: string };
  tools: Array<{
    name: string;
    enabled?: boolean;
    parameters?: { properties?: Record<string, unknown>; required?: string[] };
    endpointMapping: { method: string; path: string; queryParams?: Record<string, string>; bodyMapping?: unknown };
    annotations?: Record<string, boolean>;
  }>;
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const refs = (v: unknown, out: Set<string>) => {
  if (typeof v === 'string' && v.startsWith('$')) out.add(v.slice(1));
  else if (v && typeof v === 'object') for (const x of Object.values(v)) refs(x, out);
};

describe('shipstation adapter: static spec conformance', () => {
  it('uses API v2 with the API-Key header, not the legacy V1 host', () => {
    expect(a.connector.baseUrl).toBe('https://api.shipstation.com/v2');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('API-Key');
    expect(a.connector.authConfig.apiKey).toBe('{{SHIPSTATION_API_KEY}}');
  });

  it('probes with the carrier list', () => {
    expect(a.probe.tool).toBe('shipstation_list_carriers');
    expect(tool('shipstation_list_carriers').endpointMapping.path).toBe('/carriers');
  });

  it('every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = new Set<string>();
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      refs(m.queryParams, used);
      refs(m.bodyMapping, used);
      for (const p of Object.keys(t.parameters?.properties ?? {})) expect(`${t.name}:${used.has(p)}`).toBe(`${t.name}:true`);
    }
  });

  it('label purchase and void are installed off and marked destructive', () => {
    for (const n of ['shipstation_create_label_from_shipment', 'shipstation_create_label_from_rate', 'shipstation_void_label']) {
      expect(tool(n).enabled).toBe(false);
      expect(tool(n).annotations?.destructiveHint).toBe(true);
    }
  });

  it('rate quotes and address validation are POST reads', () => {
    for (const n of ['shipstation_calculate_rates', 'shipstation_estimate_rates', 'shipstation_validate_address']) {
      expect(tool(n).endpointMapping.method).toBe('POST');
      expect(tool(n).annotations).toEqual({ readOnlyHint: true });
    }
  });

  it('address validation sends a JSON array, as the API requires', () => {
    expect(Array.isArray(tool('shipstation_validate_address').endpointMapping.bodyMapping)).toBe(true);
  });
});
