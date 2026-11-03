import axios from 'axios';
import * as adapter from './crowdin.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

/**
 * Crowdin API v2 (support.crowdin.com/developer/api/v2/, OpenAPI
 * support.crowdin.com/src/assets/api/crowdin/file-based.yml and .../enterprise/file-based.yml):
 * base https://<host>/api/v2 with host api.crowdin.com or <organization>.api.crowdin.com, personal
 * access token as Bearer, limit/offset paging, JSON Patch edits, asynchronous reports and builds.
 * Live part (reads only: user, projects, languages, TMs, glossaries, first project's progress and files):
 *   CROWDIN_PERSONAL_ACCESS_TOKEN=... CROWDIN_API_HOST=api.crowdin.com RUN_CROWDIN_LIVE=1 npx jest src/adapters/intl/crowdin
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
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; headers?: Record<string, string> };
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
const PREFIX = 'crowdin_';
const P = '/projects/{project_id}';
// Built at runtime so no literal looks like a real credential.
const TOKEN = ['test', 'z'.repeat(60)].join('');
const ENV: Record<string, string> = { CROWDIN_PERSONAL_ACCESS_TOKEN: TOKEN, CROWDIN_API_HOST: 'acme.api.crowdin.com' };
const call = (name: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, tool(name).endpointMapping, ENV);
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, ENV), headers: config.headers } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  ) as Promise<unknown>;
};
const sent = () => mockedAxios.mock.calls[0][0];
const READ_POSTS = ['crowdin_generate_report', 'crowdin_build_project_translations', 'crowdin_export_project_translation', 'crowdin_search_tm'];

describe('crowdin adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the token as Bearer to crowdin.com or an Enterprise organization host', async () => {
    expect(a.requiredEnvVars).toEqual(['CROWDIN_PERSONAL_ACCESS_TOKEN', 'CROWDIN_API_HOST']);
    expect(a.connector.baseUrl).toBe('https://{{CROWDIN_API_HOST}}/api/v2');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{CROWDIN_PERSONAL_ACCESS_TOKEN}}' });
    expect(a.envVarMeta?.CROWDIN_PERSONAL_ACCESS_TOKEN.secret).toBe(true);
    const host = new RegExp(a.envVarMeta?.CROWDIN_API_HOST.pattern ?? '');
    for (const h of ['api.crowdin.com', 'acme.api.crowdin.com', 'my-org.api.crowdin.com']) expect(`${h}:${host.test(h)}`).toBe(`${h}:true`);
    for (const h of ['https://api.crowdin.com', 'crowdin.com', 'acme.crowdin.com', 'api.crowdin.com/api/v2', 'api.crowdin.com.evil.io']) expect(`${h}:${host.test(h)}`).toBe(`${h}:false`);
    mockedAxios.mockResolvedValue({ data: {} });
    await call('crowdin_get_authenticated_user', {});
    expect(sent().url).toBe('https://acme.api.crowdin.com/api/v2/user');
    expect(sent().headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('maps projects, files, strings and translations with the documented camelCase names', async () => {
    expect(tool('crowdin_list_projects').endpointMapping).toMatchObject({ path: '/projects', queryParams: { hasManagerAccess: '$has_manager_access', orderBy: '$order_by', limit: '$limit', offset: '$offset' } });
    expect(tool('crowdin_get_project').endpointMapping.path).toBe(P);
    expect(tool('crowdin_get_project_progress').endpointMapping).toMatchObject({ path: `${P}/languages/progress`, queryParams: { languageIds: '$language_ids' } });
    expect(tool('crowdin_get_file_progress').endpointMapping.path).toBe(`${P}/files/{file_id}/languages/progress`);
    expect(tool('crowdin_list_supported_languages').endpointMapping.path).toBe('/languages');
    expect(tool('crowdin_list_branches').endpointMapping.path).toBe(`${P}/branches`);
    expect(tool('crowdin_list_directories').endpointMapping.path).toBe(`${P}/directories`);
    expect(tool('crowdin_list_files').endpointMapping).toMatchObject({ path: `${P}/files`, queryParams: { branchId: '$branch_id', directoryId: '$directory_id', recursion: '$recursion' } });
    expect(tool('crowdin_get_file').endpointMapping.path).toBe(`${P}/files/{file_id}`);
    expect(tool('crowdin_download_file').endpointMapping).toEqual({ method: 'GET', path: `${P}/files/{file_id}/download` });
    expect(tool('crowdin_list_strings').endpointMapping).toMatchObject({ path: `${P}/strings`, queryParams: { fileId: '$file_id', labelIds: '$label_ids', croql: '$croql', scope: '$scope', denormalizePlaceholders: '$denormalize_placeholders' } });
    expect(tool('crowdin_get_string').endpointMapping.path).toBe(`${P}/strings/{string_id}`);
    expect(tool('crowdin_add_string').endpointMapping).toMatchObject({ method: 'POST', path: `${P}/strings`, bodyMapping: { fileId: '$file_id', text: '$text', identifier: '$identifier', maxLength: '$max_length' } });
    expect(tool('crowdin_list_translations').endpointMapping).toMatchObject({ path: `${P}/translations`, queryParams: { languageId: '$language_id', stringId: '$string_id' } });
    expect(tool('crowdin_list_translations').parameters?.required).toEqual(['project_id', 'language_id']);
    expect(tool('crowdin_get_translation').endpointMapping.path).toBe(`${P}/translations/{translation_id}`);
    expect(tool('crowdin_add_translation').endpointMapping).toMatchObject({ method: 'POST', path: `${P}/translations`, bodyMapping: { stringId: '$string_id', languageId: '$language_id', text: '$text', pluralCategoryName: '$plural_category_name' } });
    expect(tool('crowdin_list_approvals').endpointMapping.path).toBe(`${P}/approvals`);
    expect(tool('crowdin_approve_translation').endpointMapping).toEqual({ method: 'POST', path: `${P}/approvals`, bodyMapping: { translationId: '$translation_id' } });
    mockedAxios.mockResolvedValue({ data: {} });
    await call('crowdin_list_strings', { project_id: 12, file_id: 4, croql: 'text contains "cart"', limit: 100, offset: 200 });
    expect(sent().url).toBe('https://acme.api.crowdin.com/api/v2/projects/12/strings');
    expect(sent().params).toEqual({ fileId: 4, croql: 'text contains "cart"', limit: 100, offset: 200 });
  });

  it('sends JSON Patch operations as the request body', async () => {
    expect(tool('crowdin_edit_string').endpointMapping).toEqual({ method: 'PATCH', path: `${P}/strings/{string_id}`, queryParams: { updateOption: '$update_option' }, bodyMapping: { __raw: '$operations' } });
    expect(tool('crowdin_edit_task').endpointMapping).toEqual({ method: 'PATCH', path: `${P}/tasks/{task_id}`, bodyMapping: { __raw: '$operations' } });
    mockedAxios.mockResolvedValue({ data: {} });
    const ops = [{ op: 'replace', path: '/status', value: 'done' }];
    await call('crowdin_edit_task', { project_id: 12, task_id: 3, operations: ops });
    expect(sent().method).toBe('PATCH');
    expect(sent().url).toBe('https://acme.api.crowdin.com/api/v2/projects/12/tasks/3');
    expect(sent().data).toEqual(ops);
  });

  it('maps comments, tasks, reports, builds, TMs, glossaries and members', () => {
    expect(tool('crowdin_list_comments').endpointMapping).toMatchObject({ path: `${P}/comments`, queryParams: { issueType: '$issue_type', issueStatus: '$issue_status' } });
    expect(tool('crowdin_add_comment').endpointMapping).toMatchObject({ method: 'POST', path: `${P}/comments`, bodyMapping: { stringId: '$string_id', text: '$text', type: '$type', targetLanguageId: '$target_language_id', issueType: '$issue_type' } });
    expect(tool('crowdin_list_tasks').endpointMapping.path).toBe(`${P}/tasks`);
    expect(tool('crowdin_get_task').endpointMapping.path).toBe(`${P}/tasks/{task_id}`);
    expect(tool('crowdin_create_task').endpointMapping).toMatchObject({ method: 'POST', path: `${P}/tasks`, bodyMapping: { title: '$title', languageId: '$language_id', type: '$type', workflowStepId: '$workflow_step_id', fileIds: '$file_ids', assignees: '$assignees', deadline: '$deadline' } });
    expect(tool('crowdin_generate_report').endpointMapping).toEqual({ method: 'POST', path: `${P}/reports`, bodyMapping: { name: '$name', schema: '$schema' } });
    expect(tool('crowdin_generate_report').parameters?.properties?.name.enum).toContain('costs-estimation-pe');
    expect(tool('crowdin_get_report_status').endpointMapping.path).toBe(`${P}/reports/{report_id}`);
    expect(tool('crowdin_download_report').endpointMapping.path).toBe(`${P}/reports/{report_id}/download`);
    expect(tool('crowdin_build_project_translations').endpointMapping).toMatchObject({ method: 'POST', path: `${P}/translations/builds`, bodyMapping: { targetLanguageIds: '$target_language_ids', branchId: '$branch_id' } });
    expect(tool('crowdin_get_build_status').endpointMapping.path).toBe(`${P}/translations/builds/{build_id}`);
    expect(tool('crowdin_download_build').endpointMapping.path).toBe(`${P}/translations/builds/{build_id}/download`);
    expect(tool('crowdin_export_project_translation').endpointMapping).toMatchObject({ method: 'POST', path: `${P}/translations/exports`, bodyMapping: { targetLanguageId: '$target_language_id', format: '$format' } });
    expect(tool('crowdin_list_tms').endpointMapping.path).toBe('/tms');
    expect(tool('crowdin_get_tm').endpointMapping.path).toBe('/tms/{tm_id}');
    expect(tool('crowdin_list_tm_segments').endpointMapping.path).toBe('/tms/{tm_id}/segments');
    expect(tool('crowdin_search_tm').endpointMapping).toMatchObject({ method: 'POST', path: `${P}/tms/concordance`, bodyMapping: { sourceLanguageId: '$source_language_id', expressions: '$expressions', minRelevant: '$min_relevant', autoSubstitution: '$auto_substitution' } });
    expect(tool('crowdin_add_tm_segment').endpointMapping).toEqual({ method: 'POST', path: '/tms/{tm_id}/segments', bodyMapping: { records: '$records' } });
    expect(tool('crowdin_list_glossaries').endpointMapping.path).toBe('/glossaries');
    expect(tool('crowdin_get_glossary').endpointMapping.path).toBe('/glossaries/{glossary_id}');
    expect(tool('crowdin_list_glossary_terms').endpointMapping).toMatchObject({ path: '/glossaries/{glossary_id}/terms', queryParams: { languageId: '$language_id', conceptId: '$concept_id' } });
    expect(tool('crowdin_add_glossary_term').endpointMapping).toMatchObject({ method: 'POST', path: '/glossaries/{glossary_id}/terms', bodyMapping: { languageId: '$language_id', text: '$text', partOfSpeech: '$part_of_speech', translationOfTermId: '$translation_of_term_id' } });
    expect(tool('crowdin_list_members').endpointMapping.path).toBe(`${P}/members`);
    expect(tool('crowdin_get_member').endpointMapping.path).toBe(`${P}/members/{member_id}`);
  });

  it('marks the read-only POSTs and ships no delete tool', () => {
    for (const t of a.tools) {
      const readPost = READ_POSTS.includes(t.name);
      expect(`${t.name}:${t.annotations?.readOnlyHint === true}`).toBe(`${t.name}:${readPost}`);
      if (readPost) expect(t.endpointMapping.method).toBe('POST');
      expect(t.endpointMapping.method).not.toBe('DELETE');
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
    }
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

const env = process.env;
const live = env.RUN_CROWDIN_LIVE === '1' && env.CROWDIN_PERSONAL_ACCESS_TOKEN && env.CROWDIN_API_HOST ? describe : describe.skip;
live('crowdin adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await mockedAxios.__actual.get(`https://${env.CROWDIN_API_HOST}/api/v2${path}`, { headers: { Authorization: `Bearer ${env.CROWDIN_PERSONAL_ACCESS_TOKEN}` }, validateStatus: () => true });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return res.data as { data: unknown };
  };
  it('reads the user, projects, languages, TMs, glossaries and the first project', async () => {
    expect((await get('/user')).data).toBeDefined();
    const projects = (await get('/projects?limit=1')).data as Array<{ data: { id: number } }>;
    expect(Array.isArray((await get('/languages?limit=5')).data)).toBe(true);
    expect(Array.isArray((await get('/tms?limit=1')).data)).toBe(true);
    expect(Array.isArray((await get('/glossaries?limit=1')).data)).toBe(true);
    if (projects[0]) {
      const id = projects[0].data.id;
      expect(Array.isArray((await get(`/projects/${id}/languages/progress`)).data)).toBe(true);
      expect(Array.isArray((await get(`/projects/${id}/files?limit=2`)).data)).toBe(true);
    }
  }, 60_000);
});
