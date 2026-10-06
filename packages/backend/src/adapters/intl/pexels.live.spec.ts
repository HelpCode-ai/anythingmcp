import * as adapter from './pexels.json';
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

describe('pexels adapter: static spec conformance', () => {
  it('sends the raw key in Authorization, without Bearer', () => {
    expect(a.connector.baseUrl).toBe('https://api.pexels.com/v1');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: '{{PEXELS_API_KEY}}' });
  });

  it('uses the documented photo, video and collection paths', () => {
    expect(tool('pexels_search_photos').endpointMapping.path).toBe('/search');
    expect(tool('pexels_search_videos').endpointMapping.path).toBe('/videos/search');
    expect(tool('pexels_get_video').endpointMapping.path).toBe('/videos/videos/{id}');
    expect(tool('pexels_get_collection_media').endpointMapping.path).toBe('/collections/{id}');
  });

  it('is read-only', () => {
    for (const t of a.tools) expect(t.endpointMapping.method).toBe('GET');
  });

  it('probe is a read-only tool whose required parameters are given', () => {
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
    for (const n of names) expect(n.startsWith('pexels_')).toBe(true);
  });
});
