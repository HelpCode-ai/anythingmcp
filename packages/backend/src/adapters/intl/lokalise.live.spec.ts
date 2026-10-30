import axios from 'axios';
import * as adapter from './lokalise.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

/**
 * Lokalise API v2 (developers.lokalise.com/reference/lokalise-rest-api, OpenAPI
 * developers.lokalise.com/openapi/lokalise-api-without-branches.yml): base https://api.lokalise.com/api2,
 * token in X-Api-Token, limit/page paging with X-Pagination-* headers, cursor paging for keys and
 * translations, file exports as async processes.
 * Live part (reads only: projects, system languages, keys and languages of the first project):
 *   LOKALISE_API_TOKEN=... RUN_LOKALISE_LIVE=1 npx jest src/adapters/intl/lokalise
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
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; headers?: Record<string, string>; exposeHeaders?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean }>;
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
const PREFIX = 'lokalise_';
const P = '/projects/{project_id}';
// Built at runtime so no literal looks like a real credential.
const TOKEN = '0123456789abcdef'.repeat(3).slice(0, 40);
const ENV: Record<string, string> = { LOKALISE_API_TOKEN: TOKEN };
const call = (name: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, tool(name).endpointMapping, ENV);
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, ENV), headers: config.headers } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  ) as Promise<unknown>;
};
const sent = () => mockedAxios.mock.calls[0][0];

describe('lokalise adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the token in X-Api-Token to api.lokalise.com/api2', async () => {
    expect(a.requiredEnvVars).toEqual(['LOKALISE_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://api.lokalise.com/api2');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Api-Token', apiKey: '{{LOKALISE_API_TOKEN}}' });
    expect(a.envVarMeta?.LOKALISE_API_TOKEN.secret).toBe(true);
    const re = new RegExp(a.envVarMeta?.LOKALISE_API_TOKEN.pattern ?? '');
    expect(re.test(TOKEN)).toBe(true);
    expect(re.test(`Bearer ${TOKEN}`)).toBe(false);
    mockedAxios.mockResolvedValue({ data: {} });
    await call('lokalise_list_projects', { include_statistics: 1, limit: 10 });
    expect(sent().url).toBe('https://api.lokalise.com/api2/projects');
    expect(sent().headers['X-Api-Token']).toBe(TOKEN);
    expect(sent().params).toEqual({ include_statistics: 1, limit: 10 });
  });

  it('maps keys and translations with the documented filters and cursor paging', () => {
    expect(tool('lokalise_list_keys').endpointMapping).toMatchObject({
      method: 'GET',
      path: `${P}/keys`,
      queryParams: { filter_keys: '$filter_keys', filter_untranslated: '$filter_untranslated', include_translations: '$include_translations', filter_translation_lang_ids: '$filter_translation_lang_ids', pagination: '$pagination', cursor: '$cursor', limit: '$limit', page: '$page' },
      exposeHeaders: ['x-pagination-total-count', 'x-pagination-page-count', 'x-pagination-page', 'x-pagination-next-cursor'],
    });
    expect(tool('lokalise_get_key').endpointMapping.path).toBe(`${P}/keys/{key_id}`);
    expect(tool('lokalise_create_keys').endpointMapping).toEqual({ method: 'POST', path: `${P}/keys`, bodyMapping: { keys: '$keys', use_automations: '$use_automations' } });
    expect(tool('lokalise_bulk_update_keys').endpointMapping).toEqual({ method: 'PUT', path: `${P}/keys`, bodyMapping: { keys: '$keys', use_automations: '$use_automations' } });
    expect(tool('lokalise_list_translations').endpointMapping).toMatchObject({ path: `${P}/translations`, queryParams: { filter_lang_id: '$filter_lang_id', filter_is_reviewed: '$filter_is_reviewed', filter_active_task_id: '$filter_active_task_id' } });
    expect(tool('lokalise_update_translation').endpointMapping).toEqual({
      method: 'PUT',
      path: `${P}/translations/{translation_id}`,
      bodyMapping: { translation: '$translation', is_reviewed: '$is_reviewed', is_unverified: '$is_unverified', custom_translation_status_ids: '$custom_translation_status_ids' },
    });
  });

  it('sends a key or task update object as the body itself', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('lokalise_update_key', { project_id: 'p1.abc', key_id: 331223, key: { description: 'Cart', tags: ['cart'], merge_tags: true } });
    expect(sent().method).toBe('PUT');
    expect(sent().url).toBe('https://api.lokalise.com/api2/projects/p1.abc/keys/331223');
    expect(sent().data).toEqual({ description: 'Cart', tags: ['cart'], merge_tags: true });
    mockedAxios.mockClear();
    await call('lokalise_update_task', { project_id: 'p1.abc:feature', task_id: 7, task: { close_task: true } });
    expect(sent().url).toBe('https://api.lokalise.com/api2/projects/p1.abc:feature/tasks/7');
    expect(sent().data).toEqual({ close_task: true });
  });

  it('maps the other resources', () => {
    expect(tool('lokalise_get_project').endpointMapping.path).toBe(P);
    expect(tool('lokalise_list_project_languages').endpointMapping.path).toBe(`${P}/languages`);
    expect(tool('lokalise_add_languages').endpointMapping).toEqual({ method: 'POST', path: `${P}/languages`, bodyMapping: { languages: '$languages' } });
    expect(tool('lokalise_list_system_languages').endpointMapping.path).toBe('/system/languages');
    expect(tool('lokalise_list_contributors').endpointMapping.path).toBe(`${P}/contributors`);
    expect(tool('lokalise_get_contributor').endpointMapping.path).toBe(`${P}/contributors/{contributor_id}`);
    expect(tool('lokalise_get_my_contributor').endpointMapping.path).toBe(`${P}/contributors/me`);
    expect(tool('lokalise_add_contributors').endpointMapping.bodyMapping).toEqual({ contributors: '$contributors' });
    expect(tool('lokalise_list_tasks').endpointMapping).toMatchObject({ path: `${P}/tasks`, queryParams: { filter_title: '$filter_title', filter_statuses: '$filter_statuses' } });
    expect(tool('lokalise_get_task').endpointMapping.path).toBe(`${P}/tasks/{task_id}`);
    expect(tool('lokalise_create_task').endpointMapping).toMatchObject({ method: 'POST', path: `${P}/tasks`, bodyMapping: { title: '$title', keys: '$keys', languages: '$languages', task_type: '$task_type', due_date: '$due_date' } });
    expect(tool('lokalise_create_task').parameters?.properties?.task_type.enum).toEqual(['translation', 'automatic_translation', 'lqa_by_ai', 'review']);
    expect(tool('lokalise_list_files').endpointMapping.path).toBe(`${P}/files`);
    expect(tool('lokalise_download_files').endpointMapping).toMatchObject({ method: 'POST', path: `${P}/files/async-download`, bodyMapping: { format: '$format', original_filenames: '$original_filenames', filter_langs: '$filter_langs' } });
    expect(tool('lokalise_get_process').endpointMapping.path).toBe(`${P}/processes/{process_id}`);
    expect(tool('lokalise_list_project_comments').endpointMapping.path).toBe(`${P}/comments`);
    expect(tool('lokalise_list_key_comments').endpointMapping.path).toBe(`${P}/keys/{key_id}/comments`);
    expect(tool('lokalise_add_key_comments').endpointMapping).toEqual({ method: 'POST', path: `${P}/keys/{key_id}/comments`, bodyMapping: { comments: '$comments' } });
    expect(tool('lokalise_list_screenshots').endpointMapping.path).toBe(`${P}/screenshots`);
    expect(tool('lokalise_get_screenshot').endpointMapping.path).toBe(`${P}/screenshots/{screenshot_id}`);
    expect(tool('lokalise_list_branches').endpointMapping.path).toBe(`${P}/branches`);
    expect(tool('lokalise_create_branch').endpointMapping).toEqual({ method: 'POST', path: `${P}/branches`, bodyMapping: { name: '$name' } });
    expect(tool('lokalise_list_glossary_terms').endpointMapping).toMatchObject({ path: `${P}/glossary-terms`, queryParams: { limit: '$limit', cursor: '$cursor' } });
    expect(tool('lokalise_get_glossary_term').endpointMapping.path).toBe(`${P}/glossary-terms/{term_id}`);
    expect(tool('lokalise_create_glossary_terms').endpointMapping).toEqual({ method: 'POST', path: `${P}/glossary-terms`, bodyMapping: { terms: '$terms' } });
    expect(tool('lokalise_update_glossary_terms').endpointMapping).toEqual({ method: 'PUT', path: `${P}/glossary-terms`, bodyMapping: { terms: '$terms' } });
    expect(tool('lokalise_list_translation_statuses').endpointMapping.path).toBe(`${P}/custom_translation_statuses`);
  });

  it('marks the export POST read-only and switches off exactly the delete', () => {
    expect(tool('lokalise_download_files').annotations).toEqual({ readOnlyHint: true });
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name);
    expect(off).toEqual(['lokalise_delete_key']);
    expect(a.tools.filter((t) => t.endpointMapping.method === 'DELETE').map((t) => t.name)).toEqual(off);
    expect(tool('lokalise_delete_key').annotations?.destructiveHint).toBe(true);
    expect(a.instructions).toContain('**Switched off at install**: `lokalise_delete_key`; it cannot be undone');
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
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_LOKALISE_LIVE === '1' && process.env.LOKALISE_API_TOKEN ? describe : describe.skip;
live('lokalise adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await mockedAxios.__actual.get(`${a.connector.baseUrl}${path}`, { headers: { 'X-Api-Token': String(process.env.LOKALISE_API_TOKEN) }, validateStatus: () => true });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return res;
  };
  it('reads projects, system languages, and keys and languages of the first project', async () => {
    const projects = (await get('/projects?limit=1')).data.projects as Array<{ project_id: string }>;
    expect(Array.isArray(projects)).toBe(true);
    expect(Array.isArray((await get('/system/languages?limit=5')).data.languages)).toBe(true);
    if (projects[0]) {
      const keys = await get(`/projects/${projects[0].project_id}/keys?limit=2`);
      expect(Array.isArray(keys.data.keys)).toBe(true);
      expect(keys.headers['x-pagination-total-count']).toBeDefined();
      expect(Array.isArray((await get(`/projects/${projects[0].project_id}/languages`)).data.languages)).toBe(true);
    }
  }, 60_000);
});
