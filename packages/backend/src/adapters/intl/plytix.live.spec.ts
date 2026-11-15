import * as adapter from './plytix.json';
/**
 * Plytix PIM API v1 adapter.
 *
 * Static checks always run: the token login (API key and password posted as
 * JSON to auth.plytix.com, token at data[0].access_token, 15-minute lifetime
 * renewed early), the /api/v1 routes against https://docs.plytix.com/reference/v1-v2/,
 * the search bodies and the switched-off delete.
 *
 * Live checks run only with RUN_PLYTIX_LIVE=1 and PLYTIX_API_KEY,
 * PLYTIX_API_PASSWORD set: they log in, list the product filters and search one
 * product. Reads only.
 *
 *   RUN_PLYTIX_LIVE=1 PLYTIX_API_KEY=... PLYTIX_API_PASSWORD=... \
 *     npx jest src/adapters/intl/plytix.live.spec.ts
 */
type Mapping = {
  method: string;
  path: string;
  queryParams?: Record<string, unknown>;
  bodyMapping?: unknown;
  envDefaults?: Record<string, string>;
  encodePathParams?: boolean;
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string }>; required?: string[] };
  endpointMapping: Mapping;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  description: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string; label?: string; help?: string }>;
  verifyHints: Record<string, unknown>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string>; config?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string): Tool => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const pathParams = (path: string): string[] => [...path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)].map((m) => m[1]);
const refs = (value: unknown, out: Set<string> = new Set<string>()): Set<string> => {
  if (typeof value === 'string') {
    if (/^\$\w+$/.test(value)) out.add(value.slice(1));
  } else if (Array.isArray(value)) {
    value.forEach((item) => refs(item, out));
  } else if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => refs(item, out));
  }
  return out;
};
const outsideBackticks = (text: string): string => text.replace(/`[^`]*`/g, '');

const ROUTES: Record<string, [string, string]> = {
  plytix_search_products: ["POST", "/api/v1/products/search"],
  plytix_list_product_filters: ["GET", "/api/v1/filters/product"],
  plytix_get_product: ["GET", "/api/v1/products/{product_id}"],
  plytix_create_product: ["POST", "/api/v1/products"],
  plytix_update_product: ["PATCH", "/api/v1/products/{product_id}"],
  plytix_delete_product: ["DELETE", "/api/v1/products/{product_id}"],
  plytix_assign_product_family: ["POST", "/api/v1/products/{product_id}/family"],
  plytix_list_product_variants: ["GET", "/api/v1/products/{product_id}/variants"],
  plytix_add_product_variant: ["POST", "/api/v1/products/{parent_product_id}/variants"],
  plytix_link_variant: ["POST", "/api/v1/products/{product_id}/variant/{variant_id}"],
  plytix_list_product_assets: ["GET", "/api/v1/products/{product_id}/assets"],
  plytix_link_product_asset: ["POST", "/api/v1/products/{product_id}/assets"],
  plytix_unlink_product_asset: ["DELETE", "/api/v1/products/{product_id}/assets/{asset_id}"],
  plytix_list_product_categories: ["GET", "/api/v1/products/{product_id}/categories"],
  plytix_link_product_category: ["POST", "/api/v1/products/{product_id}/categories"],
  plytix_unlink_product_category: ["DELETE", "/api/v1/products/{product_id}/categories/{category_id}"],
  plytix_add_related_products: ["POST", "/api/v1/products/{product_id}/relationships/{relationship_id}"],
  plytix_remove_related_products: ["POST", "/api/v1/products/{product_id}/relationships/{relationship_id}/unlink"],
  plytix_search_assets: ["POST", "/api/v1/assets/search"],
  plytix_get_asset: ["GET", "/api/v1/assets/{asset_id}"],
  plytix_create_asset_from_url: ["POST", "/api/v1/assets"],
  plytix_search_attributes: ["POST", "/api/v1/attributes/product/search"],
  plytix_get_attribute: ["GET", "/api/v1/attributes/product/{attribute_id}"],
  plytix_search_categories: ["POST", "/api/v1/categories/product/search"],
  plytix_search_relationships: ["POST", "/api/v1/relationships/search"],
  plytix_search_product_families: ["POST", "/api/v1/product_families/search"],
  plytix_list_family_attributes: ["GET", "/api/v1/product_families/{product_family_id}/attributes"],
};
const SWITCHED_OFF = [
  "plytix_delete_product",
];
const REQUIRED: Record<string, string[]> = {
  plytix_search_products: ["attributes"],
  plytix_list_product_filters: [],
  plytix_get_product: ["product_id"],
  plytix_create_product: ["sku"],
  plytix_update_product: ["product_id"],
  plytix_delete_product: ["product_id"],
  plytix_assign_product_family: ["product_family_id", "product_id"],
  plytix_list_product_variants: ["product_id"],
  plytix_add_product_variant: ["parent_product_id", "sku"],
  plytix_link_variant: ["product_id", "variant_id"],
  plytix_list_product_assets: ["product_id"],
  plytix_link_product_asset: ["asset_id", "product_id"],
  plytix_unlink_product_asset: ["asset_id", "product_id"],
  plytix_list_product_categories: ["product_id"],
  plytix_link_product_category: ["category_id", "product_id"],
  plytix_unlink_product_category: ["category_id", "product_id"],
  plytix_add_related_products: ["product_id", "product_relationships", "relationship_id"],
  plytix_remove_related_products: ["product_id", "product_relationships", "relationship_id"],
  plytix_search_assets: [],
  plytix_get_asset: ["asset_id"],
  plytix_create_asset_from_url: ["url"],
  plytix_search_attributes: [],
  plytix_get_attribute: ["attribute_id"],
  plytix_search_categories: [],
  plytix_search_relationships: [],
  plytix_search_product_families: [],
  plytix_list_family_attributes: ["product_family_id"],
};
const PROBE = {"tool": "plytix_list_product_filters", "params": {}};
const PROBE_METHOD = "GET";

describe('plytix adapter: static contract', () => {
  it('logs in with the API key and password and renews the 15-minute token early', () => {
    expect(a.slug).toBe('plytix');
    expect(a.connector.baseUrl).toBe('https://pim.plytix.com');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toMatchObject({
      loginUrl: 'https://auth.plytix.com/auth/api/get-token',
      loginMethod: 'POST',
      loginBody: { api_key: '${username}', api_password: '${password}' },
      username: '{{PLYTIX_API_KEY}}',
      password: '{{PLYTIX_API_PASSWORD}}',
      tokenJsonPath: 'data[0].access_token',
      headerTemplate: 'Bearer ${token}',
      refreshOn401: true,
    });
    const ttl = a.connector.authConfig.tokenTTLSeconds as number;
    const early = a.connector.authConfig.proactiveRefreshSeconds as number;
    expect(ttl).toBeLessThanOrEqual(900);
    expect(early).toBeLessThan(ttl);
    expect(a.envVarMeta.PLYTIX_API_PASSWORD.secret).toBe(true);
  });

  it('sends the documented search body', () => {
    expect(tool('plytix_search_products').endpointMapping.bodyMapping).toEqual({
      filters: '$filters',
      attributes: '$attributes',
      relationship_filters: '$relationship_filters',
      pagination: { page: '$page', page_size: '$page_size', order: '$order' },
    });
    expect(tool('plytix_add_product_variant').endpointMapping.bodyMapping).toEqual({ variant: { sku: '$sku', label: '$label', attributes: '$attributes' } });
    expect(tool('plytix_link_product_asset').endpointMapping.bodyMapping).toEqual({ id: '$asset_id', attribute_label: '$attribute_label' });
  });

  it('pins the method and path of every tool', () => {
    const actual: Record<string, [string, string]> = {};
    for (const t of a.tools) actual[t.name] = [t.endpointMapping.method, t.endpointMapping.path];
    expect(actual).toEqual(ROUTES);
  });

  it('installs exactly the risky tools switched off', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...SWITCHED_OFF].sort());
  });

  it('wires every parameter into the request and requires every path parameter', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = refs([m.queryParams ?? {}, m.bodyMapping ?? {}]);
      for (const p of pathParams(m.path)) used.add(p);
      for (const p of Object.keys(m.envDefaults ?? {})) used.add(p);
      for (const p of Object.keys(t.parameters.properties ?? {})) expect(`${t.name}:${p}:${used.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of pathParams(m.path)) expect(`${t.name}:${p}:${(t.parameters.required ?? []).includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const r of t.parameters.required ?? []) expect(`${t.name}:${r}:${r in (t.parameters.properties ?? {})}`).toBe(`${t.name}:${r}:true`);
    }
  });

  it('pins the required parameters of every tool', () => {
    const actual: Record<string, string[]> = {};
    for (const t of a.tools) actual[t.name] = [...(t.parameters.required ?? [])].sort();
    expect(actual).toEqual(REQUIRED);
  });

  it('names every tool in the instructions, prefixes it with the slug and keeps the text MDX-safe', () => {
    const prefix = `${a.slug.replace(/-/g, '_')}_`;
    for (const t of a.tools) {
      expect(t.name.startsWith(prefix)).toBe(true);
      expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
      expect(outsideBackticks(t.description)).not.toMatch(/[{}<]/);
      for (const [p, d] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${Boolean(d.description)}`).toBe(`${t.name}.${p}:true`);
        expect(outsideBackticks(d.description ?? '')).not.toMatch(/[{}<]/);
      }
    }
    expect(outsideBackticks(a.instructions)).not.toMatch(/[{}<]/);
    expect(outsideBackticks(a.description)).not.toMatch(/[{}<]/);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });

  it('describes every variable and probes with a cheap read', () => {
    for (const v of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) {
      expect(a.envVarMeta[v]).toMatchObject({ label: expect.any(String), kind: expect.any(String), help: expect.any(String) });
    }
    expect(a.probe).toEqual(PROBE);
    expect(tool(a.probe.tool).endpointMapping.method).toBe(PROBE_METHOD);
    for (const status of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[status]).toBeDefined();
  });
});

const live = process.env.RUN_PLYTIX_LIVE === '1' ? describe : describe.skip;
live('plytix adapter: live reads', () => {
  let token = '';
  beforeAll(async () => {
    const res = await fetch('https://auth.plytix.com/auth/api/get-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: process.env.PLYTIX_API_KEY, api_password: process.env.PLYTIX_API_PASSWORD }),
    });
    expect(res.status).toBe(200);
    token = ((await res.json()) as { data: Array<{ access_token: string }> }).data[0].access_token;
  });
  it('lists the product filters and searches one product', async () => {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const filters = await fetch('https://pim.plytix.com/api/v1/filters/product', { headers });
    expect(filters.status).toBe(200);
    const search = await fetch('https://pim.plytix.com/api/v1/products/search', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filters: [], attributes: ['label'], pagination: { page: 1, page_size: 1 } }),
    });
    expect(search.status).toBe(200);
  });
});
