import * as adapter from './freepik.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  probe: { tool: string; params: Record<string, unknown> };
  tools: Array<{
    name: string;
    parameters?: { properties?: Record<string, unknown> };
    endpointMapping: {
      method: string;
      path: string;
      queryParams?: Record<string, string>;
      bodyMapping?: Record<string, string>;
      headers?: Record<string, string>;
    };
    annotations?: Record<string, boolean>;
  }>;
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

describe('freepik adapter: static spec conformance', () => {
  it('uses the API host and key header of the current documentation', () => {
    expect(a.connector.baseUrl).toBe('https://api.magnific.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'x-magnific-api-key', apiKey: '{{FREEPIK_API_KEY}}' });
  });

  it('probes with a search, which costs no download', () => {
    expect(a.probe.tool).toBe('freepik_search_resources');
    expect(a.probe.params.term).toBeTruthy();
  });

  it('every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = new Set<string>();
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      const values = { ...(m.queryParams ?? {}), ...(m.bodyMapping ?? {}), ...(m.headers ?? {}) };
      for (const v of Object.values(values)) used.add(String(v).replace(/^\$/, ''));
      for (const p of Object.keys(t.parameters?.properties ?? {})) expect(`${t.name}:${used.has(p)}`).toBe(`${t.name}:true`);
    }
  });

  it('sends search filters as deepObject query keys', () => {
    const q = tool('freepik_search_resources').endpointMapping.queryParams ?? {};
    expect(q['filters[content_type][photo]']).toBe('$photo');
    expect(q['filters[license][freemium]']).toBe('$freemium');
  });

  it('downloads and generation are not marked read-only, because they spend downloads or credits', () => {
    for (const n of ['freepik_download_resource', 'freepik_download_resource_format', 'freepik_download_icon']) {
      expect(tool(n).annotations?.readOnlyHint).toBe(false);
    }
    expect(tool('freepik_generate_image_mystic').endpointMapping.method).toBe('POST');
  });
});
