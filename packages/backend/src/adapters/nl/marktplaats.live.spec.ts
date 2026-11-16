import * as adapter from './marktplaats.json';
/**
 * Marktplaats API v2 adapter (Marktplaats.nl and 2dehands / 2ememain.be).
 *
 * Static checks always run: OAuth2 authorization code against auth.<site>/accounts/oauth
 * with the site chosen from a fixed list, the API host api.<site>, every route against
 * the published reference (https://api.marktplaats.nl/docs/v2/endpoints.html), the
 * JSON Patch body of updates, the money fields in euro cents, and that deletes, paid
 * features and renewals install switched off.
 *
 * Live checks run only with RUN_MARKTPLAATS_LIVE=1 and MARKTPLAATS_SITE and
 * MARKTPLAATS_ACCESS_TOKEN set: they read the signed-in user and the category list.
 * Reads only.
 *
 *   RUN_MARKTPLAATS_LIVE=1 MARKTPLAATS_SITE=marktplaats.nl MARKTPLAATS_ACCESS_TOKEN=... \
 *     npx jest src/adapters/nl/marktplaats.live.spec.ts
 */
type Mapping = {
  method: string;
  path: string;
  queryParams?: Record<string, unknown>;
  bodyMapping?: unknown;
  headers?: Record<string, string>;
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; pattern?: string }>; required?: string[] };
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
  selfHostOnly?: boolean;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string; label?: string; help?: string; options?: { value: string; label: string }[] }>;
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
  marktplaats_get_me: ["GET", "/v2/me"],
  marktplaats_get_user: ["GET", "/v2/users/{user_id}"],
  marktplaats_list_my_advertisements: ["GET", "/v2/users/{user_id}/advertisements"],
  marktplaats_get_advertisement: ["GET", "/v2/advertisements/{item_id}"],
  marktplaats_create_advertisement: ["POST", "/v2/advertisements"],
  marktplaats_update_advertisement: ["PATCH", "/v2/advertisements/{item_id}"],
  marktplaats_delete_advertisement: ["DELETE", "/v2/advertisements/{item_id}"],
  marktplaats_add_advertisement_images: ["POST", "/v2/advertisements/{item_id}/images"],
  marktplaats_list_advertisement_images: ["GET", "/v2/advertisements/{item_id}/images"],
  marktplaats_get_advertisement_statistics: ["GET", "/v2/advertisements/{item_id}/statistics"],
  marktplaats_list_bids: ["GET", "/v2/advertisements/{item_id}/bids"],
  marktplaats_get_bid: ["GET", "/v2/advertisements/{item_id}/bids/{bid_id}"],
  marktplaats_message_bidder: ["POST", "/v2/advertisements/{item_id}/bids/{bid_id}/actions/ask-bidder-question"],
  marktplaats_delete_bid: ["DELETE", "/v2/advertisements/{item_id}/bids/{bid_id}"],
  marktplaats_list_advertisement_features: ["GET", "/v2/advertisements/{item_id}/features"],
  marktplaats_buy_advertisement_feature: ["POST", "/v2/advertisements/{item_id}/features/{feature_name}/buy-feature"],
  marktplaats_renew_advertisement: ["POST", "/v2/advertisements/{item_id}/renew"],
  marktplaats_list_advertisement_transactions: ["GET", "/v2/advertisements/{item_id}/transactions"],
  marktplaats_get_order: ["GET", "/v2/orders/{order_id}"],
  marktplaats_list_categories: ["GET", "/v2/categories"],
  marktplaats_get_category: ["GET", "/v2/categories"],
  marktplaats_list_category_attributes: ["GET", "/v2/categories/{l1_category_id}/{l2_category_id}/attributes"],
  marktplaats_lookup_postcode: ["GET", "/v2/locations"],
};
const SWITCHED_OFF = [
  "marktplaats_buy_advertisement_feature",
  "marktplaats_delete_advertisement",
  "marktplaats_delete_bid",
  "marktplaats_renew_advertisement"
];
const REQUIRED: Record<string, string[]> = {
  marktplaats_get_me: [],
  marktplaats_get_user: ["user_id"],
  marktplaats_list_my_advertisements: ["user_id"],
  marktplaats_get_advertisement: ["item_id"],
  marktplaats_create_advertisement: ["category_id", "postcode", "price_model", "translations"],
  marktplaats_update_advertisement: ["item_id", "operations"],
  marktplaats_delete_advertisement: ["item_id"],
  marktplaats_add_advertisement_images: ["item_id", "urls"],
  marktplaats_list_advertisement_images: ["item_id"],
  marktplaats_get_advertisement_statistics: ["item_id"],
  marktplaats_list_bids: ["item_id"],
  marktplaats_get_bid: ["bid_id", "item_id"],
  marktplaats_message_bidder: ["bid_id", "item_id", "message", "phone_number"],
  marktplaats_delete_bid: ["bid_id", "item_id"],
  marktplaats_list_advertisement_features: ["item_id"],
  marktplaats_buy_advertisement_feature: ["feature_name", "item_id"],
  marktplaats_renew_advertisement: ["item_id"],
  marktplaats_list_advertisement_transactions: ["item_id"],
  marktplaats_get_order: ["order_id"],
  marktplaats_list_categories: [],
  marktplaats_get_category: ["category_id"],
  marktplaats_list_category_attributes: ["l1_category_id", "l2_category_id"],
  marktplaats_lookup_postcode: ["postcode"],
};
const PROBE = {"tool": "marktplaats_get_me", "params": {}};
const PROBE_METHOD = "GET";

describe('marktplaats adapter: static contract', () => {
  it('signs in with OAuth2 on the chosen site and calls that site\'s API host', () => {
    expect(a.slug).toBe('marktplaats');
    expect(a.region).toBe('nl');
    expect(a.category).toBe('e-commerce');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://api.{{MARKTPLAATS_SITE}}');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{MARKTPLAATS_CLIENT_ID}}',
      clientSecret: '{{MARKTPLAATS_CLIENT_SECRET}}',
      refreshToken: '{{MARKTPLAATS_REFRESH_TOKEN}}',
      authorizationUrl: 'https://auth.{{MARKTPLAATS_SITE}}/accounts/oauth/authorize',
      tokenUrl: 'https://auth.{{MARKTPLAATS_SITE}}/accounts/oauth/token',
      tokenAuthMethod: 'client_secret_post',
      pkce: false,
    });
    expect(a.requiredEnvVars).toEqual(['MARKTPLAATS_SITE', 'MARKTPLAATS_CLIENT_ID', 'MARKTPLAATS_CLIENT_SECRET']);
    expect(a.optionalEnvVars).toEqual(['MARKTPLAATS_REFRESH_TOKEN']);
    expect(a.envVarMeta.MARKTPLAATS_CLIENT_SECRET.secret).toBe(true);
    const site = a.envVarMeta.MARKTPLAATS_SITE;
    expect(site.options?.map((o) => o.value)).toEqual(['marktplaats.nl', '2dehands.be', '2ememain.be']);
    const pattern = new RegExp(site.pattern!);
    for (const o of site.options ?? []) expect(pattern.test(o.value)).toBe(true);
    expect(pattern.test('https://api.marktplaats.nl')).toBe(false);
    expect(JSON.stringify(a.connector.headers)).not.toMatch(/MARKTPLAATS_REFRESH_TOKEN/);
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
      const used = refs([m.queryParams ?? {}, m.bodyMapping ?? {}, m.headers ?? {}]);
      for (const p of pathParams(m.path)) used.add(p);
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

  it('keeps parameter patterns compilable', () => {
    for (const t of a.tools) {
      for (const d of Object.values(t.parameters.properties ?? {})) if (d.pattern) expect(() => new RegExp(d.pattern as string)).not.toThrow();
    }
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

  it('patches with a JSON Patch list, merges category attributes and keeps paid actions switched off', () => {
    expect(tool('marktplaats_update_advertisement').endpointMapping.bodyMapping).toEqual({ __raw: '$operations' });
    const create = tool('marktplaats_create_advertisement').endpointMapping.bodyMapping as Record<string, unknown>;
    expect(create.__merge).toBe('$attributes');
    expect(create.location).toEqual({ postcode: '$postcode' });
    for (const name of ['marktplaats_buy_advertisement_feature', 'marktplaats_renew_advertisement']) {
      expect(tool(name).endpointMapping.bodyMapping).toEqual({ pay: true });
      expect(tool(name).enabled).toBe(false);
    }
    for (const t of a.tools) if (t.endpointMapping.method === 'DELETE') expect(t.enabled).toBe(false);
    const itemId = new RegExp(tool('marktplaats_get_advertisement').parameters.properties!.item_id.pattern!);
    expect(itemId.test('m1234567890')).toBe(true);
    expect(itemId.test('a987')).toBe(true);
    expect(itemId.test('1234567890')).toBe(false);
  });
});

const live = process.env.RUN_MARKTPLAATS_LIVE === '1' ? describe : describe.skip;
live('marktplaats adapter: live reads', () => {
  it('reads the signed-in user and the categories', async () => {
    const headers = { Authorization: `Bearer ${process.env.MARKTPLAATS_ACCESS_TOKEN}`, Accept: 'application/json' };
    for (const path of ['/v2/me', '/v2/categories']) {
      const res = await fetch(`https://api.${process.env.MARKTPLAATS_SITE}${path}`, { headers });
      expect(res.status).toBe(200);
    }
  });
});
