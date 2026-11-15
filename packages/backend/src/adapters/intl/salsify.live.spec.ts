import * as adapter from './salsify.json';
/**
 * Salsify PXM API adapter.
 *
 * Static checks always run: the bearer API key, the organization-scoped routes
 * (v1 for products, assets, properties and lists; the unversioned base for
 * exports, imports and channels) against https://developers.salsify.com/reference,
 * the raw property bodies and the switched-off bulk, delete, import and channel
 * runs.
 *
 * Live checks run only with RUN_SALSIFY_LIVE=1 and SALSIFY_ORG_ID,
 * SALSIFY_API_TOKEN set: they read one product and one digital asset. Reads only.
 *
 *   RUN_SALSIFY_LIVE=1 SALSIFY_ORG_ID=s-... SALSIFY_API_TOKEN=... \
 *     npx jest src/adapters/intl/salsify.live.spec.ts
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
  salsify_list_products: ["GET", "/v1/orgs/{{SALSIFY_ORG_ID}}/products"],
  salsify_get_product: ["GET", "/v1/orgs/{{SALSIFY_ORG_ID}}/products/{product_id}"],
  salsify_create_product: ["POST", "/v1/orgs/{{SALSIFY_ORG_ID}}/products"],
  salsify_update_product: ["PUT", "/v1/orgs/{{SALSIFY_ORG_ID}}/products/{product_id}"],
  salsify_upsert_products: ["PUT", "/v1/orgs/{{SALSIFY_ORG_ID}}/products/_upsert"],
  salsify_delete_product: ["DELETE", "/v1/orgs/{{SALSIFY_ORG_ID}}/products/{product_id}"],
  salsify_list_digital_assets: ["GET", "/v1/orgs/{{SALSIFY_ORG_ID}}/digital_assets"],
  salsify_get_digital_asset: ["GET", "/v1/orgs/{{SALSIFY_ORG_ID}}/digital_assets/{asset_id}"],
  salsify_create_digital_asset: ["POST", "/v1/orgs/{{SALSIFY_ORG_ID}}/digital_assets"],
  salsify_update_digital_asset: ["PUT", "/v1/orgs/{{SALSIFY_ORG_ID}}/digital_assets/{asset_id}"],
  salsify_get_property: ["GET", "/v1/orgs/{{SALSIFY_ORG_ID}}/properties/{property_id}"],
  salsify_add_list_members: ["PUT", "/v1/orgs/{{SALSIFY_ORG_ID}}/lists/{list_id}/members"],
  salsify_remove_list_members: ["DELETE", "/v1/orgs/{{SALSIFY_ORG_ID}}/lists/{list_id}/members"],
  salsify_start_export: ["POST", "/orgs/{{SALSIFY_ORG_ID}}/export_runs"],
  salsify_get_export: ["GET", "/orgs/{{SALSIFY_ORG_ID}}/export_runs/{export_id}"],
  salsify_start_import_run: ["POST", "/orgs/{{SALSIFY_ORG_ID}}/imports/{import_id}/runs"],
  salsify_get_import_run: ["GET", "/orgs/{{SALSIFY_ORG_ID}}/imports/runs/{run_id}"],
  salsify_get_latest_channel_run: ["GET", "/orgs/{{SALSIFY_ORG_ID}}/channels/{channel_id}/runs/latest"],
  salsify_get_channel_run: ["GET", "/orgs/{{SALSIFY_ORG_ID}}/channels/{channel_id}/runs/{run_id}"],
  salsify_start_channel_run: ["POST", "/orgs/{{SALSIFY_ORG_ID}}/channels/{channel_id}/runs"],
};
const SWITCHED_OFF = [
  "salsify_delete_product",
  "salsify_start_channel_run",
  "salsify_start_import_run",
  "salsify_upsert_products",
];
const REQUIRED: Record<string, string[]> = {
  salsify_list_products: [],
  salsify_get_product: ["product_id"],
  salsify_create_product: ["product"],
  salsify_update_product: ["product_id", "values"],
  salsify_upsert_products: ["products"],
  salsify_delete_product: ["product_id"],
  salsify_list_digital_assets: [],
  salsify_get_digital_asset: ["asset_id"],
  salsify_create_digital_asset: ["source_url"],
  salsify_update_digital_asset: ["asset_id", "values"],
  salsify_get_property: ["property_id"],
  salsify_add_list_members: ["list_id", "member_ids"],
  salsify_remove_list_members: ["list_id", "member_ids"],
  salsify_start_export: ["entity_type", "format"],
  salsify_get_export: ["export_id"],
  salsify_start_import_run: ["import_id"],
  salsify_get_import_run: ["run_id"],
  salsify_get_latest_channel_run: ["channel_id"],
  salsify_get_channel_run: ["channel_id", "run_id"],
  salsify_start_channel_run: ["channel_id"],
};
const PROBE = {"tool": "salsify_list_products", "params": {"per_page": 1}};
const PROBE_METHOD = "GET";

describe('salsify adapter: static contract', () => {
  it('sends the API key as a bearer token to app.salsify.com', () => {
    expect(a.slug).toBe('salsify');
    expect(a.connector.baseUrl).toBe('https://app.salsify.com/api');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{SALSIFY_API_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['SALSIFY_ORG_ID', 'SALSIFY_API_TOKEN']);
    const org = new RegExp(a.envVarMeta.SALSIFY_ORG_ID.pattern!);
    expect(org.test('s-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d')).toBe(true);
    expect(org.test('https://app.salsify.com/app/orgs/s-1a2b')).toBe(false);
  });

  it('scopes every route to the organization and passes property values through as the body', () => {
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/(v1\/)?orgs\/\{\{SALSIFY_ORG_ID\}\}\//);
    for (const name of ['salsify_create_product', 'salsify_update_product', 'salsify_upsert_products', 'salsify_update_digital_asset']) {
      expect(Object.keys(tool(name).endpointMapping.bodyMapping as Record<string, unknown>)).toEqual(['__raw']);
    }
    for (const name of ['salsify_get_product', 'salsify_update_product', 'salsify_delete_product', 'salsify_get_property']) {
      expect(tool(name).endpointMapping.encodePathParams).toBe(true);
    }
    expect(tool('salsify_add_list_members').endpointMapping.bodyMapping).toEqual({ data: { member_ids: '$member_ids' } });
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

const live = process.env.RUN_SALSIFY_LIVE === '1' ? describe : describe.skip;
live('salsify adapter: live reads', () => {
  it('reads one product and one digital asset', async () => {
    const base = `https://app.salsify.com/api/v1/orgs/${process.env.SALSIFY_ORG_ID}`;
    for (const path of ['/products?per_page=1', '/digital_assets?per_page=1']) {
      const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${process.env.SALSIFY_API_TOKEN}` } });
      expect(res.status).toBe(200);
    }
  });
});
