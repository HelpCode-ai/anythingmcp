import axios from 'axios';
import * as adapter from './moodle.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Moodle Web Services (REST protocol) adapter.
 *
 * Static checks always run: the site address variable, the token and JSON
 * format in the query, one web service function per tool, how lists and
 * name/value options are written for PHP (courseids[]=1, options[0][name]=...),
 * flags as 0/1 instead of true/false, the form body of the message tool, and
 * the rules that turn Moodle's HTTP 200 error bodies into failed calls. The
 * parameter shapes were confirmed against Moodle 5.3 on the public demo site
 * school.moodledemo.net.
 * https://docs.moodle.org/en/Using_web_services
 *
 * Live checks run only with RUN_MOODLE_LIVE=1. Without credentials they
 * confirm on Moodle's public sandbox that a wrong token answers HTTP 200 with
 * errorcode invalidtoken; with MOODLE_URL and MOODLE_TOKEN they read the site
 * info. Reads only.
 *
 *   RUN_MOODLE_LIVE=1 MOODLE_URL=https://... MOODLE_TOKEN=... \
 *     npx jest src/adapters/intl/moodle.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
    AxiosHeaders: actual.AxiosHeaders,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; type?: string; pattern?: string; default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    bodyEncoding?: string;
    envDefaults?: Record<string, string>;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
  responseMapping?: { transform?: { exclude?: string[] } };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  instructions: string;
  aliases?: string[];
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean; options?: Array<{ value: string; label: string }> }>;
  verifyHints: Record<string, unknown>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
    config?: { errorWhen?: unknown };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({ name: entry.name, connectorType: 'REST', endpointMapping: entry.endpointMapping, annotations: entry.annotations });
// Every argument a mapping reads: {path} parts, "$name" values and ${name} in strings.
const used = (entry: Tool) => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (/^\$\w+$/.test(v)) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};

const ENV: Record<string, string> = {
  MOODLE_URL: 'https://moodle.myschool.org',
  MOODLE_TOKEN: '0123456789abcdef0123456789abcdef',
};

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  const tokens = { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService;
  return new RestEngine(tokens, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: cfg.headers,
      errorWhen: a.connector.config?.errorWhen,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (data: unknown = {}, status = 200) => mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
// The query string as it goes over the wire, percent-decoded for reading.
const wire = (req: { params: Record<string, unknown>; paramsSerializer: (p: Record<string, unknown>) => string }) =>
  decodeURIComponent(req.paramsSerializer(req.params));

// name, HTTP method, web service function
const TOOLS: Array<[string, string, string]> = [
  ['moodle_get_site_info', 'GET', 'core_webservice_get_site_info'],
  ['moodle_list_my_courses', 'GET', 'core_course_get_enrolled_courses_by_timeline_classification'],
  ['moodle_list_user_courses', 'GET', 'core_enrol_get_users_courses'],
  ['moodle_list_courses', 'GET', 'core_course_get_courses'],
  ['moodle_get_courses_by_field', 'GET', 'core_course_get_courses_by_field'],
  ['moodle_search_courses', 'GET', 'core_course_search_courses'],
  ['moodle_get_course_contents', 'GET', 'core_course_get_contents'],
  ['moodle_list_categories', 'GET', 'core_course_get_categories'],
  ['moodle_list_enrolled_users', 'GET', 'core_enrol_get_enrolled_users'],
  ['moodle_get_users_by_field', 'GET', 'core_user_get_users_by_field'],
  ['moodle_search_users', 'GET', 'core_user_get_users'],
  ['moodle_get_grade_items', 'GET', 'gradereport_user_get_grade_items'],
  ['moodle_get_course_grades_overview', 'GET', 'gradereport_overview_get_course_grades'],
  ['moodle_get_completion_status', 'GET', 'core_completion_get_activities_completion_status'],
  ['moodle_list_assignments', 'GET', 'mod_assign_get_assignments'],
  ['moodle_list_assignment_submissions', 'GET', 'mod_assign_get_submissions'],
  ['moodle_list_quizzes', 'GET', 'mod_quiz_get_quizzes_by_courses'],
  ['moodle_list_calendar_events', 'GET', 'core_calendar_get_calendar_events'],
  ['moodle_list_upcoming_deadlines', 'GET', 'core_calendar_get_action_events_by_timesort'],
  ['moodle_list_forums', 'GET', 'mod_forum_get_forums_by_courses'],
  ['moodle_list_forum_discussions', 'GET', 'mod_forum_get_forum_discussions'],
  ['moodle_get_discussion_posts', 'GET', 'mod_forum_get_discussion_posts'],
  ['moodle_list_conversations', 'GET', 'core_message_get_conversations'],
  ['moodle_send_message', 'POST', 'core_message_send_instant_messages'],
];
const REQUIRED: Record<string, string[]> = {
  moodle_list_user_courses: ['user_id'],
  moodle_get_courses_by_field: ['field', 'value'],
  moodle_search_courses: ['query'],
  moodle_get_course_contents: ['course_id'],
  moodle_list_enrolled_users: ['course_id'],
  moodle_get_users_by_field: ['field', 'values'],
  moodle_search_users: ['key', 'value'],
  moodle_get_grade_items: ['course_id'],
  moodle_get_completion_status: ['course_id', 'user_id'],
  moodle_list_assignment_submissions: ['assignment_ids'],
  moodle_list_forum_discussions: ['forum_id'],
  moodle_get_discussion_posts: ['discussion_id'],
  moodle_list_conversations: ['user_id'],
  moodle_send_message: ['to_user_id', 'text'],
};
const OFF: string[] = [];

describe('moodle adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('calls the REST server of the site with the token and JSON format in the query', () => {
    expect(a.slug).toBe('moodle');
    expect(a.region).toBe('intl');
    expect(a.icon).toBe('moodle');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{MOODLE_URL}}');
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ wstoken: '{{MOODLE_TOKEN}}', moodlewsrestformat: 'json' });
    expect(a.requiredEnvVars).toEqual(['MOODLE_URL', 'MOODLE_TOKEN']);
    expect(a.envVarMeta.MOODLE_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.MOODLE_URL).toMatchObject({ kind: 'address' });
    const url = new RegExp(a.envVarMeta.MOODLE_URL.pattern!);
    for (const good of ['https://moodle.myschool.org', 'https://myschool.org/moodle', 'http://lms.intranet:8080']) expect(url.test(good)).toBe(true);
    for (const bad of ['', 'moodle.myschool.org', 'https://moodle.myschool.org/', 'https://myschool.org/moodle/', 'https://x.org/webservice/rest/server.php?a=1']) expect(url.test(bad)).toBe(false);
    const token = new RegExp(a.envVarMeta.MOODLE_TOKEN.pattern!);
    expect(token.test(ENV.MOODLE_TOKEN)).toBe(true);
    expect(token.test('wstoken=abc')).toBe(false);
    for (const entry of a.tools) expect(entry.endpointMapping.path).toBe('/webservice/rest/server.php');
    expect(a.probe).toEqual({ tool: 'moodle_get_site_info', params: {} });
    for (const key of ['401', '403', '404', 'unreachable']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('maps Moodle error bodies to statuses and never offers a true/false flag', () => {
    const rules = a.connector.config?.errorWhen as Array<{ path: string; in?: string[]; status: number }>;
    expect(rules.map((rule) => rule.status)).toEqual([401, 403, 404, 400]);
    expect(rules[0].in).toContain('invalidtoken');
    expect(rules[1].in).toEqual(expect.arrayContaining(['accessexception', 'nopermissions']));
    expect(rules[3].path).toBe('exception');
    // Moodle refuses the words true and false for a flag: every flag is 0 or 1.
    for (const entry of a.tools) {
      for (const [param, def] of Object.entries(entry.parameters.properties ?? {})) expect([entry.name, param, def.type === 'boolean']).toEqual([entry.name, param, false]);
    }
    // Only the message tool writes, and the site info leaves the function list out.
    expect(a.tools.filter((entry) => entry.endpointMapping.method !== 'GET').map((entry) => entry.name)).toEqual(['moodle_send_message']);
    expect(tool('moodle_get_site_info').responseMapping?.transform?.exclude).toEqual(expect.arrayContaining(['functions']));
  });

  it('pins every tool to its documented method and web service function', () => {
    expect(a.tools.map((entry) => [entry.name, entry.endpointMapping.method, String(entry.endpointMapping.queryParams?.wsfunction)])).toEqual(TOOLS);
  });

  it('requires exactly the documented parameters', () => {
    for (const entry of a.tools) expect([entry.name, entry.parameters.required ?? []]).toEqual([entry.name, REQUIRED[entry.name] ?? []]);
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^moodle_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect([entry.name, arg, declared.has(arg) || envNames.has(arg)]).toEqual([entry.name, arg, true]);
      for (const arg of declared) expect([entry.name, arg, used(entry).has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const [param, def] of Object.entries(entry.parameters.properties ?? {})) expect([param, Boolean(def.description)]).toEqual([param, true]);
      expect(entry.description.length).toBeGreaterThan(60);
    }
  });

  it('marks reads read-only and installs only the listed tools switched off', () => {
    for (const entry of a.tools) {
      const read = entry.endpointMapping.method === 'GET';
      expect([entry.name, annotationsOf(entry).readOnlyHint]).toEqual([entry.name, read]);
    }
    expect(a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name).sort()).toEqual([...OFF].sort());
  });

  it('names every tool in the instructions and keeps the text free of MDX traps', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    const outsideCode = (text: string) => text.replace(/`[^`]*`/g, '');
    for (const text of [a.instructions, ...a.tools.map((entry) => entry.description)]) {
      expect(outsideCode(text)).not.toMatch(/[{}<]/);
      expect(text).not.toMatch(/\u2014/);
    }
  });

  it('writes lists and options the way PHP reads them', async () => {
    const auth = `wstoken=${ENV.MOODLE_TOKEN}&moodlewsrestformat=json`;

    ok({ courses: [], warnings: [] });
    await call('moodle_list_assignments', { course_ids: [59, 72] });
    const req = sent();
    expect(req.url).toBe('https://moodle.myschool.org/webservice/rest/server.php');
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Accept')).toBe('application/json');
    expect(wire(req)).toBe(`${auth}&wsfunction=mod_assign_get_assignments&courseids[]=59&courseids[]=72&includenotenrolledcourses=0`);

    ok([]);
    await call('moodle_list_courses', { course_ids: [59, 72] });
    expect(wire(sent())).toBe(`${auth}&wsfunction=core_course_get_courses&options[ids][0]=59&options[ids][1]=72`);

    ok([]);
    await call('moodle_list_courses', {});
    expect(wire(sent())).toBe(`${auth}&wsfunction=core_course_get_courses`);

    ok([]);
    await call('moodle_get_course_contents', { course_id: 72, exclude_contents: 1, filter_name: 'sectionnumber', filter_value: '1' });
    expect(wire(sent())).toBe(
      `${auth}&wsfunction=core_course_get_contents&courseid=72` +
        '&options[0][name]=excludemodules&options[0][value]=0' +
        '&options[1][name]=excludecontents&options[1][value]=1' +
        '&options[2][name]=sectionnumber&options[2][value]=1',
    );

    // Without the optional filter no half-filled option is sent: Moodle refuses a name without a value.
    ok([]);
    await call('moodle_get_course_contents', { course_id: 72 });
    expect(wire(sent())).toBe(
      `${auth}&wsfunction=core_course_get_contents&courseid=72` +
        '&options[0][name]=excludemodules&options[0][value]=0&options[1][name]=excludecontents&options[1][value]=0',
    );

    ok([]);
    await call('moodle_list_enrolled_users', { course_id: 72, limit: 2 });
    expect(wire(sent())).toBe(
      `${auth}&wsfunction=core_enrol_get_enrolled_users&courseid=72` +
        '&options[0][name]=limitnumber&options[0][value]=2&options[1][name]=limitfrom&options[1][value]=0' +
        '&options[2][name]=onlyactive&options[2][value]=0&options[3][name]=groupid&options[3][value]=0' +
        '&options[4][name]=sortby&options[4][value]=lastname&options[5][name]=sortdirection&options[5][value]=ASC' +
        '&options[6][name]=userfields&options[6][value]=id,username,fullname,email,idnumber,department,lastaccess,lastcourseaccess,roles,groups',
    );

    ok([]);
    await call('moodle_get_users_by_field', { field: 'email', values: ['anna@school.org', 'ben@school.org'] });
    expect(wire(sent())).toBe(`${auth}&wsfunction=core_user_get_users_by_field&field=email&values[]=anna@school.org&values[]=ben@school.org`);

    ok({ users: [], warnings: [] });
    await call('moodle_search_users', { key: 'lastname', value: '%mueller%' });
    expect(wire(sent())).toBe(`${auth}&wsfunction=core_user_get_users&criteria[0][key]=lastname&criteria[0][value]=%mueller%`);

    ok([]);
    await call('moodle_list_categories', {});
    expect(wire(sent())).toBe(`${auth}&wsfunction=core_course_get_categories&addsubcategories=1`);

    ok({ events: [], warnings: [] });
    await call('moodle_list_calendar_events', { course_ids: [72], time_start: 1790000000 });
    expect(wire(sent())).toBe(
      `${auth}&wsfunction=core_calendar_get_calendar_events&events[courseids][0]=72` +
        '&options[userevents]=1&options[siteevents]=1&options[timestart]=1790000000&options[ignorehidden]=1',
    );

    ok({ assignments: [], warnings: [] });
    await call('moodle_list_assignment_submissions', { assignment_ids: [145], status: 'submitted' });
    expect(wire(sent())).toBe(`${auth}&wsfunction=mod_assign_get_submissions&assignmentids[]=145&status=submitted`);

    ok({ statuses: [], warnings: [] });
    await call('moodle_get_completion_status', { course_id: 72, user_id: 56 });
    expect(wire(sent())).toBe(`${auth}&wsfunction=core_completion_get_activities_completion_status&courseid=72&userid=56`);
  });

  it('sends a message as a form body', async () => {
    ok([{ msgid: 5, errormessage: '' }]);
    await call('moodle_send_message', { to_user_id: 57, text: 'Hello there' });
    const req = sent();
    expect(String(req.method).toUpperCase()).toBe('POST');
    expect(req.url).toBe('https://moodle.myschool.org/webservice/rest/server.php');
    expect(req.params).toEqual({ wstoken: ENV.MOODLE_TOKEN, moodlewsrestformat: 'json', wsfunction: 'core_message_send_instant_messages' });
    expect(header(req, 'Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(String(req.data)))).toEqual({ 'messages[0][touserid]': '57', 'messages[0][text]': 'Hello there' });
  });

  it('turns an error that Moodle answers with HTTP 200 into a failed call', async () => {
    ok({ exception: 'core\\exception\\moodle_exception', errorcode: 'invalidtoken', message: 'Invalid token - token not found' });
    await expect(call('moodle_get_site_info', {})).rejects.toThrow(/Invalid token/);

    ok({ exception: 'invalid_parameter_exception', errorcode: 'invalidparameter', message: 'Invalid parameter value detected' });
    await expect(call('moodle_list_quizzes', { course_ids: [1] })).rejects.toThrow(/Invalid parameter value detected/);

    ok({ exception: 'required_capability_exception', errorcode: 'nopermissions', message: 'Sorry, but you do not currently have permissions to do that (Review course enrolments).' });
    await expect(call('moodle_list_enrolled_users', { course_id: 72 })).rejects.toThrow(/permissions/);

    // Ordinary answers pass untouched: a list, and an object with warnings.
    ok([{ id: 1, name: 'Announcements' }]);
    await expect(call('moodle_list_forums', {})).resolves.toEqual([{ id: 1, name: 'Announcements' }]);
    ok({ quizzes: [], warnings: [{ item: 'course', warningcode: '1' }] });
    await expect(call('moodle_list_quizzes', {})).resolves.toEqual({ quizzes: [], warnings: [{ item: 'course', warningcode: '1' }] });
  });
});

// Opt-in: RUN_MOODLE_LIVE=1. The first check uses Moodle's public sandbox and
// needs no account; the read needs MOODLE_URL and MOODLE_TOKEN. Nothing is
// written.
const live = process.env.RUN_MOODLE_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('moodle: live', () => {
  it('answers a wrong token with HTTP 200 and errorcode invalidtoken', async () => {
    const response = await liveFetch.get('https://sandbox.moodledemo.net/webservice/rest/server.php', {
      params: { wstoken: 'invalid', wsfunction: 'core_webservice_get_site_info', moodlewsrestformat: 'json' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
    expect(response.data.errorcode).toBe('invalidtoken');
  });

  it('reads the site info', async () => {
    const site = process.env.MOODLE_URL;
    const token = process.env.MOODLE_TOKEN;
    if (!site || !token) return;
    const response = await liveFetch.get(`${site}/webservice/rest/server.php`, {
      params: { wstoken: token, wsfunction: 'core_webservice_get_site_info', moodlewsrestformat: 'json' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
    expect(response.data.exception).toBeUndefined();
    expect(typeof response.data.userid).toBe('number');
  });
});
