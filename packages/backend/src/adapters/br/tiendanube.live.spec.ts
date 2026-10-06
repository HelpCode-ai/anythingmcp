import * as adapter from './tiendanube.json';
const a = adapter as unknown as {
  requiredEnvVars: string[];
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  probe: { tool: string };
  tools: Array<{
    name: string;
    parameters?: { properties?: Record<string, unknown> };
    endpointMapping: { method: string; path: string; queryParams?: Record<string, string>; bodyMapping?: Record<string, string> };
    annotations?: Record<string, boolean>;
  }>;
};

describe('tiendanube adapter: static spec conformance', () => {
  it('targets the dated API version with the store id in the path', () => {
    expect(a.connector.baseUrl).toBe('https://api.tiendanube.com/2025-03/{{TIENDANUBE_STORE_ID}}');
    expect(a.requiredEnvVars).toEqual(['TIENDANUBE_STORE_ID', 'TIENDANUBE_ACCESS_TOKEN']);
  });

  it('sends the token as a bearer token', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{TIENDANUBE_ACCESS_TOKEN}}');
  });

  it('identifies itself with a User-Agent that carries a contact, or the API answers 400', () => {
    expect(a.connector.headers['User-Agent']).toMatch(/\(.+@.+\)/);
  });

  it('probes with the store endpoint', () => {
    expect(a.probe.tool).toBe('tiendanube_get_store');
    expect(a.tools.find((t) => t.name === 'tiendanube_get_store')?.endpointMapping.path).toBe('/store');
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

  it('never sends published and visibility together (the API answers 422)', () => {
    for (const t of a.tools) {
      const body = Object.keys(t.endpointMapping.bodyMapping ?? {});
      expect(body.includes('published') && body.includes('visibility')).toBe(false);
    }
  });
});
