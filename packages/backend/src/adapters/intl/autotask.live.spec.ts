import * as adapter from './autotask.json';
type Tool = {
  name: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: unknown;
    bodyTemplate?: string;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, boolean>;
};
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string> };
  probe: { tool: string; params?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const refs = (v: unknown, out: Set<string>) => {
  if (typeof v === 'string') {
    if (/^\$\w+$/.test(v)) out.add(v.slice(1));
    for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
  } else if (v && typeof v === 'object') for (const x of Object.values(v)) refs(x, out);
};

describe('autotask adapter: static spec conformance', () => {
  it('targets the zone host and sends the three Autotask headers', () => {
    expect(a.connector.baseUrl).toBe('https://{{AUTOTASK_ZONE_HOST}}/ATServicesRest/V1.0');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('ApiIntegrationCode');
    expect(a.connector.authConfig.apiKey).toBe('{{AUTOTASK_INTEGRATION_CODE}}');
    expect(a.connector.authConfig.extraHeaders).toEqual({ UserName: '{{AUTOTASK_USERNAME}}', Secret: '{{AUTOTASK_SECRET}}' });
  });

  it('every POST query is marked read-only and sends filter, maxRecords and includeFields', () => {
    const queries = a.tools.filter((t) => /\/query(\/count)?$/.test(t.endpointMapping.path));
    expect(queries.length).toBeGreaterThanOrEqual(10);
    for (const t of queries) {
      expect(t.endpointMapping.method).toBe('POST');
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect((t.endpointMapping.bodyMapping as Record<string, string>).filter).toBe('$filter');
    }
    expect(tool('autotask_query_tickets').endpointMapping.bodyMapping).toEqual({ filter: '$filter', maxRecords: '$max_records', includeFields: '$include_fields' });
  });

  it('the filter defaults to a condition that matches every record', () => {
    const f = tool('autotask_query_companies').parameters?.properties?.filter as { default: unknown };
    expect(f.default).toEqual([{ op: 'gte', field: 'id', value: 0 }]);
  });

  it('ticket update is a PATCH on the collection carrying the id; notes go under the ticket', () => {
    expect(tool('autotask_update_ticket').endpointMapping).toMatchObject({ method: 'PATCH', path: '/Tickets', bodyMapping: { id: '$id' } });
    expect(tool('autotask_create_ticket_note').endpointMapping.path).toBe('/Tickets/{ticket_id}/Notes');
  });

  it('offers no delete tool', () => {
    for (const t of a.tools) expect(t.endpointMapping.method).not.toBe('DELETE');
  });

  (a.probe ? it : it.skip)('probe is a read-only tool whose required parameters are given', () => {
    const p = tool(a.probe.tool);
    expect(p.endpointMapping.method === 'GET' || p.annotations?.readOnlyHint === true).toBe(true);
    for (const r of p.parameters?.required ?? []) expect(a.probe.params?.[r]).toBeDefined();
  });

  it('every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = new Set<string>();
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      refs(m.queryParams, used);
      refs(m.bodyMapping, used);
      refs(m.headers, used);
      if (m.bodyTemplate) refs(m.bodyTemplate, used);
      for (const p of Object.keys(t.parameters?.properties ?? {})) expect(`${t.name}:${p}:${used.has(p)}`).toBe(`${t.name}:${p}:true`);
    }
  });

  it('tool names carry the adapter prefix and are unique', () => {
    const names = a.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n.startsWith('autotask_')).toBe(true);
  });
});
