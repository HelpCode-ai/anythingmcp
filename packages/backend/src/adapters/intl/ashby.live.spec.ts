import axios from 'axios';
import * as adapter from './ashby.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Ashby adapter:
 *
 *   1. Static: always runs. Pins HTTP Basic with the API key as user name and
 *      an empty password, that every tool is a POST to an RPC endpoint
 *      (`/candidate.list`), the JSON bodies through the real RestEngine,
 *      checked against the OpenAPI definitions on developers.ashbyhq.com
 *      (API version 2026-01-01, fetched 13 Oct 2026), the errorWhen rules for
 *      Ashby's `success: false` answers (HTTP 200), which tools only read,
 *      and that the delete ships switched off.
 *
 *   2. Live: skipped unless RUN_ASHBY_LIVE=1. Without a key it checks that
 *      Ashby refuses a wrong one with 401 on the real routes. With
 *      ASHBY_API_KEY it reads the key info, one job and a candidate search
 *      for an address nobody has, and checks an unknown application id is
 *      reported as not found. Nothing is written:
 *
 *        RUN_ASHBY_LIVE=1 ASHBY_API_KEY=... npx jest src/adapters/intl/ashby.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[]; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyMapping?: Record<string, unknown>; headers?: Record<string, string> };
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
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
    config: { errorWhen: unknown[] };
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

const BASE = 'https://api.ashbyhq.com';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'ashby_test_' + 'x'.repeat(32);
const ENV: Record<string, string> = { ASHBY_API_KEY: FAKE_KEY };
const UUID = '3ae2b801-19f6-41ef-ad28-214bd731948f';

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call; the adapter's
// errorWhen rules applied as for an installed connector.
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
      errorWhen: a.connector.config.errorWhen,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = [
  'ashby_add_candidate_note',
  'ashby_add_candidate_tag',
  'ashby_change_application_stage',
  'ashby_create_application',
  'ashby_create_candidate',
  'ashby_delete_application',
  'ashby_transfer_application',
  'ashby_update_candidate',
];

describe('ashby adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until it has been tried with a real key', () => {
    expect(a.unlisted).toBe(true);
  });

  it('sends the API key as the Basic user name with an empty password, on api.ashbyhq.com', () => {
    expect(a.category).toBe('hr');
    expect(a.icon).toBe('ashby');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{ASHBY_API_KEY}}', password: '' });
    expect(a.connector.headers['Content-Type']).toBe('application/json');
    // Ashby has no GET endpoint; a wrong key is refused before routing, so
    // this path still tells a bad key from a good one (see the report).
    expect(a.connector.healthcheckPath).toBe('/apiKey.info');
    expect(a.requiredEnvVars).toEqual(['ASHBY_API_KEY']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'ASHBY_API_KEY', kind: 'credential', secret: true, required: true });
    const key = new RegExp(a.envVarMeta.ASHBY_API_KEY.pattern!);
    expect(key.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', `${FAKE_KEY} `, `Basic ${FAKE_KEY}`]) expect(key.test(bad)).toBe(false);
  });

  it('probes with one job and explains the documented auth errors', () => {
    expect(a.probe).toEqual({ tool: 'ashby_list_jobs', params: { limit: 1 } });
    for (const status of ['401', '403', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['403']).toMatch(/permission/);
  });

  it('prefixes every tool with ashby_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^ashby_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('calls every endpoint with POST on /<resource>.<verb>', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('POST');
      expect(t.endpointMapping.path).toMatch(/^\/[a-zA-Z]+\.[a-zA-Z]+$/);
      expect(t.endpointMapping.bodyMapping).toBeDefined();
    }
  });

  it('marks the POST reads read-only, says so to the model, and ships the delete switched off', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const t of a.tools.filter((x) => !WRITES.includes(x.name))) expect(t.description).toMatch(/only reads/);
    for (const name of WRITES) expect(tool(name).description).toMatch(/[Cc]onfirm/);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['ashby_delete_application']);
    expect(annotationsOf(tool('ashby_delete_application'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(annotationsOf(tool('ashby_create_candidate'))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('only points the model at tools that exist, documents setup and permissions, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bashby_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bashby_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('https://app.ashbyhq.com/admin/api/credentials');
    expect(a.instructions).toMatch(/milliseconds/);
    expect(a.instructions).toMatch(/success: false/);
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
    ['ashby_get_api_key_info', {}, '/apiKey.info', {}],
    ['ashby_search_candidates', { email: 'jane@example.com' }, '/candidate.search', { email: 'jane@example.com' }],
    ['ashby_list_candidates', { created_after: 1759276800000 }, '/candidate.list', { createdAfter: 1759276800000, limit: 25 }],
    ['ashby_get_candidate', { id: UUID }, '/candidate.info', { id: UUID }],
    ['ashby_list_candidate_notes', { candidate_id: UUID }, '/candidate.listNotes', { candidateId: UUID, limit: 25 }],
    ['ashby_list_applications', { job_id: UUID, status: 'Active', cursor: 'c1' }, '/application.list', { jobId: UUID, status: 'Active', limit: 25, cursor: 'c1' }],
    ['ashby_get_application', { application_id: UUID }, '/application.info', { applicationId: UUID }],
    ['ashby_list_application_history', { application_id: UUID }, '/application.listHistory', { applicationId: UUID, limit: 25 }],
    ['ashby_list_application_feedback', { application_id: UUID }, '/applicationFeedback.list', { applicationId: UUID, limit: 25 }],
    ['ashby_list_jobs', { status: ['Open'], expand: ['location'] }, '/job.list', { status: ['Open'], expand: ['location'], limit: 25 }],
    ['ashby_search_jobs', { title: 'Engineer' }, '/job.search', { title: 'Engineer' }],
    ['ashby_get_job', { id: UUID, expand: ['openings'] }, '/job.info', { id: UUID, expand: ['openings'] }],
    ['ashby_list_job_postings', { listed_only: true }, '/jobPosting.list', { listedOnly: true }],
    ['ashby_list_interview_plans', {}, '/interviewPlan.list', { limit: 25 }],
    ['ashby_list_interview_stages', { interview_plan_id: UUID }, '/interviewStage.list', { interviewPlanId: UUID }],
    ['ashby_list_interview_schedules', { application_id: UUID }, '/interviewSchedule.list', { applicationId: UUID, limit: 25 }],
    ['ashby_list_interview_events', { interview_schedule_id: UUID }, '/interviewEvent.list', { interviewScheduleId: UUID, limit: 25 }],
    ['ashby_list_interviews', {}, '/interview.list', { limit: 25 }],
    ['ashby_list_users', { include_deactivated: true }, '/user.list', { includeDeactivated: true, limit: 25 }],
    ['ashby_search_users', { email: 'recruiter@example.com' }, '/user.search', { email: 'recruiter@example.com' }],
    ['ashby_list_sources', {}, '/source.list', {}],
    ['ashby_list_archive_reasons', {}, '/archiveReason.list', {}],
    ['ashby_list_candidate_tags', {}, '/candidateTag.list', { limit: 25 }],
    ['ashby_list_offers', { application_id: UUID, acceptance_status: ['Pending'] }, '/offer.list', { applicationId: UUID, acceptanceStatus: ['Pending'], limit: 25 }],
    ['ashby_list_departments', {}, '/department.list', { limit: 25 }],
    ['ashby_list_locations', {}, '/location.list', { limit: 25 }],
    [
      'ashby_create_candidate',
      { name: 'Jane Doe', email: 'jane@example.com', linkedin_url: 'https://linkedin.com/in/jane', location: { city: 'Berlin', country: 'Germany' } },
      '/candidate.create',
      { name: 'Jane Doe', email: 'jane@example.com', linkedInUrl: 'https://linkedin.com/in/jane', location: { city: 'Berlin', country: 'Germany' } },
    ],
    ['ashby_update_candidate', { candidate_id: UUID, phone_number: '+49 30 1234' }, '/candidate.update', { candidateId: UUID, phoneNumber: '+49 30 1234' }],
    ['ashby_add_candidate_note', { candidate_id: UUID, note: 'Strong in Go.' }, '/candidate.createNote', { candidateId: UUID, note: { type: 'text/plain', value: 'Strong in Go.' } }],
    ['ashby_add_candidate_tag', { candidate_id: UUID, tag_id: UUID }, '/candidate.addTag', { candidateId: UUID, tagId: UUID }],
    ['ashby_create_application', { candidate_id: UUID, job_id: UUID, interview_stage_id: 'FirstPreInterviewScreen' }, '/application.create', { candidateId: UUID, jobId: UUID, interviewStageId: 'FirstPreInterviewScreen' }],
    [
      'ashby_change_application_stage',
      { application_id: UUID, interview_stage_id: UUID, archive_reason_id: UUID, archive_email: { communicationTemplateId: UUID } },
      '/application.changeStage',
      { applicationId: UUID, interviewStageId: UUID, archiveReasonId: UUID, archiveEmail: { communicationTemplateId: UUID } },
    ],
    [
      'ashby_transfer_application',
      { application_id: UUID, job_id: UUID, interview_plan_id: UUID, interview_stage_id: UUID, start_automatic_activities: false },
      '/application.transfer',
      { applicationId: UUID, jobId: UUID, interviewPlanId: UUID, interviewStageId: UUID, startAutomaticActivities: false },
    ],
    ['ashby_delete_application', { application_id: UUID }, '/application.delete', { applicationId: UUID }],
  ];

  it('lists every tool in the request table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s posts the documented JSON body to %s', async (name, params, path, body) => {
    mockedAxios.mockResolvedValue({ data: { success: true, results: [] } });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${BASE}${path}`);
    expect(req.auth).toEqual({ username: FAKE_KEY, password: '' });
    expect(req.data).toEqual(body);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('attributes a note to a user only when asked', async () => {
    mockedAxios.mockResolvedValue({ data: { success: true, results: {} } });
    await call('ashby_add_candidate_note', { candidate_id: UUID, note: '<b>Hi</b>', note_type: 'text/html' });
    expect(sent().headers).not.toHaveProperty('X-On-Behalf-Of');
    expect(sent().data.note).toEqual({ type: 'text/html', value: '<b>Hi</b>' });
    mockedAxios.mockClear();
    await call('ashby_add_candidate_note', { candidate_id: UUID, note: 'x', on_behalf_of_user_id: UUID });
    expect(sent().headers['X-On-Behalf-Of']).toBe(UUID);
  });

  it('turns Ashby errors sent with HTTP 200 into failed calls with the right class', async () => {
    mockedAxios.mockResolvedValue({
      data: { success: false, errorInfo: { code: 'application_not_found', message: 'Application not found', requestId: 'r1' } },
    });
    await expect(call('ashby_get_application', { application_id: UUID })).rejects.toMatchObject({ status: 404, message: expect.stringContaining('Application not found') });
    mockedAxios.mockResolvedValue({ data: { success: false, errorInfo: { code: 'missing_endpoint_permission', message: 'No permission' } } });
    await expect(call('ashby_list_offers', {})).rejects.toMatchObject({ status: 403 });
    mockedAxios.mockResolvedValue({ data: { success: false, errors: ['invalid_input'] } });
    await expect(call('ashby_create_candidate', { name: 'X' })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('invalid_input') });
    mockedAxios.mockResolvedValue({ data: { success: true, results: [], moreDataAvailable: false } });
    await expect(call('ashby_list_jobs', {})).resolves.toMatchObject({ success: true });
  });
});

const live = process.env.RUN_ASHBY_LIVE === '1' ? describe : describe.skip;
live('ashby adapter: live', () => {
  const realKey = process.env.ASHBY_API_KEY;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['ashby_get_api_key_info', {}],
    ['ashby_list_jobs', { limit: 1 }],
    ['ashby_search_candidates', { email: 'nobody@example.com' }],
    ['ashby_change_application_stage', { application_id: UUID, interview_stage_id: UUID }],
  ])('%s reaches Ashby and is refused with a wrong key (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (realKey ? it : it.skip)('reads the key, one job and an empty candidate search; reports an unknown application as not found', async () => {
    const env = { ASHBY_API_KEY: realKey! };
    const info = await call('ashby_get_api_key_info', {}, env);
    expect(info.success).toBe(true);
    const jobs = await call('ashby_list_jobs', { limit: 1 }, env);
    expect(Array.isArray(jobs.results)).toBe(true);
    const found = await call('ashby_search_candidates', { email: `nobody-${Date.now()}@example.com` }, env);
    expect(found.results).toEqual([]);
    await expect(call('ashby_get_application', { application_id: UUID }, env)).rejects.toMatchObject({ status: 404 });
  }, 60000);
});
