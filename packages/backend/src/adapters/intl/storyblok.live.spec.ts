import * as adapter from './storyblok.json';

/**
 * Storyblok Management API (storyblok.com/docs/api/management; no OpenAPI file is published, the
 * official PHP management client confirms the payload wrappers): base
 * https://<region host>/v1/spaces/<space id>, personal access token as the raw Authorization header,
 * page/per_page paging with the total in the `total` response header. Publish and unpublish are GET.
 * Live part (reads only: space, stories, components, assets, datasources, workflow stages, releases):
 *   STORYBLOK_PERSONAL_ACCESS_TOKEN=... STORYBLOK_SPACE_ID=... STORYBLOK_API_HOST=mapi.storyblok.com \
 *   RUN_STORYBLOK_LIVE=1 npx jest src/adapters/intl/storyblok
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown>; exposeHeaders?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
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
const PREFIX = 'storyblok_';

describe('storyblok adapter: static spec conformance', () => {
  it('sends the personal access token as the raw Authorization header to the regional space URL', () => {
    expect(a.requiredEnvVars).toEqual(['STORYBLOK_PERSONAL_ACCESS_TOKEN', 'STORYBLOK_SPACE_ID', 'STORYBLOK_API_HOST']);
    expect(a.connector.baseUrl).toBe('https://{{STORYBLOK_API_HOST}}/v1/spaces/{{STORYBLOK_SPACE_ID}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: '{{STORYBLOK_PERSONAL_ACCESS_TOKEN}}' });
    expect(a.envVarMeta?.STORYBLOK_PERSONAL_ACCESS_TOKEN.secret).toBe(true);
  });

  it('accepts exactly the five regional Management API hosts', () => {
    const host = new RegExp(a.envVarMeta?.STORYBLOK_API_HOST.pattern ?? '');
    for (const h of ['mapi.storyblok.com', 'api-us.storyblok.com', 'api-ca.storyblok.com', 'api-ap.storyblok.com', 'app.storyblokchina.cn']) expect(`${h}:${host.test(h)}`).toBe(`${h}:true`);
    for (const h of ['https://mapi.storyblok.com', 'api.storyblok.com', 'mapi.storyblok.com/v1', 'evil.com']) expect(`${h}:${host.test(h)}`).toBe(`${h}:false`);
    expect(new RegExp(a.envVarMeta?.STORYBLOK_SPACE_ID.pattern ?? '').test('288868932106293')).toBe(true);
  });

  it('maps the story endpoints with the documented wrappers and query names', () => {
    expect(tool('storyblok_get_space').endpointMapping).toEqual({ method: 'GET', path: '/' });
    expect(tool('storyblok_list_stories').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/stories',
      queryParams: { starts_with: '$starts_with', by_slugs: '$by_slugs', text_search: '$text_search', filter_query: '$filter_query', in_workflow_stages: '$in_workflow_stages', page: '$page', per_page: '$per_page' },
      exposeHeaders: ['total', 'per_page'],
    });
    expect(tool('storyblok_get_story').endpointMapping).toEqual({ method: 'GET', path: '/stories/{story_id}' });
    expect(tool('storyblok_list_story_versions').endpointMapping.path).toBe('/stories/{story_id}/versions');
    expect(tool('storyblok_create_story').endpointMapping).toEqual({ method: 'POST', path: '/stories', bodyMapping: { story: '$story', publish: '$publish', release_id: '$release_id' } });
    expect(tool('storyblok_update_story').endpointMapping).toMatchObject({ method: 'PUT', path: '/stories/{story_id}', bodyMapping: { story: '$story', publish: '$publish', lang: '$lang', force_update: '$force_update' } });
    expect(tool('storyblok_publish_story').endpointMapping).toEqual({ method: 'GET', path: '/stories/{story_id}/publish', queryParams: { lang: '$lang' } });
    expect(tool('storyblok_unpublish_story').endpointMapping).toEqual({ method: 'GET', path: '/stories/{story_id}/unpublish', queryParams: { lang: '$lang' } });
  });

  it('maps components, assets, datasources, workflows and releases', () => {
    expect(tool('storyblok_list_components').endpointMapping).toMatchObject({ path: '/components', queryParams: { is_root: '$is_root', in_group: '$in_group' } });
    expect(tool('storyblok_get_component').endpointMapping.path).toBe('/components/{component_id}');
    expect(tool('storyblok_list_component_folders').endpointMapping.path).toBe('/component_groups');
    expect(tool('storyblok_list_assets').endpointMapping).toMatchObject({ path: '/assets', queryParams: { in_folder: '$in_folder', with_tags: '$with_tags', sort_by: '$sort_by' } });
    expect(tool('storyblok_get_asset').endpointMapping.path).toBe('/assets/{asset_id}');
    expect(tool('storyblok_update_asset').endpointMapping).toEqual({ method: 'PUT', path: '/assets/{asset_id}', bodyMapping: { asset: '$asset' } });
    expect(tool('storyblok_list_asset_folders').endpointMapping.path).toBe('/asset_folders');
    expect(tool('storyblok_list_internal_tags').endpointMapping.path).toBe('/internal_tags');
    expect(tool('storyblok_list_datasources').endpointMapping.path).toBe('/datasources');
    expect(tool('storyblok_list_datasource_entries').endpointMapping).toMatchObject({ path: '/datasource_entries', queryParams: { datasource_id: '$datasource_id', datasource_slug: '$datasource_slug', dimension: '$dimension' } });
    expect(tool('storyblok_create_datasource_entry').endpointMapping).toEqual({ method: 'POST', path: '/datasource_entries', bodyMapping: { datasource_entry: { datasource_id: '$datasource_id', name: '$name', value: '$value' } } });
    expect(tool('storyblok_update_datasource_entry').endpointMapping).toEqual({ method: 'PUT', path: '/datasource_entries/{datasource_entry_id}', bodyMapping: { datasource_entry: '$datasource_entry', dimension_id: '$dimension_id' } });
    expect(tool('storyblok_list_workflows').endpointMapping).toEqual({ method: 'GET', path: '/workflows', queryParams: { content_type: '$content_type' } });
    expect(tool('storyblok_list_workflow_stages').endpointMapping.path).toBe('/workflow_stages');
    expect(tool('storyblok_list_workflow_stage_changes').endpointMapping).toEqual({ method: 'GET', path: '/workflow_stage_changes', queryParams: { with_story: '$with_story' } });
    expect(tool('storyblok_change_workflow_stage').endpointMapping).toMatchObject({ method: 'POST', path: '/workflow_stage_changes', bodyMapping: { workflow_stage_change: { story_id: '$story_id', workflow_stage_id: '$workflow_stage_id' } } });
    expect(tool('storyblok_list_releases').endpointMapping.path).toBe('/releases');
    expect(tool('storyblok_get_release').endpointMapping.path).toBe('/releases/{release_id}');
    expect(tool('storyblok_create_release').endpointMapping).toEqual({ method: 'POST', path: '/releases', bodyMapping: { release: '$release' } });
    expect(tool('storyblok_update_release').endpointMapping).toEqual({ method: 'PUT', path: '/releases/{release_id}', bodyMapping: { release: '$release', do_release: '$do_release' } });
  });

  it('marks the GET publish and unpublish calls as writes', () => {
    expect(tool('storyblok_publish_story').annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(tool('storyblok_unpublish_story').annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    for (const t of a.tools) {
      if (t.endpointMapping.method !== 'GET' || t.name.endsWith('publish_story')) continue;
      expect(`${t.name}:${t.annotations?.readOnlyHint === false}`).toBe(`${t.name}:false`);
    }
  });

  it('switches off exactly the deletes and documents that', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name);
    expect(off).toEqual(['storyblok_delete_story', 'storyblok_delete_asset']);
    const deletes = a.tools.filter((t) => t.endpointMapping.method === 'DELETE').map((t) => t.name);
    expect(deletes).toEqual(off);
    for (const n of off) expect(tool(n).annotations?.destructiveHint).toBe(true);
    expect(a.instructions).toContain('**Switched off at install**: `storyblok_delete_story` and `storyblok_delete_asset`');
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

  it('probes with a read tool and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.annotations).toBeUndefined();
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const env = process.env;
const live = env.RUN_STORYBLOK_LIVE === '1' && env.STORYBLOK_PERSONAL_ACCESS_TOKEN && env.STORYBLOK_SPACE_ID && env.STORYBLOK_API_HOST ? describe : describe.skip;
live('storyblok adapter: live (read-only)', () => {
  const base = () => `https://${env.STORYBLOK_API_HOST}/v1/spaces/${env.STORYBLOK_SPACE_ID}`;
  const get = async (path: string) => {
    const res = await fetch(`${base()}${path}`, { headers: { Authorization: String(env.STORYBLOK_PERSONAL_ACCESS_TOKEN), Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return { body: (await res.json()) as Record<string, unknown>, total: res.headers.get('total') };
  };
  it('reads the space, stories, components, assets, datasources, workflow stages and releases', async () => {
    expect((await get('/')).body.space).toBeDefined();
    const stories = await get('/stories?per_page=2');
    expect(Array.isArray(stories.body.stories)).toBe(true);
    expect(stories.total).not.toBeNull();
    expect(Array.isArray((await get('/components')).body.components)).toBe(true);
    expect(Array.isArray((await get('/assets?per_page=2')).body.assets)).toBe(true);
    expect(Array.isArray((await get('/datasources')).body.datasources)).toBe(true);
    expect(Array.isArray((await get('/workflow_stages')).body.workflow_stages)).toBe(true);
    expect(Array.isArray((await get('/releases')).body.releases)).toBe(true);
  }, 60_000);
});
