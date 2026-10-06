import * as adapter from './bing-webmaster.json';
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

describe('bing-webmaster adapter: static spec conformance', () => {
  it('uses the JSON endpoint with the key as the apikey query parameter', () => {
    expect(a.connector.baseUrl).toBe('https://ssl.bing.com/webmaster/api.svc/json');
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ apikey: '{{BING_WEBMASTER_API_KEY}}' });
  });

  it('site tools send siteUrl and method names are PascalCase', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.path).toMatch(/^\/(Get|Submit)[A-Z]\w+$/);
      if (t.parameters?.properties?.site_url && t.endpointMapping.method === 'GET') {
        expect(t.endpointMapping.queryParams?.siteUrl).toBe('$site_url');
      }
    }
  });

  it('submissions are POSTs with the documented body names', () => {
    expect(tool('bing_webmaster_submit_url').endpointMapping).toMatchObject({ method: 'POST', bodyMapping: { siteUrl: '$site_url', url: '$url' } });
    expect(tool('bing_webmaster_submit_url_batch').endpointMapping).toMatchObject({ method: 'POST', bodyMapping: { siteUrl: '$site_url', urlList: '$url_list' } });
    expect(tool('bing_webmaster_submit_sitemap').endpointMapping).toMatchObject({ method: 'POST', bodyMapping: { siteUrl: '$site_url', feedUrl: '$feed_url' } });
    expect(tool('bing_webmaster_submit_url').annotations?.destructiveHint).toBe(true);
  });

  it('every read is a GET and nothing removes anything', () => {
    for (const t of a.tools) {
      if (!t.name.includes('_submit_')) expect(t.endpointMapping.method).toBe('GET');
      expect(t.endpointMapping.path).not.toMatch(/Remove|Delete/);
    }
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
    for (const n of names) expect(n.startsWith('bing_webmaster_')).toBe(true);
  });
});
