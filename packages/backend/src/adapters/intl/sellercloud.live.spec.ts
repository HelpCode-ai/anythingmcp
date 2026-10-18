import * as adapter from './sellercloud.json';
const a = adapter as unknown as {
  unlisted?: boolean;
  aliases: string[];
  requiredEnvVars: string[];
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown>; healthcheckPath: string };
  envVarMeta: Record<string, { pattern?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  tools: Array<{
    name: string;
    enabled?: boolean;
    parameters?: { properties?: Record<string, unknown>; required?: string[] };
    endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
  }>;
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Sellercloud's own example server from its API docs; its Swagger spec is public.
const DOCS_SWAGGER = 'https://tt.api.sellercloud.com/rest/swagger/docs/v1';

describe('sellercloud adapter: static spec conformance', () => {
  it('is listed (verified against the official Swagger spec on 18 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
    expect(a.aliases).toContain('Seller Cloud');
  });

  it('signs in with POST {endpoint}/api/token and sends the access_token as Bearer', () => {
    expect(a.requiredEnvVars).toEqual(['SELLERCLOUD_API_URL', 'SELLERCLOUD_USERNAME', 'SELLERCLOUD_PASSWORD']);
    expect(a.connector.baseUrl).toBe('{{SELLERCLOUD_API_URL}}');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    const ac = a.connector.authConfig;
    expect(ac.loginUrl).toBe('{{SELLERCLOUD_API_URL}}/api/token');
    expect(ac.loginMethod).toBe('POST');
    expect(ac.loginBody).toEqual({ Username: '${username}', Password: '${password}' });
    expect(ac.username).toBe('{{SELLERCLOUD_USERNAME}}');
    expect(ac.password).toBe('{{SELLERCLOUD_PASSWORD}}');
    expect(ac.tokenJsonPath).toBe('access_token');
    expect(ac.expiryJsonPath).toBe('expires_in');
    expect(ac.expiryFormat).toBe('ttl_seconds');
    expect(ac.headerName).toBe('Authorization');
    expect(ac.headerTemplate).toBe('Bearer ${token}');
  });

  it('accepts the RestApiEndpoint of .com and .us servers only, without a trailing slash', () => {
    const re = new RegExp(a.envVarMeta.SELLERCLOUD_API_URL.pattern as string);
    expect(re.test('https://xx.api.sellercloud.com/rest')).toBe(true);
    expect(re.test('https://abcdefg.api.sellercloud.us/rest')).toBe(true);
    expect(re.test('https://xx.api.sellercloud.com/rest/')).toBe(false);
    expect(re.test('https://xx.api.sellercloud.com')).toBe(false);
    expect(re.test('http://xx.api.sellercloud.com/rest')).toBe(false);
    expect(re.test('https://sellercloud.com.example.org/rest')).toBe(false);
  });

  it('probes with one warehouse', () => {
    expect(a.probe).toEqual({ tool: 'sellercloud_list_warehouses', params: { page_size: 1 } });
    expect(tool('sellercloud_list_warehouses').endpointMapping.path).toBe('/api/Warehouses');
    expect(a.connector.healthcheckPath).toBe('/api/Warehouses?model.pageSize=1');
  });

  it('is read-only: every tool is a GET and prefixed sellercloud_', () => {
    expect(a.tools.length).toBeGreaterThanOrEqual(25);
    expect(a.tools.length).toBeLessThanOrEqual(30);
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(t.name.startsWith('sellercloud_')).toBe(true);
      expect(t.enabled).toBeUndefined();
    }
  });

  it('filtered lists page with model.pageNumber and model.pageSize, capped at 50', () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.queryParams?.['model.pageSize'])) {
      expect(t.endpointMapping.queryParams?.['model.pageNumber']).toBe('$page_number');
      expect(t.endpointMapping.queryParams?.['model.pageSize']).toBe('$page_size');
      expect((t.parameters?.properties?.page_size as { maximum: number }).maximum).toBe(50);
    }
  });

  it('endpoints that take plain page parameters get them, with defaults', () => {
    for (const name of ['sellercloud_list_order_packages', 'sellercloud_list_orders_by_view']) {
      const q = tool(name).endpointMapping.queryParams;
      expect(q?.pageNumber).toBe('$page_number');
      expect(q?.pageSize).toBe('$page_size');
      expect((tool(name).parameters?.properties?.page_size as { default: number }).default).toBe(50);
    }
  });

  it('every declared parameter reaches the request and every required one is declared', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = new Set<string>();
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      for (const v of Object.values(m.queryParams ?? {})) used.add(String(v).replace(/^\$/, ''));
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${used.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of used) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('uses the current product endpoints, not the ones Swagger marks obsolete', () => {
    expect(tool('sellercloud_get_product_prices').endpointMapping.path).toBe('/api/Catalog/Prices');
    expect(tool('sellercloud_get_inventory').endpointMapping.path).toBe('/api/Inventory/Details');
    expect(tool('sellercloud_get_inventory_by_warehouse').endpointMapping.path).toBe('/api/Inventory/Warehouses');
  });
});

type SwaggerParam = { name: string; in: string; required?: boolean };
type Swagger = { paths: Record<string, Record<string, { parameters?: SwaggerParam[]; deprecated?: boolean }>> };

const live = process.env.RUN_SELLERCLOUD_LIVE === '1' ? describe : describe.skip;
live('sellercloud adapter: live (public Swagger spec of the docs example server)', () => {
  let swagger: Swagger;
  beforeAll(async () => {
    const res = await fetch(DOCS_SWAGGER);
    expect(res.status).toBe(200);
    swagger = (await res.json()) as Swagger;
  }, 60_000);

  it('every tool maps to a GET in the spec, with query names the spec declares', () => {
    for (const t of a.tools) {
      const specPath = t.endpointMapping.path.replace(/\{\w+\}/g, '{id}');
      const entry =
        swagger.paths[specPath] ??
        Object.entries(swagger.paths).find(([p]) => p.replace(/\{\w+\}/g, '{id}') === specPath)?.[1];
      expect(`${t.name}:${Boolean(entry?.get)}`).toBe(`${t.name}:true`);
      const declared = new Set((entry?.get?.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name));
      for (const q of Object.keys(t.endpointMapping.queryParams ?? {})) {
        expect(`${t.name}:${q}:${declared.has(q)}`).toBe(`${t.name}:${q}:true`);
      }
      for (const p of (entry?.get?.parameters ?? []).filter((x) => x.in === 'query' && x.required)) {
        expect(`${t.name}:${p.name}:${p.name in (t.endpointMapping.queryParams ?? {})}`).toBe(`${t.name}:${p.name}:true`);
      }
    }
  });

  it('the token endpoint takes Username and Password and answers access_token and expires_in', async () => {
    const spec = swagger as unknown as {
      paths: Record<string, Record<string, unknown>>;
      definitions: Record<string, { properties: Record<string, unknown>; required?: string[] }>;
    };
    expect(spec.paths['/api/token'].post).toBeDefined();
    const defs = spec.definitions;
    const req = Object.entries(defs).find(([k]) => k.endsWith('Authentication.CreateTokenRequest'))?.[1];
    const resp = Object.entries(defs).find(([k]) => k.endsWith('Authentication.CreateTokenResponse'))?.[1];
    expect(req?.required).toEqual(['Username', 'Password']);
    expect(Object.keys(resp?.properties ?? {})).toEqual(expect.arrayContaining(['access_token', 'expires_in']));
  });
});
