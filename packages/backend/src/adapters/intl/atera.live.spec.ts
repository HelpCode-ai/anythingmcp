import * as adapter from './atera.json';
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

describe('atera adapter: static spec conformance', () => {
  it('uses API v3 with the X-API-KEY header and asks for JSON', () => {
    expect(a.connector.baseUrl).toBe('https://app.atera.com/api/v3');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-API-KEY', apiKey: '{{ATERA_API_KEY}}' });
    expect(a.connector.headers?.Accept).toBe('application/json');
  });

  it('pages with the documented page and itemsInPage names', () => {
    expect(tool('atera_list_tickets').endpointMapping.queryParams).toMatchObject({ page: '$page', itemsInPage: '$items_in_page' });
    expect(tool('atera_list_contacts').endpointMapping.queryParams).toMatchObject({ 'searchOptions.email': '$email' });
  });

  it('device tools build the typed device paths', () => {
    expect(tool('atera_list_devices').endpointMapping.path).toBe('/devices/{device_type}devices');
    expect(tool('atera_get_device').endpointMapping.path).toBe('/devices/{device_type}device/{device_id}');
  });

  it('comments nest the author details the API expects', () => {
    expect(tool('atera_add_technician_comment').endpointMapping.bodyMapping).toMatchObject({ TechnicianCommentDetails: { IsInternal: '$is_internal' } });
    expect(tool('atera_add_enduser_comment').endpointMapping.bodyMapping).toMatchObject({ EnduserCommentDetails: { EnduserId: '$enduser_id' } });
    expect(tool('atera_add_technician_comment').annotations?.destructiveHint).toBe(true);
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
    for (const n of names) expect(n.startsWith('atera_')).toBe(true);
  });
});
