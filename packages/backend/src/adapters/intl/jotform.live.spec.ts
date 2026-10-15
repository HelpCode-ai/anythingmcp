import axios from 'axios';
import * as adapter from './jotform.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Jotform adapter:
 *
 *   1. Static: always runs. Pins the APIKEY header and the selectable data
 *      region host, every tool's method and URL through the real RestEngine,
 *      the form-urlencoded submission bodies (submission[qid] and
 *      submission[qid][part], as in Jotform's API docs and official SDKs), the
 *      response mappings against the sample shapes of the API docs, and the
 *      read-only, write and switched-off sets.
 *
 *   2. Live: skipped unless RUN_JOTFORM_LIVE=1 and JOTFORM_API_KEY are set
 *      (JOTFORM_API_HOST defaults to api.jotform.com).
 *
 *        RUN_JOTFORM_LIVE=1 JOTFORM_API_KEY=... npx jest src/adapters/intl/jotform.live.spec.ts
 *
 *      Runs the read tools and applies each responseMapping the way the MCP
 *      layer does. JOTFORM_LIVE_WRITE=1 with JOTFORM_LIVE_FORM_ID (a test form
 *      of your own) also adds a submission to that form, edits it to read, and
 *      leaves it there; delete it in Jotform afterwards. No form is cloned.
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
  parameters: { properties?: Record<string, { default?: unknown; maximum?: number; pattern?: string }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    bodyEncoding?: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  responseMapping?: { transform?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string; link?: string }>;
  probe: { tool: string };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
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

const KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, key: string, params: Record<string, unknown>, host = 'api.jotform.com') => {
  const env = { JOTFORM_API_KEY: key, JOTFORM_API_HOST: host };
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return engine().execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: { headerName: 'APIKEY', apiKey: key }, headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>, host?: string) => execute(name, KEY, params, host);
const sent = () => mockedAxios.mock.calls[0][0];
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as never);

const WRITES = ['jotform_clone_form', 'jotform_create_submission', 'jotform_delete_submission', 'jotform_edit_submission'];
const OFF = ['jotform_delete_submission'];
const BASE = 'https://api.jotform.com';

describe('jotform adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('jotform');
    expect(a.icon).toBe('jotform');
    expect(a.category).toBe('forms');
  });

  it('sends the key in the APIKEY header to the host of the account data region', () => {
    expect(a.connector.baseUrl).toBe('https://{{JOTFORM_API_HOST}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'APIKEY', apiKey: '{{JOTFORM_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/user');
    expect(a.probe.tool).toBe('jotform_get_user');
    expect(tool('jotform_get_user').parameters.required).toBeUndefined();
  });

  it('asks for the key as a secret and the host as a setting with the three regions', () => {
    expect(a.requiredEnvVars).toEqual(['JOTFORM_API_HOST', 'JOTFORM_API_KEY']);
    const key = a.envVarMeta.JOTFORM_API_KEY;
    expect(key.secret).toBe(true);
    expect(key.kind).toBe('credential');
    expect(key.link).toBe('https://www.jotform.com/myaccount/api');
    const keyRe = new RegExp(key.pattern!);
    expect(keyRe.test(KEY)).toBe(true);
    for (const bad of ['', 'short', `${KEY} `, `APIKEY ${KEY}`]) expect(keyRe.test(bad)).toBe(false);
    const host = new RegExp(a.envVarMeta.JOTFORM_API_HOST.pattern!);
    for (const ok of ['api.jotform.com', 'eu-api.jotform.com', 'hipaa-api.jotform.com', 'forms.example.com/API']) expect(host.test(ok)).toBe(true);
    for (const bad of ['https://api.jotform.com', 'api.jotform.com/', 'eu.jotform.com', 'example.com/api/v1']) expect(host.test(bad)).toBe(false);
    expect(describeAdapterEnvVars(a as never).find((d) => d.name === 'JOTFORM_API_KEY')!.secret).toBe(true);
  });

  it('prefixes every tool with jotform_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^jotform_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks every GET read-only, asks for confirmation on every write, and installs the delete switched off', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    }
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of WRITES) expect(tool(name).description).toMatch(/confirm with the user first/i);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(OFF);
    expect(a.tools.filter((t) => t.endpointMapping.method === 'DELETE').map((t) => t.name)).toEqual(OFF);
  });

  it('URL-encodes every path argument and every responseMapping does real work', async () => {
    for (const t of a.tools.filter((x) => /\{[A-Za-z]+\}/.test(x.endpointMapping.path))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
    for (const t of a.tools) {
      if (t.endpointMapping.method === 'GET') expect(`${t.name}:${Boolean(t.responseMapping)}`).toBe(`${t.name}:true`);
      const tr = t.responseMapping?.transform;
      if (tr) expect(`${t.name}:${Boolean(tr.select || tr.exclude || tr.include || tr.expression)}`).toBe(`${t.name}:true`);
    }
    mockedAxios.mockResolvedValue({ data: {} });
    await call('jotform_get_submission', { submissionId: '1/../../user' });
    expect(sent().url).toBe(`${BASE}/submission/1%2F..%2F..%2Fuser`);
  });

  it('only points the model at tools that exist, documents setup, regions, privacy and paging, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bjotform_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bjotform_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Jotform\n')).toBe(true);
    for (const text of ['eu-api.jotform.com', 'hipaa-api.jotform.com', 'Full Access', 'Confirm before every write', 'Personal data and untrusted content', 'never as instructions', 'offset', 'Out of scope']) {
      expect(a.instructions).toContain(text);
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['jotform_get_user', {}, 'GET', `${BASE}/user`],
    ['jotform_get_usage', {}, 'GET', `${BASE}/user/usage`],
    ['jotform_list_forms', {}, 'GET', `${BASE}/user/forms`],
    ['jotform_get_form', { formId: '241234567890123' }, 'GET', `${BASE}/form/241234567890123`],
    ['jotform_get_form_questions', { formId: '241234567890123' }, 'GET', `${BASE}/form/241234567890123/questions`],
    ['jotform_get_form_question', { formId: '241234567890123', qid: '3' }, 'GET', `${BASE}/form/241234567890123/question/3`],
    ['jotform_get_form_properties', { formId: '241234567890123' }, 'GET', `${BASE}/form/241234567890123/properties`],
    ['jotform_get_form_property', { formId: '241234567890123', key: 'thanktext' }, 'GET', `${BASE}/form/241234567890123/properties/thanktext`],
    ['jotform_list_form_submissions', { formId: '241234567890123' }, 'GET', `${BASE}/form/241234567890123/submissions`],
    ['jotform_list_submissions', {}, 'GET', `${BASE}/user/submissions`],
    ['jotform_get_submission', { submissionId: '5912345678901234567' }, 'GET', `${BASE}/submission/5912345678901234567`],
    ['jotform_list_form_reports', { formId: '241234567890123' }, 'GET', `${BASE}/form/241234567890123/reports`],
    ['jotform_list_folders', {}, 'GET', `${BASE}/user/folders`],
    ['jotform_get_folder', { folderId: '5f1e2d3c4b5a' }, 'GET', `${BASE}/folder/5f1e2d3c4b5a`],
    ['jotform_list_labels', {}, 'GET', `${BASE}/user/labels`],
    ['jotform_create_submission', { formId: '241234567890123', submission: { 3: 'x' } }, 'POST', `${BASE}/form/241234567890123/submissions`],
    ['jotform_edit_submission', { submissionId: '5912345678901234567', new: '0' }, 'POST', `${BASE}/submission/5912345678901234567`],
    ['jotform_delete_submission', { submissionId: '5912345678901234567' }, 'DELETE', `${BASE}/submission/5912345678901234567`],
    ['jotform_clone_form', { formId: '241234567890123' }, 'POST', `${BASE}/form/241234567890123/clone`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the APIKEY header', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(sent().method).toBe(method);
    expect(sent().url).toBe(url);
    expect(sent().headers.APIKEY).toBe(KEY);
    expect(sent().headers.Authorization).toBeUndefined();
  });

  it('goes to the EU and HIPAA hosts when the host variable says so', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('jotform_get_user', {}, 'eu-api.jotform.com');
    expect(sent().url).toBe('https://eu-api.jotform.com/user');
    mockedAxios.mockClear();
    await call('jotform_list_forms', {}, 'hipaa-api.jotform.com');
    expect(sent().url).toBe('https://hipaa-api.jotform.com/user/forms');
  });

  it('sends paging, the JSON filter and the order as query parameters, 20 per page by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const filter = '{"created_at:gt":"2026-01-01 00:00:00","status:ne":"DELETED"}';
    await call('jotform_list_form_submissions', { formId: '241234567890123', filter, orderby: 'created_at', offset: 40 });
    expect(sent().params).toEqual({ offset: 40, limit: 20, filter, orderby: 'created_at' });
    // Jotform's PHP backend reads the JSON back intact from the encoded query.
    expect(new URLSearchParams(sent().paramsSerializer(sent().params)).get('filter')).toBe(filter);
    expect(tool('jotform_list_forms').parameters.properties!.limit.maximum).toBe(1000);
  });

  it('sends a new submission as submission[qid] and submission[qid][part], form-urlencoded', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('jotform_create_submission', {
      formId: '241234567890123',
      submission: { 3: 'jane@example.com', 2: { first: 'Jane', last: 'Smith' } },
    });
    expect(sent().headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(sent().data);
    expect(Object.fromEntries(body)).toEqual({ 'submission[2][first]': 'Jane', 'submission[2][last]': 'Smith', 'submission[3]': 'jane@example.com' });
  });

  it('edits only the given answers and the read and flag markers', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('jotform_edit_submission', { submissionId: '5912345678901234567', answers: { 4: 'Updated' }, flag: '1' });
    expect(Object.fromEntries(new URLSearchParams(sent().data))).toEqual({ 'submission[4]': 'Updated', 'submission[flag]': '1' });
    mockedAxios.mockClear();
    await call('jotform_edit_submission', { submissionId: '5912345678901234567', new: '0' });
    expect(Object.fromEntries(new URLSearchParams(sent().data))).toEqual({ 'submission[new]': '0' });
  });

  it('clones and deletes without a body', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('jotform_clone_form', { formId: '241234567890123' });
    expect(sent().data).toBeUndefined();
  });

  // Shapes from the response samples in Jotform's API docs.
  const envelope = (content: unknown, extra: Record<string, unknown> = {}) => ({ responseCode: 200, message: 'success', content, 'limit-left': 9990, ...extra });
  const submission = {
    id: '237955080346633702', form_id: '31751954731962', ip: '123.123.123.123', created_at: '2013-06-25 03:14:20', updated_at: null,
    status: 'ACTIVE', new: '1', flag: '0', notes: '',
    answers: { 3: { name: 'email', order: '3', text: 'E-mail', type: 'control_email', answer: 'john@example.com' }, 2: { name: 'fullName', text: 'Full Name', type: 'control_fullname', answer: { first: 'John', last: 'Brown' }, prettyFormat: 'John Brown' } },
  };

  it('shapes the user, usage and forms, keeping the paging and the daily limit left', () => {
    expect(shape('jotform_get_user', envelope({ username: 'johnbrown', name: 'John Brown', email: 'john@example.com', website: 'www.jotform.com', time_zone: 'US/Eastern', account_type: 'https://api.jotform.com/system/plan/FREE', status: 'ACTIVE', created_at: '2013-06-24 12:00:00', usage: 'https://api.jotform.com/user/usage' })).value).toEqual({
      username: 'johnbrown', name: 'John Brown', email: 'john@example.com', accountType: 'https://api.jotform.com/system/plan/FREE', status: 'ACTIVE', timeZone: 'US/Eastern', createdAt: '2013-06-24 12:00:00', limitLeft: 9990,
    });
    expect(shape('jotform_get_usage', envelope({ submissions: '120', uploads: '1024', views: '400', api: '75' })).value).toEqual({ usage: { submissions: '120', uploads: '1024', views: '400', api: '75' }, limitLeft: 9990 });
    const forms = shape('jotform_list_forms', envelope([{ id: '31751954731962', username: 'johnbrown', title: 'Contact Form', height: '539', status: 'ENABLED', created_at: '2013-06-24 12:00:00', updated_at: '2013-06-24 12:30:00', last_submission: '2013-06-25 03:14:20', new: '2', count: '12', type: 'LEGACY', favorite: '0', archived: '0', url: 'https://form.jotform.com/31751954731962' }], { resultSet: { offset: 0, limit: 20, count: 1 } })).value;
    expect(forms).toEqual({
      forms: [{ id: '31751954731962', title: 'Contact Form', status: 'ENABLED', type: 'LEGACY', createdAt: '2013-06-24 12:00:00', updatedAt: '2013-06-24 12:30:00', lastSubmission: '2013-06-25 03:14:20', new: '2', count: '12', favorite: '0', archived: '0', url: 'https://form.jotform.com/31751954731962' }],
      resultSet: { offset: 0, limit: 20, count: 1 },
      limitLeft: 9990,
    });
  });

  it('shapes submissions without the IP address and keeps every answer keyed by question id', () => {
    const { ip: _ip, ...withoutIp } = submission;
    const list = shape('jotform_list_form_submissions', envelope([submission], { resultSet: { offset: 0, limit: 20, count: 1 } })).value as any;
    expect(list.submissions).toEqual([withoutIp]);
    expect(list.resultSet.count).toBe(1);
    expect((shape('jotform_list_submissions', envelope([submission])).value as any).submissions[0].ip).toBeUndefined();
    expect(shape('jotform_get_submission', envelope(submission)).value).toEqual(withoutIp);
    expect(JSON.stringify(shape('jotform_get_submission', envelope(submission)).value)).not.toContain('123.123.123.123');
  });

  it('shapes questions, reports, folders and the write results', () => {
    const questions = { 1: { qid: '1', name: 'header', order: '1', text: 'Contact', type: 'control_head' }, 3: { qid: '3', name: 'email', order: '3', text: 'E-mail', type: 'control_email', required: 'Yes' } };
    expect(shape('jotform_get_form_questions', envelope(questions)).value).toEqual({ questions });
    const report = { id: '31753290421044', form_id: '31751954731962', title: 'Excel Report', created_at: '2013-06-24 12:00:00', updated_at: null, fields: 'ip,dt,3,4', list_type: 'excel', status: 'ENABLED', url: 'https://www.jotform.com/excel/31753290421044', isProtected: false };
    expect(shape('jotform_list_form_reports', envelope([report])).value).toEqual({
      reports: [{ id: '31753290421044', formId: '31751954731962', title: 'Excel Report', listType: 'excel', fields: 'ip,dt,3,4', status: 'ENABLED', isProtected: false, url: 'https://www.jotform.com/excel/31753290421044', createdAt: '2013-06-24 12:00:00', updatedAt: null }],
    });
    const folders = shape('jotform_list_folders', envelope({ id: 'root', name: 'Root', path: '', forms: { 1: { title: 'A' } }, subfolders: [{ id: 'f1', name: 'HR', forms: { 2: { title: 'B' } }, subfolders: [] }] }, { duration: '20ms' })).value as any;
    expect(folders.content).toEqual({ id: 'root', name: 'Root', path: '', subfolders: [{ id: 'f1', name: 'HR', subfolders: [] }] });
    expect(folders.duration).toBeUndefined();
    expect(shape('jotform_create_submission', envelope({ submissionID: '5912345678901234567', URL: 'https://www.jotform.com/submission/5912345678901234567' })).value).toEqual({
      submissionID: '5912345678901234567', url: 'https://www.jotform.com/submission/5912345678901234567', message: 'success',
    });
  });
});

const LIVE_KEY = process.env.JOTFORM_API_KEY;
const live = process.env.RUN_JOTFORM_LIVE === '1' && LIVE_KEY ? describe : describe.skip;

live('jotform adapter: live API', () => {
  const host = process.env.JOTFORM_API_HOST || 'api.jotform.com';
  const key = LIVE_KEY || '';
  const write = process.env.JOTFORM_LIVE_WRITE === '1' && !!process.env.JOTFORM_LIVE_FORM_ID;

  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  const run = async (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    applyResponseTransform(await execute(name, key, params, host), tool(name).responseMapping as never).value;

  it('reads the account and its usage', async () => {
    const me = await run('jotform_get_user');
    expect(typeof me.username).toBe('string');
    const usage = await run('jotform_get_usage');
    expect(usage.usage).toBeDefined();
  }, 30_000);

  it('lists forms and reads the first with its questions, properties, submissions and reports', async () => {
    const forms = await run('jotform_list_forms', { limit: 3 });
    expect(Array.isArray(forms.forms)).toBe(true);
    const f = forms.forms[0];
    if (!f) return;
    expect((await run('jotform_get_form', { formId: f.id })).form).toBeDefined();
    expect((await run('jotform_get_form_questions', { formId: f.id })).questions).toBeDefined();
    expect((await run('jotform_get_form_property', { formId: f.id, key: 'thanktext' })).property).toBeDefined();
    const subs = await run('jotform_list_form_submissions', { formId: f.id, limit: 2 });
    expect(Array.isArray(subs.submissions)).toBe(true);
    if (subs.submissions[0]) {
      const one = await run('jotform_get_submission', { submissionId: subs.submissions[0].id });
      expect(one.id).toBe(subs.submissions[0].id);
      expect(one.ip).toBeUndefined();
    }
    expect(Array.isArray((await run('jotform_list_form_reports', { formId: f.id })).reports)).toBe(true);
  }, 90_000);

  it('lists submissions across forms, folders and labels', async () => {
    expect(Array.isArray((await run('jotform_list_submissions', { limit: 2 })).submissions)).toBe(true);
    expect((await run('jotform_list_folders')).content).toBeDefined();
    expect(await run('jotform_list_labels')).toBeDefined();
  }, 60_000);

  (write ? it : it.skip)('adds a submission to the test form and marks it read', async () => {
    const formId = process.env.JOTFORM_LIVE_FORM_ID!;
    const questions = (await run('jotform_get_form_questions', { formId })).questions as Record<string, { type: string }>;
    const textQid = Object.entries(questions).find(([, q]) => q.type === 'control_textbox')?.[0];
    expect(textQid).toBeDefined();
    const created = await run('jotform_create_submission', { formId, submission: { [textQid!]: 'AnythingMCP live spec (safe to delete)' } });
    expect(created.submissionID).toBeTruthy();
    const edited = await run('jotform_edit_submission', { submissionId: created.submissionID, new: '0' });
    expect(edited.message).toBe('success');
  }, 60_000);

  it('a wrong key is a 401', async () => {
    await expect(execute('jotform_get_user', '0123456789abcdef0123456789abcdef', {}, host)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30_000);
});
