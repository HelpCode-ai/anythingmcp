import axios from 'axios';
import * as adapter from './gong.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { checkBaseUrlValue } from '../../common/base-url-variable.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Gong adapter:
 *
 *   1. Static: always runs. Pins HTTP Basic with access key and secret, the
 *      per-company base URL variable, every tool's method, URL, query and body
 *      through the real RestEngine, checked against Gong's OpenAPI document
 *      (gong.app.gong.io/ajax/settings/api/documentation/specs, fetched
 *      13 Oct 2026): the filter / contentSelector bodies of the POST reads,
 *      the stats filters, the CRM entity queries, Engage flows and tasks.
 *      Also which tools only read and that the erasure ships switched off.
 *
 *   2. Live: skipped unless RUN_GONG_LIVE=1. Without credentials it checks
 *      that Gong refuses wrong ones with 401 on the real routes (Gong checks
 *      credentials before routing). With GONG_API_BASE_URL, GONG_ACCESS_KEY
 *      and GONG_ACCESS_KEY_SECRET it reads workspaces, one page of users and
 *      the calls of the last 7 days (no AI credits are spent):
 *
 *        RUN_GONG_LIVE=1 GONG_API_BASE_URL=https://us-12345.api.gong.io GONG_ACCESS_KEY=... \
 *          GONG_ACCESS_KEY_SECRET=... npx jest src/adapters/intl/gong.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

// A company host as Gong shows it, with the trailing slash people paste.
const HOST = 'https://us-12345.api.gong.io';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'K' + 'X'.repeat(29);
const FAKE_SECRET = 'eyJ' + 'z'.repeat(40);
const ENV: Record<string, string> = { GONG_API_BASE_URL: `${HOST}/`, GONG_ACCESS_KEY: FAKE_KEY, GONG_ACCESS_KEY_SECRET: FAKE_SECRET };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = ['gong_assign_prospects_to_flow', 'gong_erase_data_for_email', 'gong_update_task'];

describe('gong adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until it has been tried with a real key', () => {
    expect(a.unlisted).toBe(true);
  });

  it('authenticates with access key and secret as HTTP Basic on the company base URL', () => {
    expect(a.category).toBe('crm');
    expect(a.icon).toBe('gong');
    expect(a.connector.baseUrl).toBe('{{GONG_API_BASE_URL}}');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{GONG_ACCESS_KEY}}', password: '{{GONG_ACCESS_KEY_SECRET}}' });
    expect(a.connector.healthcheckPath).toBe('/v2/workspaces');
    expect(a.requiredEnvVars).toEqual(['GONG_API_BASE_URL', 'GONG_ACCESS_KEY', 'GONG_ACCESS_KEY_SECRET']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.GONG_API_BASE_URL).toMatchObject({ kind: 'address', required: true });
    expect(meta.GONG_ACCESS_KEY).toMatchObject({ kind: 'credential', secret: true, required: true });
    expect(meta.GONG_ACCESS_KEY_SECRET).toMatchObject({ kind: 'credential', secret: true, required: true });
  });

  it('accepts Gong API hosts as pasted and refuses paths or other hosts', () => {
    const url = new RegExp(a.envVarMeta.GONG_API_BASE_URL.pattern!);
    for (const ok of ['https://api.gong.io', HOST, `${HOST}/`, 'us-12345.api.gong.io', 'https://company-17.api.gong.io']) expect(url.test(ok)).toBe(true);
    for (const bad of ['', `${HOST}/v2`, 'https://app.gong.io', 'https://api.gong.io.evil.example', 'http://api.gong.io', 'gong.io']) expect(url.test(bad)).toBe(false);
    // The save-time normaliser adds https:// to a bare host.
    expect(checkBaseUrlValue('us-12345.api.gong.io')).toEqual({ ok: true, value: HOST });
  });

  it('probes with the workspace list and explains wrong keys and wrong hosts', () => {
    expect(a.probe).toEqual({ tool: 'gong_list_workspaces' });
    for (const status of ['401', '403', '404', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['404']).toMatch(/base URL/);
  });

  it('prefixes every tool with gong_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^gong_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks every POST read as read-only, only three tools as writes, and ships the erasure switched off', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    expect(annotationsOf(tool('gong_erase_data_for_email'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(annotationsOf(tool('gong_assign_prospects_to_flow'))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['gong_erase_data_for_email']);
    for (const name of WRITES.filter((n) => n !== 'gong_erase_data_for_email')) expect(tool(name).description).toMatch(/confirm/i);
    expect(tool('gong_erase_data_for_email').description).toMatch(/confirms/);
  });

  it('only points the model at tools that exist, documents setup, credits and limits, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bgong_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgong_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('Ecosystem');
    expect(a.instructions).toMatch(/3 API calls per second and 10,000 per day/);
    expect(a.instructions).toMatch(/spend Gong AI credits/);
    expect(a.instructions).toMatch(/Out of scope/);
    for (const name of ['gong_ask_about_crm_entity', 'gong_get_crm_entity_brief']) expect(tool(name).description).toMatch(/Gong AI credits/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('carries valid response mappings', () => {
    for (const t of a.tools) {
      if (t.responseMapping?.transform) expect(validateTransform(t.responseMapping.transform)).toBeNull();
    }
  });

  const day = { from_date: '2026-10-01', to_date: '2026-10-08' };
  const entity = { workspace_id: 123, crm_entity_type: 'DEAL', crm_entity_id: '006Q', time_period: 'LAST_90DAYS' };
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['gong_list_workspaces', {}, 'GET', '/v2/workspaces'],
    ['gong_list_users', {}, 'GET', '/v2/users'],
    ['gong_get_user', { id: '42' }, 'GET', '/v2/users/42'],
    ['gong_list_calls', { from_date_time: '2026-10-01T00:00:00Z', to_date_time: '2026-10-08T00:00:00Z' }, 'GET', '/v2/calls'],
    ['gong_get_call', { id: '77' }, 'GET', '/v2/calls/77'],
    ['gong_get_call_details', { call_ids: ['77'] }, 'POST', '/v2/calls/extensive'],
    ['gong_get_call_transcripts', { call_ids: ['77'] }, 'POST', '/v2/calls/transcript'],
    ['gong_get_activity_stats', day, 'POST', '/v2/stats/activity/aggregate'],
    ['gong_get_activity_by_period', { ...day, aggregation_period: 'WEEK' }, 'POST', '/v2/stats/activity/aggregate-by-period'],
    ['gong_get_interaction_stats', day, 'POST', '/v2/stats/interaction'],
    ['gong_list_answered_scorecards', {}, 'POST', '/v2/stats/activity/scorecards'],
    ['gong_list_scorecards', {}, 'GET', '/v2/settings/scorecards'],
    ['gong_list_trackers', {}, 'GET', '/v2/settings/trackers'],
    ['gong_list_call_outcomes', {}, 'GET', '/v2/call-outcomes'],
    ['gong_list_library_folders', {}, 'GET', '/v2/library/folders'],
    ['gong_list_library_folder_calls', { folder_id: '5' }, 'GET', '/v2/library/folder-content'],
    ['gong_ask_about_crm_entity', { ...entity, question: 'Who decides?' }, 'GET', '/v2/entities/ask-entity'],
    ['gong_get_crm_entity_brief', { ...entity, brief_name: 'Deal brief' }, 'GET', '/v2/entities/get-brief'],
    ['gong_list_flows', { flow_owner_email: 'rep@example.com' }, 'GET', '/v2/flows'],
    ['gong_list_prospect_flows', { crm_prospect_ids: ['003A'] }, 'POST', '/v2/flows/prospects'],
    ['gong_assign_prospects_to_flow', { flow_id: '9', crm_prospect_ids: ['003A'], flow_instance_owner_email: 'rep@example.com' }, 'POST', '/v2/flows/prospects/assign'],
    ['gong_list_tasks', { user_id: '42' }, 'POST', '/v2/tasks'],
    ['gong_update_task', { task_id: 31, user_id: '42', status: 'DONE' }, 'PATCH', '/v2/tasks/31'],
    ['gong_find_data_for_email', { email_address: 'jane@example.com' }, 'GET', '/v2/data-privacy/data-for-email-address'],
    ['gong_erase_data_for_email', { email_address: 'jane@example.com' }, 'POST', '/v2/data-privacy/erase-data-for-email-address'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with Basic credentials', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${path}`);
    expect(req.auth).toEqual({ username: FAKE_KEY, password: FAKE_SECRET });
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('lists calls by date range with the documented query names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('gong_list_calls', { from_date_time: '2026-10-01T00:00:00Z', to_date_time: '2026-10-08T00:00:00Z', workspace_id: '3', cursor: 'c1' });
    expect(sent().params).toEqual({ fromDateTime: '2026-10-01T00:00:00Z', toDateTime: '2026-10-08T00:00:00Z', workspaceId: '3', cursor: 'c1' });
  });

  it('asks for parties and the AI brief, key points and highlights by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('gong_get_call_details', { call_ids: ['77', '78'] });
    expect(sent().data).toEqual({
      filter: { callIds: ['77', '78'] },
      contentSelector: {
        exposedFields: {
          parties: true,
          content: { brief: true, keyPoints: true, highlights: true },
          interaction: {},
          collaboration: {},
        },
      },
    });
    mockedAxios.mockClear();
    await call('gong_get_call_details', {
      from_date_time: '2026-10-01T00:00:00Z',
      to_date_time: '2026-10-02T00:00:00Z',
      primary_user_ids: ['42'],
      include_brief: false,
      include_topics: true,
      include_trackers: true,
      include_interaction: true,
      include_comments: true,
      context: 'Extended',
      cursor: 'c2',
    });
    expect(sent().data).toEqual({
      cursor: 'c2',
      filter: { fromDateTime: '2026-10-01T00:00:00Z', toDateTime: '2026-10-02T00:00:00Z', primaryUserIds: ['42'] },
      contentSelector: {
        context: 'Extended',
        exposedFields: {
          parties: true,
          content: { brief: false, keyPoints: true, highlights: true, topics: true, trackers: true },
          interaction: { speakers: true, questions: true, personInteractionStats: true },
          collaboration: { publicComments: true },
        },
      },
    });
  });

  it('builds transcript, stats and scorecard filters', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('gong_get_call_transcripts', { call_ids: ['77'] });
    expect(sent().data).toEqual({ filter: { callIds: ['77'] } });
    mockedAxios.mockClear();
    await call('gong_get_activity_by_period', { ...day, user_ids: ['42'], aggregation_period: 'MONTH' });
    expect(sent().data).toEqual({ filter: { fromDate: '2026-10-01', toDate: '2026-10-08', userIds: ['42'] }, aggregationPeriod: 'MONTH' });
    mockedAxios.mockClear();
    await call('gong_list_answered_scorecards', { review_from_date: '2026-09-01', review_method: 'BOTH', scorecard_ids: ['8'] });
    expect(sent().data).toEqual({ filter: { reviewFromDate: '2026-09-01', reviewMethod: 'BOTH', scorecardIds: ['8'] } });
  });

  it('asks about CRM entities with the documented query and enums', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('gong_ask_about_crm_entity', { ...entity, time_period: 'CUSTOM_RANGE', from_date_time: '2026-07-01T00:00:00Z', question: 'Who decides?' });
    expect(sent().params).toEqual({
      workspaceId: 123,
      crmEntityType: 'DEAL',
      crmEntityId: '006Q',
      timePeriod: 'CUSTOM_RANGE',
      fromDateTime: '2026-07-01T00:00:00Z',
      question: 'Who decides?',
    });
    expect(sent().data).toBeUndefined();
    expect(tool('gong_get_crm_entity_brief').parameters.properties!.crm_entity_type.enum).toEqual(['ACCOUNT', 'DEAL', 'CONTACT', 'LEAD']);
  });

  it('builds Engage task and flow bodies, and erases by query parameter', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('gong_list_tasks', { user_id: '42' });
    expect(sent().data).toEqual({ filter: { userId: '42', status: ['OPEN'], types: ['FLOW', 'MANUAL'], taskAction: ['CALL'] } });
    mockedAxios.mockClear();
    await call('gong_update_task', { task_id: 31, user_id: '42', due_date: '2026-10-20T10:00:00Z', has_specific_time: true });
    expect(sent().data).toEqual({ userId: '42', dueDate: '2026-10-20T10:00:00Z', hasSpecificTime: true });
    mockedAxios.mockClear();
    await call('gong_assign_prospects_to_flow', { flow_id: '9', crm_prospect_ids: ['003A', '003B'], flow_instance_owner_email: 'rep@example.com', overrides: { coolOffOverride: true } });
    expect(sent().data).toEqual({ flowId: '9', crmProspectsIds: ['003A', '003B'], flowInstanceOwnerEmail: 'rep@example.com', overrides: { coolOffOverride: true } });
    mockedAxios.mockClear();
    await call('gong_erase_data_for_email', { email_address: 'jane@example.com' });
    expect(sent().params).toEqual({ emailAddress: 'jane@example.com' });
  });

  it('keeps the transcript shape and caps its size', () => {
    const raw = {
      requestId: 'r',
      records: { totalRecords: 1, currentPageSize: 1, currentPageNumber: 0 },
      callTranscripts: [{ callId: '77', transcript: [{ speakerId: 's1', topic: 'Pricing', sentences: [{ start: 0, end: 900, text: 'Hello' }] }] }],
    };
    const out = applyResponseTransform(raw, tool('gong_get_call_transcripts').responseMapping as any);
    expect(out.value).toEqual({ records: raw.records, callTranscripts: raw.callTranscripts });
    expect(tool('gong_get_call_transcripts').responseMapping!.transform.maxBytes).toBeGreaterThan(100000);
  });
});

const live = process.env.RUN_GONG_LIVE === '1' ? describe : describe.skip;
live('gong adapter: live', () => {
  const real = process.env.GONG_ACCESS_KEY && process.env.GONG_ACCESS_KEY_SECRET;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  const wrong = { ...ENV, GONG_API_BASE_URL: 'https://api.gong.io' };
  it.each([
    ['gong_list_workspaces', {}],
    ['gong_list_calls', { from_date_time: '2026-10-01T00:00:00Z', to_date_time: '2026-10-02T00:00:00Z' }],
    ['gong_get_call_details', { call_ids: ['1'] }],
    ['gong_get_call_transcripts', { call_ids: ['1'] }],
    ['gong_get_interaction_stats', { from_date: '2026-10-01', to_date: '2026-10-02' }],
    ['gong_update_task', { task_id: 1, user_id: '1' }],
  ])('%s reaches Gong and is refused with wrong credentials (401)', async (name, params) => {
    await expect(call(name, params, wrong)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (real ? it : it.skip)('reads workspaces, users and the calls of the last 7 days', async () => {
    const env = {
      GONG_API_BASE_URL: process.env.GONG_API_BASE_URL || 'https://api.gong.io',
      GONG_ACCESS_KEY: process.env.GONG_ACCESS_KEY!,
      GONG_ACCESS_KEY_SECRET: process.env.GONG_ACCESS_KEY_SECRET!,
    };
    const ws = await call('gong_list_workspaces', {}, env);
    expect(Array.isArray(ws.workspaces)).toBe(true);
    const users = await call('gong_list_users', {}, env);
    expect(Array.isArray(users.users)).toBe(true);
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 86400000);
    try {
      const calls = await call('gong_list_calls', { from_date_time: from.toISOString(), to_date_time: to.toISOString() }, env);
      expect(calls.records).toBeDefined();
    } catch (e: any) {
      // Gong answers 404 "No calls found" for an empty range.
      expect(e.response?.status).toBe(404);
    }
  }, 60000);
});
