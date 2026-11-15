import * as adapter from './akeneo.json';
/**
 * Akeneo PIM REST API adapter.
 *
 * Static checks always run: the password grant at the customer's own PIM host
 * (client ID and secret in a Basic header, API user and password in the form
 * body), the /api/rest/v1 routes against Akeneo's published reference
 * (https://api.akeneo.com/api-reference-index.html), the switched-off deletes
 * and the write bodies.
 *
 * Live checks run only with RUN_AKENEO_LIVE=1 and AKENEO_HOST, AKENEO_CLIENT_ID,
 * AKENEO_CLIENT_SECRET, AKENEO_USERNAME, AKENEO_PASSWORD set. They fetch a token
 * and read one channel and one product. Reads only.
 *
 *   RUN_AKENEO_LIVE=1 AKENEO_HOST=... AKENEO_CLIENT_ID=... AKENEO_CLIENT_SECRET=... \
 *     AKENEO_USERNAME=... AKENEO_PASSWORD=... npx jest src/adapters/intl/akeneo.live.spec.ts
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
  akeneo_list_products: ["GET", "/api/rest/v1/products-uuid"],
  akeneo_get_product: ["GET", "/api/rest/v1/products-uuid/{uuid}"],
  akeneo_get_product_by_identifier: ["GET", "/api/rest/v1/products/{identifier}"],
  akeneo_create_product: ["POST", "/api/rest/v1/products-uuid"],
  akeneo_update_product: ["PATCH", "/api/rest/v1/products-uuid/{uuid}"],
  akeneo_delete_product: ["DELETE", "/api/rest/v1/products-uuid/{uuid}"],
  akeneo_list_product_models: ["GET", "/api/rest/v1/product-models"],
  akeneo_get_product_model: ["GET", "/api/rest/v1/product-models/{code}"],
  akeneo_create_product_model: ["POST", "/api/rest/v1/product-models"],
  akeneo_update_product_model: ["PATCH", "/api/rest/v1/product-models/{code}"],
  akeneo_delete_product_model: ["DELETE", "/api/rest/v1/product-models/{code}"],
  akeneo_list_families: ["GET", "/api/rest/v1/families"],
  akeneo_get_family: ["GET", "/api/rest/v1/families/{code}"],
  akeneo_list_family_variants: ["GET", "/api/rest/v1/families/{family_code}/variants"],
  akeneo_list_attributes: ["GET", "/api/rest/v1/attributes"],
  akeneo_get_attribute: ["GET", "/api/rest/v1/attributes/{code}"],
  akeneo_list_attribute_options: ["GET", "/api/rest/v1/attributes/{attribute_code}/options"],
  akeneo_upsert_attribute_option: ["PATCH", "/api/rest/v1/attributes/{attribute_code}/options/{code}"],
  akeneo_list_attribute_groups: ["GET", "/api/rest/v1/attribute-groups"],
  akeneo_list_categories: ["GET", "/api/rest/v1/categories"],
  akeneo_get_category: ["GET", "/api/rest/v1/categories/{code}"],
  akeneo_upsert_category: ["PATCH", "/api/rest/v1/categories/{code}"],
  akeneo_list_channels: ["GET", "/api/rest/v1/channels"],
  akeneo_list_locales: ["GET", "/api/rest/v1/locales"],
  akeneo_list_currencies: ["GET", "/api/rest/v1/currencies"],
  akeneo_list_association_types: ["GET", "/api/rest/v1/association-types"],
  akeneo_list_media_files: ["GET", "/api/rest/v1/media-files"],
  akeneo_get_media_file: ["GET", "/api/rest/v1/media-files/{code}"],
  akeneo_download_media_file: ["GET", "/api/rest/v1/media-files/{code}/download"],
};
const SWITCHED_OFF = [
  "akeneo_delete_product",
  "akeneo_delete_product_model",
];
const REQUIRED: Record<string, string[]> = {
  akeneo_list_products: [],
  akeneo_get_product: ["uuid"],
  akeneo_get_product_by_identifier: ["identifier"],
  akeneo_create_product: ["values"],
  akeneo_update_product: ["uuid"],
  akeneo_delete_product: ["uuid"],
  akeneo_list_product_models: [],
  akeneo_get_product_model: ["code"],
  akeneo_create_product_model: ["code", "family_variant"],
  akeneo_update_product_model: ["code"],
  akeneo_delete_product_model: ["code"],
  akeneo_list_families: [],
  akeneo_get_family: ["code"],
  akeneo_list_family_variants: ["family_code"],
  akeneo_list_attributes: [],
  akeneo_get_attribute: ["code"],
  akeneo_list_attribute_options: ["attribute_code"],
  akeneo_upsert_attribute_option: ["attribute_code", "code"],
  akeneo_list_attribute_groups: [],
  akeneo_list_categories: [],
  akeneo_get_category: ["code"],
  akeneo_upsert_category: ["code"],
  akeneo_list_channels: [],
  akeneo_list_locales: [],
  akeneo_list_currencies: [],
  akeneo_list_association_types: [],
  akeneo_list_media_files: [],
  akeneo_get_media_file: ["code"],
  akeneo_download_media_file: ["code"],
};
const PROBE = {"tool": "akeneo_list_channels", "params": {"limit": 1}};
const PROBE_METHOD = "GET";

describe('akeneo adapter: static contract', () => {
  it('signs in with the password grant at the PIM host', () => {
    expect(a.slug).toBe('akeneo');
    expect(a.region).toBe('intl');
    expect(a.icon).toBe('akeneo');
    expect(a.connector.baseUrl).toBe('https://{{AKENEO_HOST}}');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'password',
      clientId: '{{AKENEO_CLIENT_ID}}',
      clientSecret: '{{AKENEO_CLIENT_SECRET}}',
      username: '{{AKENEO_USERNAME}}',
      password: '{{AKENEO_PASSWORD}}',
      tokenUrl: 'https://{{AKENEO_HOST}}/api/oauth/v1/token',
      tokenAuthMethod: 'client_secret_basic',
    });
    expect(a.requiredEnvVars).toEqual(['AKENEO_HOST', 'AKENEO_CLIENT_ID', 'AKENEO_CLIENT_SECRET', 'AKENEO_USERNAME', 'AKENEO_PASSWORD']);
    for (const v of ['AKENEO_CLIENT_SECRET', 'AKENEO_PASSWORD']) expect(a.envVarMeta[v].secret).toBe(true);
    const host = new RegExp(a.envVarMeta.AKENEO_HOST.pattern!);
    for (const ok of ['acme.cloud.akeneo.com', 'pim.example.org', 'localhost:8080']) expect(host.test(ok)).toBe(true);
    for (const bad of ['https://acme.cloud.akeneo.com', 'acme.cloud.akeneo.com/api']) expect(host.test(bad)).toBe(false);
  });

  it('upserts with PATCH on the UUID and code routes and never deletes by default', () => {
    expect(tool('akeneo_update_product').endpointMapping.bodyMapping).toEqual({
      values: '$values', family: '$family', categories: '$categories', enabled: '$enabled', parent: '$parent', groups: '$groups', associations: '$associations',
    });
    expect(tool('akeneo_create_product').endpointMapping).toMatchObject({ method: 'POST', path: '/api/rest/v1/products-uuid' });
    expect(tool('akeneo_get_product_by_identifier').endpointMapping.encodePathParams).toBe(true);
    expect(tool('akeneo_get_media_file').endpointMapping.encodePathParams).toBeUndefined();
    for (const t of a.tools) if (t.endpointMapping.method === 'DELETE') expect(t.enabled).toBe(false);
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

const live = process.env.RUN_AKENEO_LIVE === '1' ? describe : describe.skip;
live('akeneo adapter: live reads', () => {
  const env = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  let token = '';
  beforeAll(async () => {
    const basic = Buffer.from(`${env('AKENEO_CLIENT_ID')}:${env('AKENEO_CLIENT_SECRET')}`).toString('base64');
    const res = await fetch(`https://${env('AKENEO_HOST')}/api/oauth/v1/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', username: env('AKENEO_USERNAME'), password: env('AKENEO_PASSWORD') }).toString(),
    });
    expect(res.status).toBe(200);
    token = ((await res.json()) as { access_token: string }).access_token;
  });
  it('reads one channel and one product', async () => {
    for (const path of ['/api/rest/v1/channels?limit=1', '/api/rest/v1/products-uuid?limit=1']) {
      const res = await fetch(`https://${env('AKENEO_HOST')}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { _embedded?: { items?: unknown[] } })._embedded?.items).toBeDefined();
    }
  });
});
