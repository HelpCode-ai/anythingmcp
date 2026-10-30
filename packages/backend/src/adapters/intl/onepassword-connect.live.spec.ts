import * as adapter from './onepassword-connect.json';

/**
 * 1Password Connect Server API (www.1password.dev/connect/api-reference, OpenAPI at
 * i.1password.com/media/1password-connect/1password-connect-api_1.8.1.yaml and
 * github.com/1Password/connect docs/openapi/spec.yaml): a self-hosted server, Bearer
 * Connect access token, /v1 paths below the server address, /health at its root.
 * Item reads return secret values; list endpoints return metadata only.
 * Live part (reads only: health, vaults, one vault, its item list; no item is opened):
 *   ONEPASSWORD_CONNECT_URL=https://op-connect.example.com ONEPASSWORD_CONNECT_TOKEN=... \
 *   RUN_ONEPASSWORD_CONNECT_LIVE=1 npx jest src/adapters/intl/onepassword-connect
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown>; exposeHeaders?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  icon: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; healthcheckPath?: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
const PREFIX = 'onepassword_connect_';
const ITEM = '/v1/vaults/{vault_id}/items/{item_id}';

describe('onepassword-connect adapter: static spec conformance', () => {
  it('starts the slug with a letter, so the generated catalog import is a valid identifier', () => {
    expect(a.slug).toBe('onepassword-connect');
    expect(a.icon).toBe('1password');
  });

  it('authenticates with the Connect bearer token against the self-hosted server address', () => {
    expect(a.requiredEnvVars).toEqual(['ONEPASSWORD_CONNECT_URL', 'ONEPASSWORD_CONNECT_TOKEN']);
    expect(a.connector.baseUrl).toBe('{{ONEPASSWORD_CONNECT_URL}}');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{ONEPASSWORD_CONNECT_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/v1/vaults');
    expect(a.envVarMeta.ONEPASSWORD_CONNECT_TOKEN.secret).toBe(true);
    const url = new RegExp(a.envVarMeta.ONEPASSWORD_CONNECT_URL.pattern as string);
    for (const ok of ['https://op-connect.example.com', 'http://10.0.0.5:8080', 'https://example.com/connect']) expect(url.test(ok)).toBe(true);
    for (const bad of ['https://op-connect.example.com/', 'https://op-connect.example.com/v1', 'op-connect.example.com']) expect(url.test(bad)).toBe(false);
  });

  it('maps the vault, item, file, activity and health endpoints of the Connect spec', () => {
    expect(tool('onepassword_connect_list_vaults').endpointMapping).toEqual({ method: 'GET', path: '/v1/vaults', queryParams: { filter: '$filter' } });
    expect(tool('onepassword_connect_get_vault').endpointMapping).toEqual({ method: 'GET', path: '/v1/vaults/{vault_id}' });
    expect(tool('onepassword_connect_list_items').endpointMapping).toEqual({ method: 'GET', path: '/v1/vaults/{vault_id}/items', queryParams: { filter: '$filter' } });
    expect(tool('onepassword_connect_get_item').endpointMapping).toEqual({ method: 'GET', path: ITEM });
    expect(tool('onepassword_connect_list_files').endpointMapping).toEqual({ method: 'GET', path: `${ITEM}/files` });
    expect(tool('onepassword_connect_get_file').endpointMapping).toEqual({ method: 'GET', path: `${ITEM}/files/{file_id}` });
    expect(tool('onepassword_connect_get_file_content').endpointMapping).toEqual({ method: 'GET', path: `${ITEM}/files/{file_id}/content` });
    expect(tool('onepassword_connect_list_activity').endpointMapping).toEqual({ method: 'GET', path: '/v1/activity', queryParams: { limit: '$limit', offset: '$offset' }, exposeHeaders: ['content-range'] });
    expect(tool('onepassword_connect_get_health').endpointMapping).toEqual({ method: 'GET', path: '/health' });
  });

  it('creates with a FullItem body, patches with a raw JSON Patch array and deletes by id', () => {
    expect(tool('onepassword_connect_create_item').endpointMapping).toEqual({
      method: 'POST',
      path: '/v1/vaults/{vault_id}/items',
      bodyMapping: { vault: { id: '$vault_id' }, title: '$title', category: '$category', fields: '$fields', sections: '$sections', tags: '$tags', urls: '$urls', favorite: '$favorite' },
    });
    expect(tool('onepassword_connect_create_item').parameters?.properties?.category.enum).toContain('API_CREDENTIAL');
    expect(tool('onepassword_connect_update_item').endpointMapping).toEqual({ method: 'PATCH', path: ITEM, bodyMapping: { __raw: '$operations' } });
    expect(tool('onepassword_connect_delete_item').endpointMapping).toEqual({ method: 'DELETE', path: ITEM });
    expect(tool('onepassword_connect_delete_item').annotations?.destructiveHint).toBe(true);
  });

  it('switches off exactly the irreversible delete and keeps create and update on', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['onepassword_connect_delete_item']);
    expect(a.instructions).toContain('**Switched off at install**: `onepassword_connect_delete_item`; it cannot be undone, so an admin switches it on when the team needs it.');
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'GET')) expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
  });

  it('says plainly which tools return secret values and which return metadata only', () => {
    expect(tool('onepassword_connect_get_item').description).toMatch(/^Read one item in full\. WARNING: this returns the item's SECRET VALUES/);
    expect(tool('onepassword_connect_get_file_content').description).toContain('WARNING');
    for (const name of ['onepassword_connect_list_vaults', 'onepassword_connect_list_items', 'onepassword_connect_list_files', 'onepassword_connect_get_file']) {
      expect(`${name}:${tool(name).description.includes('etadata only')}`).toBe(`${name}:true`);
    }
    expect(a.instructions).toContain('**The AI sees secret values**');
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('probes with a metadata read and documents every tool', () => {
    expect(a.probe.tool).toBe('onepassword_connect_list_vaults');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_ONEPASSWORD_CONNECT_LIVE === '1' && process.env.ONEPASSWORD_CONNECT_TOKEN && process.env.ONEPASSWORD_CONNECT_URL ? describe : describe.skip;
live('onepassword-connect adapter: live (read-only, metadata only)', () => {
  const base = process.env.ONEPASSWORD_CONNECT_URL as string;
  const headers = { Authorization: `Bearer ${process.env.ONEPASSWORD_CONNECT_TOKEN}`, Accept: 'application/json' };
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers });
    expect(res.status).toBe(200);
    return res.json() as Promise<unknown>;
  };
  it('reads health, vaults, one vault and its item list', async () => {
    expect(await get('/health')).toHaveProperty('version');
    const vaults = (await get('/v1/vaults')) as Array<{ id: string }>;
    expect(Array.isArray(vaults)).toBe(true);
    if (vaults.length) {
      expect(await get(`/v1/vaults/${vaults[0].id}`)).toMatchObject({ id: vaults[0].id });
      const items = (await get(`/v1/vaults/${vaults[0].id}/items`)) as Array<{ id: string; fields?: unknown }>;
      expect(Array.isArray(items)).toBe(true);
      for (const i of items) expect(i.fields).toBeUndefined();
    }
  }, 60_000);
});
