import axios from 'axios';
import * as adapter from './contentful.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { findUnresolvedVariables } from '../../common/unresolved-placeholders.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Contentful adapter:
 *
 *   1. Static: always runs. Pins the split between the Content Delivery API
 *      (connector base URL, delivery token as a per-tool Bearer header) and
 *      the Content Management API (absolute URLs on CONTENTFUL_MANAGEMENT_URL
 *      with the personal access token and the management media type), the
 *      version and content-type headers, the JSON Patch body, every tool's
 *      method and URL, and which tools are read-only or switched off.
 *
 *   2. Live: skipped unless CONTENTFUL_SPACE_ID and CONTENTFUL_DELIVERY_TOKEN
 *      are set. CONTENTFUL_ENVIRONMENT defaults to master and
 *      CONTENTFUL_DELIVERY_URL to https://cdn.contentful.com:
 *
 *        CONTENTFUL_SPACE_ID=... CONTENTFUL_DELIVERY_TOKEN=... \
 *          npx jest src/adapters/intl/contentful.live.spec.ts
 *
 *      Reads the space, content types, entries (with a field filter),
 *      assets, locales and tags. With CONTENTFUL_MANAGEMENT_TOKEN
 *      (CONTENTFUL_MANAGEMENT_URL defaults to https://api.contentful.com) it
 *      also reads spaces, environments and entries with drafts.
 *
 *      CONTENTFUL_LIVE_WRITE=1 (needs the management token; use a test space
 *      or environment) creates a temporary content type directly, then with
 *      the tools creates an entry, reads, replaces, patches, publishes, reads
 *      it through the delivery API, unpublishes and deletes it, and creates a
 *      public tag. In `finally` the entry, the tag and the content type are
 *      removed.
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, string>;
    headers: Record<string, string>;
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const CMA_TYPE = 'application/vnd.contentful.management.v1+json';
const ENV = {
  CONTENTFUL_SPACE_ID: 'space1',
  CONTENTFUL_ENVIRONMENT: 'master',
  CONTENTFUL_DELIVERY_URL: 'https://cdn.contentful.com',
  CONTENTFUL_DELIVERY_TOKEN: 'cda-token',
  CONTENTFUL_MANAGEMENT_URL: 'https://api.contentful.com',
  CONTENTFUL_MANAGEMENT_TOKEN: 'cma-token',
};
const CDA = 'https://cdn.contentful.com/spaces/space1/environments/master';
const CMA = 'https://api.contentful.com/spaces/space1/environments/master';
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: a.connector.authConfig, headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, params);
const sent = () => mockedAxios.mock.calls[0][0];
const isManagement = (t: Tool) => t.endpointMapping.path.startsWith('{{CONTENTFUL_MANAGEMENT_URL}}');

describe('contentful adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (verified live on 11 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
    expect(a.prerequisites).toMatch(/delivery token/);
  });

  it('reads through the delivery API with the delivery token on each tool, no connector-wide auth', () => {
    expect(a.connector.baseUrl).toBe('{{CONTENTFUL_DELIVERY_URL}}');
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.authConfig).toBeUndefined();
    expect(Object.keys(a.connector.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
    for (const t of a.tools.filter((x) => !isManagement(x))) {
      expect(`${t.name}:${t.endpointMapping.headers?.Authorization}`).toBe(`${t.name}:Bearer {{CONTENTFUL_DELIVERY_TOKEN}}`);
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(t.endpointMapping.path.startsWith('/spaces/{{CONTENTFUL_SPACE_ID}}')).toBe(true);
    }
  });

  it('writes through the management API with the personal access token and its media type', () => {
    const management = a.tools.filter(isManagement);
    expect(management.length).toBe(11);
    for (const t of management) {
      expect(`${t.name}:${t.endpointMapping.headers?.Authorization}`).toBe(`${t.name}:Bearer {{CONTENTFUL_MANAGEMENT_TOKEN}}`);
      const type = t.name === 'contentful_patch_entry' ? 'application/json-patch+json' : CMA_TYPE;
      expect(`${t.name}:${t.endpointMapping.headers?.['Content-Type']}`).toBe(`${t.name}:${type}`);
      expect(t.description).toContain('CONTENTFUL_MANAGEMENT_TOKEN');
    }
  });

  it('needs the management variables only for management tools', () => {
    expect(a.requiredEnvVars).toEqual(['CONTENTFUL_SPACE_ID', 'CONTENTFUL_ENVIRONMENT', 'CONTENTFUL_DELIVERY_URL', 'CONTENTFUL_DELIVERY_TOKEN']);
    expect(a.optionalEnvVars).toEqual(['CONTENTFUL_MANAGEMENT_URL', 'CONTENTFUL_MANAGEMENT_TOKEN']);
    // Without the management variables a read has nothing left to fill in,
    // while a write is stopped by the placeholder guard, naming them.
    const readOnly = { ...ENV, CONTENTFUL_MANAGEMENT_URL: undefined, CONTENTFUL_MANAGEMENT_TOKEN: undefined } as unknown as Record<string, string>;
    for (const t of a.tools) {
      const { config, endpointMapping } = interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, t.endpointMapping, readOnly);
      const left = findUnresolvedVariables({ baseUrl: config.baseUrl, endpointMapping }).sort();
      expect(`${t.name}:${left.join(',')}`).toBe(`${t.name}:${isManagement(t) ? 'CONTENTFUL_MANAGEMENT_TOKEN,CONTENTFUL_MANAGEMENT_URL' : ''}`);
    }
  });

  it('checks hosts and ids and marks both tokens secret', () => {
    const delivery = new RegExp(a.envVarMeta.CONTENTFUL_DELIVERY_URL.pattern!);
    for (const ok of ['https://cdn.contentful.com', 'https://preview.contentful.com', 'https://cdn.eu.contentful.com', 'https://preview.eu.contentful.com']) expect(delivery.test(ok)).toBe(true);
    expect(delivery.test('https://api.contentful.com')).toBe(false);
    expect(delivery.test('https://cdn.contentful.com/')).toBe(false);
    const management = new RegExp(a.envVarMeta.CONTENTFUL_MANAGEMENT_URL.pattern!);
    expect(management.test('https://api.contentful.com')).toBe(true);
    expect(management.test('https://api.eu.contentful.com')).toBe(true);
    expect(management.test('https://cdn.contentful.com')).toBe(false);
    expect(new RegExp(a.envVarMeta.CONTENTFUL_ENVIRONMENT.pattern!).test('master')).toBe(true);
    const described = describeAdapterEnvVars(a as never);
    for (const name of ['CONTENTFUL_DELIVERY_TOKEN', 'CONTENTFUL_MANAGEMENT_TOKEN']) expect(described.find((d) => d.name === name)!.secret).toBe(true);
    expect(a.probe).toEqual({ tool: 'contentful_get_space' });
  });

  it('prefixes every tool with contentful_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^contentful_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only, publishing a confirmed write, and installs deletion switched off', () => {
    for (const t of a.tools) expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['contentful_delete_entry']);
    for (const name of ['contentful_publish_entry', 'contentful_unpublish_entry', 'contentful_delete_entry']) {
      expect(tool(name).description).toMatch(/confirm/i);
    }
    expect(annotationsOf(tool('contentful_unpublish_entry')).destructiveHint).toBe(true);
    expect(annotationsOf(tool('contentful_update_entry')).destructiveHint).toBe(true);
    expect(annotationsOf(tool('contentful_create_entry')).destructiveHint).toBe(false);
    expect(annotationsOf(tool('contentful_create_tag')).destructiveHint).toBe(false);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bcontentful_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bcontentful_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(8);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['contentful_get_space', {}, 'GET', 'https://cdn.contentful.com/spaces/space1'],
    ['contentful_list_content_types', {}, 'GET', `${CDA}/content_types`],
    ['contentful_get_content_type', { content_type_id: 'blogPost' }, 'GET', `${CDA}/content_types/blogPost`],
    ['contentful_list_entries', {}, 'GET', `${CDA}/entries`],
    ['contentful_get_entry', { entry_id: 'e1' }, 'GET', `${CDA}/entries/e1`],
    ['contentful_list_assets', {}, 'GET', `${CDA}/assets`],
    ['contentful_get_asset', { asset_id: 'a1' }, 'GET', `${CDA}/assets/a1`],
    ['contentful_list_locales', {}, 'GET', `${CDA}/locales`],
    ['contentful_list_tags', {}, 'GET', `${CDA}/tags`],
    ['contentful_list_spaces', {}, 'GET', 'https://api.contentful.com/spaces'],
    ['contentful_list_environments', {}, 'GET', 'https://api.contentful.com/spaces/space1/environments'],
    ['contentful_list_all_entries', {}, 'GET', `${CMA}/entries`],
    ['contentful_get_entry_for_editing', { entry_id: 'e1' }, 'GET', `${CMA}/entries/e1`],
    ['contentful_create_entry', { content_type: 'blogPost', fields: {} }, 'POST', `${CMA}/entries`],
    ['contentful_update_entry', { entry_id: 'e1', version: 3, fields: {} }, 'PUT', `${CMA}/entries/e1`],
    ['contentful_patch_entry', { entry_id: 'e1', version: 3, operations: [] }, 'PATCH', `${CMA}/entries/e1`],
    ['contentful_publish_entry', { entry_id: 'e1', version: 3 }, 'PUT', `${CMA}/entries/e1/published`],
    ['contentful_unpublish_entry', { entry_id: 'e1' }, 'DELETE', `${CMA}/entries/e1/published`],
    ['contentful_delete_entry', { entry_id: 'e1' }, 'DELETE', `${CMA}/entries/e1`],
    ['contentful_create_tag', { tag_id: 'news', name: 'News' }, 'PUT', `${CMA}/tags/news`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ method, url }));
    const expected = url.startsWith('https://api.') ? 'Bearer cma-token' : 'Bearer cda-token';
    expect(sent().headers.Authorization).toBe(expected);
  });

  it('passes field filters through as search parameters', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('contentful_list_entries', { content_type: 'blogPost', filters: 'fields.slug=hello&fields.date[gte]=2026-01-01', tags: 'news,launch', include: 2 });
    expect(sent().params).toEqual({
      content_type: 'blogPost',
      'fields.slug': 'hello',
      'fields.date[gte]': '2026-01-01',
      include: 2,
      'metadata.tags.sys.id[in]': 'news,launch',
      limit: 100,
    });
  });

  it('creates entries with the content type header and writes with the version header', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const fields = { title: { 'en-US': 'Hello' } };
    await call('contentful_create_entry', { content_type: 'blogPost', fields });
    expect(sent().headers['X-Contentful-Content-Type']).toBe('blogPost');
    expect(sent().data).toEqual({ fields });
    mockedAxios.mockClear();
    await call('contentful_update_entry', { entry_id: 'e1', version: 4, fields });
    expect(sent().headers['X-Contentful-Version']).toBe('4');
    expect(sent().data).toEqual({ fields });
    mockedAxios.mockClear();
    await call('contentful_publish_entry', { entry_id: 'e1', version: 5 });
    expect(sent().headers['X-Contentful-Version']).toBe('5');
  });

  it('sends JSON Patch operations as the bare array', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const operations = [{ op: 'replace', path: '/fields/title/en-US', value: 'New' }];
    await call('contentful_patch_entry', { entry_id: 'e1', version: 2, operations });
    expect(sent().data).toEqual(operations);
    expect(sent().headers['Content-Type']).toBe('application/json-patch+json');
  });

  it('creates tags with their id and visibility in sys', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('contentful_create_tag', { tag_id: 'news', name: 'News', visibility: 'public' });
    expect(sent().data).toEqual({ name: 'News', sys: { id: 'news', type: 'Tag', visibility: 'public' } });
  });
});

const SPACE = process.env.CONTENTFUL_SPACE_ID;
const DELIVERY_TOKEN = process.env.CONTENTFUL_DELIVERY_TOKEN;
const live = SPACE && DELIVERY_TOKEN ? describe : describe.skip;

live('contentful adapter: live API', () => {
  const env: Record<string, string> = {
    CONTENTFUL_SPACE_ID: SPACE as string,
    CONTENTFUL_ENVIRONMENT: process.env.CONTENTFUL_ENVIRONMENT || 'master',
    CONTENTFUL_DELIVERY_URL: process.env.CONTENTFUL_DELIVERY_URL || 'https://cdn.contentful.com',
    CONTENTFUL_DELIVERY_TOKEN: DELIVERY_TOKEN as string,
  };
  const managementToken = process.env.CONTENTFUL_MANAGEMENT_TOKEN;
  if (managementToken) {
    env.CONTENTFUL_MANAGEMENT_TOKEN = managementToken;
    env.CONTENTFUL_MANAGEMENT_URL = process.env.CONTENTFUL_MANAGEMENT_URL || 'https://api.contentful.com';
  }
  const write = process.env.CONTENTFUL_LIVE_WRITE === '1' && !!managementToken;
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, params);

  it('reads the space, content types, entries, assets, locales and tags', async () => {
    const space = await run('contentful_get_space');
    expect(space.sys.id).toBe(SPACE);
    const types = await run('contentful_list_content_types', { limit: 10 });
    expect(Array.isArray(types.items)).toBe(true);
    const entries = await run('contentful_list_entries', { limit: 3 });
    expect(Array.isArray(entries.items)).toBe(true);
    expect(typeof entries.total).toBe('number');
    if (entries.items.length) {
      const first = entries.items[0];
      expect((await run('contentful_get_entry', { entry_id: first.sys.id })).sys.id).toBe(first.sys.id);
      const typeId = first.sys.contentType.sys.id;
      expect((await run('contentful_get_content_type', { content_type_id: typeId })).sys.id).toBe(typeId);
      const filtered = await run('contentful_list_entries', { content_type: typeId, filters: `sys.id=${first.sys.id}`, include: 2 });
      expect(filtered.items.map((e: { sys: { id: string } }) => e.sys.id)).toEqual([first.sys.id]);
      const searched = await run('contentful_list_entries', { content_type: typeId, select: 'sys.id', order: '-sys.createdAt', limit: 2 });
      expect(searched.items.length).toBeGreaterThan(0);
    }
    const assets = await run('contentful_list_assets', { limit: 3 });
    expect(Array.isArray(assets.items)).toBe(true);
    if (assets.items.length) {
      const asset = await run('contentful_get_asset', { asset_id: assets.items[0].sys.id });
      expect(asset.sys.id).toBe(assets.items[0].sys.id);
    }
    const images = await run('contentful_list_assets', { mimetype_group: 'image', limit: 1 });
    expect(Array.isArray(images.items)).toBe(true);
    const locales = await run('contentful_list_locales');
    expect(locales.items.some((l: { default: boolean }) => l.default)).toBe(true);
    const tags = await run('contentful_list_tags');
    expect(Array.isArray(tags.items)).toBe(true);
  }, 90_000);

  (managementToken ? it : it.skip)('reads spaces, environments and entries with drafts through the management API', async () => {
    const spaces = await run('contentful_list_spaces', { limit: 5 });
    expect(Array.isArray(spaces.items)).toBe(true);
    const environments = await run('contentful_list_environments');
    expect(environments.items.map((e: { sys: { id: string } }) => e.sys.id)).toContain(env.CONTENTFUL_ENVIRONMENT);
    const all = await run('contentful_list_all_entries', { limit: 3 });
    expect(Array.isArray(all.items)).toBe(true);
    if (all.items.length) {
      const one = await run('contentful_get_entry_for_editing', { entry_id: all.items[0].sys.id });
      expect(typeof one.sys.version).toBe('number');
    }
  }, 60_000);

  (write ? it : it.skip)('creates, changes, publishes, unpublishes and deletes an entry and creates a tag', async () => {
    const suffix = Date.now().toString(36);
    const typeId = `anythingmcpTest${suffix}`;
    const tagId = `anythingmcpTest${suffix}`;
    const cma = `${env.CONTENTFUL_MANAGEMENT_URL}/spaces/${SPACE}/environments/${env.CONTENTFUL_ENVIRONMENT}`;
    const direct = (method: string, path: string, data?: unknown, headers: Record<string, string> = {}) =>
      mockedAxios.__actual({ method, url: `${cma}${path}`, data, headers: { Authorization: `Bearer ${managementToken}`, 'Content-Type': CMA_TYPE, ...headers } });
    const locale = (await run('contentful_list_locales')).items.find((l: { default: boolean }) => l.default).code;

    const created = await direct('PUT', `/content_types/${typeId}`, {
      name: 'AnythingMCP test',
      displayField: 'title',
      fields: [
        { id: 'title', name: 'Title', type: 'Symbol', localized: false, required: true },
        { id: 'summary', name: 'Summary', type: 'Text', localized: false, required: false },
      ],
    });
    await direct('PUT', `/content_types/${typeId}/published`, undefined, { 'X-Contentful-Version': String(created.data.sys.version) });
    let entryId: string | undefined;
    let tagCreated = false;
    try {
      const entry = await run('contentful_create_entry', { content_type: typeId, fields: { title: { [locale]: 'AnythingMCP live spec' } } });
      entryId = entry.sys.id;
      expect(entry.sys.version).toBe(1);
      const read = await run('contentful_get_entry_for_editing', { entry_id: entryId });
      const updated = await run('contentful_update_entry', {
        entry_id: entryId,
        version: read.sys.version,
        fields: { title: { [locale]: 'AnythingMCP live spec (updated)' } },
      });
      expect(updated.fields.title[locale]).toBe('AnythingMCP live spec (updated)');
      const patched = await run('contentful_patch_entry', {
        entry_id: entryId,
        version: updated.sys.version,
        operations: [{ op: 'add', path: '/fields/summary', value: { [locale]: 'Patched' } }],
      });
      expect(patched.fields.summary[locale]).toBe('Patched');
      const published = await run('contentful_publish_entry', { entry_id: entryId, version: patched.sys.version });
      expect(published.sys.publishedVersion).toBe(patched.sys.version);
      // The delivery API can take a moment to see a new publication.
      let delivered: any;
      for (let i = 0; i < 10 && !delivered; i++) {
        delivered = await run('contentful_get_entry', { entry_id: entryId }).catch(() => undefined);
        if (!delivered) await new Promise((r) => setTimeout(r, 1000));
      }
      if (env.CONTENTFUL_DELIVERY_URL.includes('cdn')) expect(delivered?.fields.summary).toBe('Patched');
      const unpublished = await run('contentful_unpublish_entry', { entry_id: entryId });
      expect(unpublished.sys.publishedVersion).toBeUndefined();

      const tag = await run('contentful_create_tag', { tag_id: tagId, name: 'AnythingMCP test', visibility: 'public' });
      tagCreated = true;
      expect(tag.sys.id).toBe(tagId);

      await run('contentful_delete_entry', { entry_id: entryId });
      entryId = undefined;
    } finally {
      if (entryId) {
        await direct('DELETE', `/entries/${entryId}/published`).catch(() => undefined);
        await direct('DELETE', `/entries/${entryId}`).catch(() => undefined);
      }
      if (tagCreated) {
        const tag = await direct('GET', `/tags/${tagId}`);
        await direct('DELETE', `/tags/${tagId}`, undefined, { 'X-Contentful-Version': String(tag.data.sys.version) });
      }
      await direct('DELETE', `/content_types/${typeId}/published`);
      await direct('DELETE', `/content_types/${typeId}`);
    }
  }, 120_000);
});
