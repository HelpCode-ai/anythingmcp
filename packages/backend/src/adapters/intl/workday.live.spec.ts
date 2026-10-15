import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import * as adapter from './workday.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { PrismaService } from '../../common/prisma.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../env-var-meta';

/**
 * Two layers of verification for the Workday adapter (Workday REST API):
 *
 *   1. Static: always runs. Pins the refresh-token grant (client ID and secret
 *      as HTTP Basic at https://<host>/ccx/oauth2/<tenant>/token, the way an
 *      API client from "Register API Client for Integrations" works), the
 *      bearer header, and every tool's method, URL and query through the real
 *      RestEngine. Paths and parameters were checked on 15 Oct 2026 against
 *      Workday's REST API directory specifications (OAS2, build 20261003):
 *      staffing v7, common v1, absenceManagement v5 and recruiting v4.
 *      Every tool is a GET: the connector is read-only.
 *
 *   2. Live: skipped unless RUN_WORKDAY_LIVE=1.
 *      - With WORKDAY_HOST and WORKDAY_TENANT it checks that every route
 *        exists: a made-up token is refused with 401, while a made-up service
 *        answers 404 (Workday authenticates before it resolves the resource).
 *      - With WORKDAY_CLIENT_ID, WORKDAY_CLIENT_SECRET and
 *        WORKDAY_REFRESH_TOKEN as well it gets a real token and runs every
 *        tool once against the tenant. There are no write tools, so there is
 *        no second flag:
 *
 *        RUN_WORKDAY_LIVE=1 WORKDAY_HOST=wd2-impl-services1.workday.com WORKDAY_TENANT=... \
 *          WORKDAY_CLIENT_ID=... WORKDAY_CLIENT_SECRET=... WORKDAY_REFRESH_TOKEN=... \
 *          npx jest src/adapters/intl/workday.live.spec.ts
 *
 *      Use an implementation (sandbox) tenant where possible: the reads return
 *      real people's HR data.
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
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios; post: jest.Mock };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params: Record<string, unknown> };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath?: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const HOST = 'wd2-impl-services1.workday.com';
const TENANT = 'acme_preview';
const API = `https://${HOST}/ccx/api`;
const TOKEN_URL = `https://${HOST}/ccx/oauth2/${TENANT}/token`;
// Built at run time so no literal here looks like a real credential.
const CLIENT_ID = ['NzA1ZTk2', 'ZTQtN2U0'].join('');
const SECRET = ['s3cr3t', 'Va1ue', 'X9q'].join('');
const REFRESH = ['rt', '0'.repeat(20), 'z'].join('');
const ENV: Record<string, string> = {
  WORKDAY_HOST: HOST,
  WORKDAY_TENANT: TENANT,
  WORKDAY_CLIENT_ID: CLIENT_ID,
  WORKDAY_CLIENT_SECRET: SECRET,
  WORKDAY_REFRESH_TOKEN: REFRESH,
};
const WID = '3aa5550b7fe348b98d7b5741afc65534';

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>, env = ENV, tokens?: OAuth2TokenService) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  const tokenService = tokens ?? ({ getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService);
  return new RestEngine(tokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep({ ...a.connector.authConfig }, env),
      headers: config.headers,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const sent = () => mockedAxios.mock.calls[0][0];
const query = () => new URLSearchParams(sent().paramsSerializer(sent().params));

// [tool, params, path after /ccx/api, service spec it was checked against]
const table: Array<[string, Record<string, unknown>, string]> = [
  ['workday_search_workers', { search: 'Logan' }, `/staffing/v7/${TENANT}/workers`],
  ['workday_get_worker', { worker_id: WID }, `/staffing/v7/${TENANT}/workers/${WID}`],
  ['workday_list_direct_reports', { worker_id: WID }, `/common/v1/${TENANT}/workers/${WID}/directReports`],
  ['workday_list_supervisory_organizations', {}, `/staffing/v7/${TENANT}/supervisoryOrganizations`],
  ['workday_get_supervisory_organization', { organization_id: WID }, `/staffing/v7/${TENANT}/supervisoryOrganizations/${WID}`],
  ['workday_list_organization_members', { organization_id: WID }, `/staffing/v7/${TENANT}/supervisoryOrganizations/${WID}/members`],
  ['workday_list_organization_types', {}, `/common/v1/${TENANT}/organizationTypes`],
  ['workday_list_organizations', { organization_type: WID }, `/common/v1/${TENANT}/organizations`],
  ['workday_list_job_profiles', {}, `/staffing/v7/${TENANT}/jobProfiles`],
  ['workday_get_job_profile', { job_profile_id: WID }, `/staffing/v7/${TENANT}/jobProfiles/${WID}`],
  ['workday_list_jobs', {}, `/staffing/v7/${TENANT}/jobs`],
  ['workday_get_time_off_balances', { worker_id: WID }, `/absenceManagement/v5/${TENANT}/balances`],
  ['workday_list_time_off_entries', { worker_id: WID }, `/absenceManagement/v5/${TENANT}/workers/${WID}/timeOffDetails`],
  ['workday_list_leaves_of_absence', { worker_id: WID }, `/absenceManagement/v5/${TENANT}/workers/${WID}/leavesOfAbsence`],
  ['workday_list_job_postings', {}, `/recruiting/v4/${TENANT}/jobPostings`],
  ['workday_get_job_posting', { job_posting_id: WID }, `/recruiting/v4/${TENANT}/jobPostings/${WID}`],
];

describe('workday adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('workday');
    expect(a.category).toBe('hr');
    expect(a.icon).toBe('workday');
  });

  it('uses the refresh-token grant of an integration API client, no browser sign-in', () => {
    expect(a.connector.baseUrl).toBe('https://{{WORKDAY_HOST}}/ccx/api');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'refresh_token',
      tokenUrl: 'https://{{WORKDAY_HOST}}/ccx/oauth2/{{WORKDAY_TENANT}}/token',
      clientId: '{{WORKDAY_CLIENT_ID}}',
      clientSecret: '{{WORKDAY_CLIENT_SECRET}}',
      refreshToken: '{{WORKDAY_REFRESH_TOKEN}}',
      tokenAuthMethod: 'client_secret_basic',
    });
    expect(needsBrowserAuthorization(a as never)).toBe(false);
    // Every path carries the tenant, and healthcheckPath is not interpolated,
    // so the install check is the probe (it runs through the tool path).
    expect(a.connector.healthcheckPath).toBeUndefined();
    expect(a.probe).toEqual({ tool: 'workday_search_workers', params: { limit: 1 } });
  });

  it('sends client ID and secret as HTTP Basic with the refresh token in the form body', async () => {
    const service = new OAuth2TokenService(
      {} as PrismaService,
      { get: () => 'test-encryption-key-32-chars!!!!' } as unknown as ConfigService,
    );
    const post = jest.spyOn(mockedAxios, 'post').mockResolvedValue({ data: { access_token: 'wd.access', token_type: 'Bearer', refresh_token: REFRESH } });
    await expect(service.getAccessToken(interpolateDeep({ ...a.connector.authConfig }, ENV))).resolves.toBe('wd.access');
    const [url, body, options] = post.mock.calls[0] as [string, string, { headers: Record<string, string> }];
    expect(url).toBe(TOKEN_URL);
    expect(options.headers.Authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64')}`);
    const form = Object.fromEntries(new URLSearchParams(body));
    expect(form).toMatchObject({ grant_type: 'refresh_token', refresh_token: REFRESH });
    expect(form.client_secret).toBeUndefined();
    post.mockRestore();
  });

  it('describes the five variables and keeps the secret and refresh token secret', () => {
    expect(a.requiredEnvVars).toEqual(['WORKDAY_HOST', 'WORKDAY_TENANT', 'WORKDAY_CLIENT_ID', 'WORKDAY_CLIENT_SECRET', 'WORKDAY_REFRESH_TOKEN']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.WORKDAY_CLIENT_SECRET).toMatchObject({ kind: 'credential', secret: true, required: true });
    expect(meta.WORKDAY_REFRESH_TOKEN).toMatchObject({ kind: 'credential', secret: true, required: true });
    expect(meta.WORKDAY_HOST).toMatchObject({ kind: 'address', secret: false });
    const host = new RegExp(a.envVarMeta.WORKDAY_HOST.pattern!);
    for (const good of [HOST, 'wd5-services1.myworkday.com', 'services1.myworkday.com']) expect(host.test(good)).toBe(true);
    for (const bad of [`https://${HOST}`, `${HOST}/ccx/api`, 'localhost', '']) expect(host.test(bad)).toBe(false);
    const tenant = new RegExp(a.envVarMeta.WORKDAY_TENANT.pattern!);
    expect(tenant.test(TENANT)).toBe(true);
    expect(tenant.test('acme/token')).toBe(false);
    for (const key of ['401', '403', '404', '503']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool with workday_ and shares no tool name with another adapter file', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^workday_[a-z_]+$/);
    const root = path.join(__dirname, '..');
    for (const region of fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory())) {
      for (const file of fs.readdirSync(path.join(root, region)).filter((f) => f.endsWith('.json') && f !== 'workday.json')) {
        const other = JSON.parse(fs.readFileSync(path.join(root, region, file), 'utf8'));
        for (const t of other.tools ?? []) expect(`${file}:${mine.has(t.name)}`).toBe(`${file}:false`);
      }
    }
  });

  it('is read-only: every tool is a GET and says so', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:true`);
      expect(t.description).toMatch(/Read-only\./);
      expect(t.enabled).toBeUndefined();
    }
  });

  it('explains HR sensitivity and the admin setup, names only real tools and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bworkday_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bworkday_[a-z_]+/g)]),
      ...a.tools.flatMap((t) => Object.values(t.parameters.properties ?? {}).flatMap((p) => [...String(p.description).matchAll(/\bworkday_[a-z_]+/g)])),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/HR data is sensitive personal data/);
    expect(a.instructions).toMatch(/Register API Client for Integrations/);
    expect(a.instructions).toMatch(/Manage Refresh Tokens for Integrations/);
    expect(a.instructions).toMatch(/Non-Expiring Refresh Tokens/);
    expect(a.instructions).toMatch(/Out of scope/);
    for (const name of ['workday_get_time_off_balances', 'workday_list_time_off_entries', 'workday_list_leaves_of_absence']) {
      expect(tool(name).description).toMatch(/sensitive/i);
    }
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });

  it('gives every tool a valid response mapping that does real work', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:true`);
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.exclude ?? tr.include ?? tr.expression).toBeDefined();
      expect(tr.maxBytes).toBeGreaterThan(0);
    }
  });

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends GET to the right service, version and tenant with the bearer token', async (name, params, p) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`${API}${p}`);
    expect(req.headers.Authorization).toBe('Bearer test-token');
    expect(req.headers.Accept).toBe('application/json');
    expect(JSON.stringify(req)).not.toContain(SECRET);
    expect(JSON.stringify(req)).not.toContain(REFRESH);
  });

  it('maps the filters to Workday query names and pages 20 rows by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('workday_search_workers', { search: 'Logan McNeil', email: 'lmcneil@example.com', include_terminated: true, offset: 40 });
    expect(Object.fromEntries(query())).toEqual({ search: 'Logan McNeil', email: 'lmcneil@example.com', includeTerminatedWorkers: 'true', limit: '20', offset: '40' });
    mockedAxios.mockClear();
    await call('workday_get_time_off_balances', { worker_id: WID, effective_date: '2026-12-31' });
    expect(Object.fromEntries(query())).toEqual({ worker: WID, effective: '2026-12-31', limit: '20' });
    mockedAxios.mockClear();
    await call('workday_list_time_off_entries', { worker_id: 'Employee_ID=21001', from_date: '2026-01-01', to_date: '2026-06-30' });
    expect(sent().url).toBe(`${API}/absenceManagement/v5/${TENANT}/workers/Employee_ID=21001/timeOffDetails`);
    expect(Object.fromEntries(query())).toEqual({ fromDate: '2026-01-01', toDate: '2026-06-30', limit: '20' });
    mockedAxios.mockClear();
    await call('workday_list_organizations', { organization_type: WID, limit: 100 });
    expect(Object.fromEntries(query())).toEqual({ organizationType: WID, limit: '100' });
    mockedAxios.mockClear();
    await call('workday_list_job_postings', { job_requisition: 'Job_Requisition_ID=R-100' });
    expect(Object.fromEntries(query())).toEqual({ jobRequisition: 'Job_Requisition_ID=R-100', limit: '20' });
  });

  it('shapes workers to staffing fields and keeps the paging total', () => {
    const worker = {
      id: WID,
      descriptor: 'Logan McNeil',
      workerId: '21001',
      workerType: { id: 'x', descriptor: 'Regular' },
      person: { id: 'p1', email: 'lmcneil@example.com', phone: '+1 (925) 555-0100' },
      primaryJob: {
        id: 'P-00001',
        descriptor: 'P-00001 Chief Human Resources Officer',
        businessTitle: 'Chief Human Resources Officer',
        jobProfile: { id: 'jp', descriptor: 'Chief Human Resources Officer' },
        supervisoryOrganization: { id: 'so', descriptor: 'Human Resources (Logan McNeil)' },
        location: { id: 'loc', descriptor: 'San Francisco' },
        jobType: { descriptor: 'Primary' },
      },
      additionalJobs: [],
      prehireId: 'PH-1',
    };
    const listed = shape('workday_search_workers', { total: 1, data: [worker] });
    expect(listed).toEqual({
      total: 1,
      data: [
        {
          id: WID,
          name: 'Logan McNeil',
          workerId: '21001',
          workerType: 'Regular',
          businessTitle: 'Chief Human Resources Officer',
          jobProfile: 'Chief Human Resources Officer',
          supervisoryOrganization: 'Human Resources (Logan McNeil)',
          supervisoryOrganizationId: 'so',
          location: 'San Francisco',
          workEmail: 'lmcneil@example.com',
          workPhone: '+1 (925) 555-0100',
        },
      ],
    });
    const one = shape('workday_get_worker', worker);
    expect(one.primaryJobId).toBe('P-00001');
    expect(one.jobType).toBe('Primary');
    expect(one.prehireId).toBeUndefined();
  });

  it('leaves comments and additional fields out of leaves of absence', () => {
    const leaves = shape('workday_list_leaves_of_absence', {
      total: 1,
      data: [
        {
          id: 'loa1',
          leaveType: { descriptor: 'Medical Leave' },
          status: { descriptor: 'Successfully Completed' },
          firstDayOfLeave: '2026-03-02',
          lastDayOfWork: '2026-02-27',
          estimatedLastDayOfLeave: '2026-04-30',
          latestLeaveComment: 'surgery follow-up',
          additionalFields: [{ name: 'Diagnosis', value: 'x' }],
          leaveImpactFields: { payrollEffect: true },
        },
      ],
    });
    expect(leaves.data[0]).toEqual({
      id: 'loa1',
      leaveType: 'Medical Leave',
      status: 'Successfully Completed',
      firstDayOfLeave: '2026-03-02',
      lastDayOfWork: '2026-02-27',
      estimatedLastDayOfLeave: '2026-04-30',
    });
    const balances = shape('workday_get_time_off_balances', {
      total: 1,
      data: [{ absencePlan: { id: 'ap', descriptor: 'Vacation' }, category: { descriptor: 'Time Off Plan' }, quantity: 12.5, unit: { descriptor: 'Days' }, effectiveDate: '2026-10-15', worker: { descriptor: 'Logan McNeil' } }],
    });
    expect(balances.data[0]).toEqual({ plan: 'Vacation', planId: 'ap', category: 'Time Off Plan', quantity: 12.5, unit: 'Days', effectiveDate: '2026-10-15' });
    const entries = shape('workday_list_time_off_entries', {
      total: 1,
      data: [{ date: '2026-07-01', timeOffType: { descriptor: 'Vacation' }, quantity: 8, unit: { descriptor: 'Hours' }, status: { descriptor: 'Approved' }, timeOffEntryId: 'e1', timeOffEventId: { id: 'ev1', descriptor: 'Time Off Request' }, worktags: [{ id: 'w' }] }],
    });
    expect(entries.data[0]).toEqual({ date: '2026-07-01', timeOffType: 'Vacation', quantity: 8, unit: 'Hours', status: 'Approved', timeOffEntryId: 'e1', timeOffRequestId: 'ev1' });
  });
});

const live = process.env.RUN_WORKDAY_LIVE === '1' ? describe : describe.skip;
live('workday adapter: live', () => {
  const host = process.env.WORKDAY_HOST;
  const tenant = process.env.WORKDAY_TENANT;
  const routes = !!(host && tenant);
  const real = routes && !!(process.env.WORKDAY_CLIENT_ID && process.env.WORKDAY_CLIENT_SECRET && process.env.WORKDAY_REFRESH_TOKEN);
  const env = (): Record<string, string> => ({
    WORKDAY_HOST: host!,
    WORKDAY_TENANT: tenant!,
    WORKDAY_CLIENT_ID: process.env.WORKDAY_CLIENT_ID ?? '',
    WORKDAY_CLIENT_SECRET: process.env.WORKDAY_CLIENT_SECRET ?? '',
    WORKDAY_REFRESH_TOKEN: process.env.WORKDAY_REFRESH_TOKEN ?? '',
  });
  const fakeToken = { getAccessToken: async () => 'not-a-real-token' } as unknown as OAuth2TokenService;
  // The real token service, so the live run also proves the token request.
  const tokens = new OAuth2TokenService(
    {} as PrismaService,
    { get: () => 'live-spec-encryption-key-32-chars!' } as unknown as ConfigService,
  );
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  (routes ? it.each(table) : it.skip.each(table))('%s reaches a real route and is refused with a made-up token (401)', async (name, params) => {
    await expect(call(name, params, env(), fakeToken)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (routes ? it : it.skip)('answers a made-up service with 404 even with a made-up token, which makes the 401s above meaningful', async () => {
    await expect(
      (mockedAxios.__actual as any).request({
        method: 'GET',
        url: `https://${host}/ccx/api/noSuchService/v1/${tenant}/workers`,
        headers: { Authorization: 'Bearer not-a-real-token' },
      }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (real ? it : it.skip)('gets a token with the refresh token and runs every read on the tenant', async () => {
    const run = async (name: string, params: Record<string, unknown> = {}) => shape(name, await call(name, params, env(), tokens));
    const workers = await run('workday_search_workers', { limit: 2 });
    expect(typeof workers.total).toBe('number');
    expect(Array.isArray(workers.data)).toBe(true);
    const first = workers.data[0];
    if (first) {
      const one = await run('workday_get_worker', { worker_id: first.id });
      expect(one.id).toBe(first.id);
      await run('workday_list_direct_reports', { worker_id: first.id, limit: 5 });
      await run('workday_get_time_off_balances', { worker_id: first.id });
      await run('workday_list_time_off_entries', { worker_id: first.id, limit: 5 });
      await run('workday_list_leaves_of_absence', { worker_id: first.id, limit: 5 });
    }
    const orgs = await run('workday_list_supervisory_organizations', { limit: 2 });
    if (orgs.data?.[0]) {
      await run('workday_get_supervisory_organization', { organization_id: orgs.data[0].id });
      await run('workday_list_organization_members', { organization_id: orgs.data[0].id, limit: 5 });
    }
    const types = await run('workday_list_organization_types', { limit: 5 });
    if (types.data?.[0]) await run('workday_list_organizations', { organization_type: types.data[0].id, limit: 5 });
    const profiles = await run('workday_list_job_profiles', { limit: 2 });
    if (profiles.data?.[0]) await run('workday_get_job_profile', { job_profile_id: profiles.data[0].id });
    await run('workday_list_jobs', { limit: 2 });
    const postings = await run('workday_list_job_postings', { limit: 2 });
    if (postings.data?.[0]) await run('workday_get_job_posting', { job_posting_id: postings.data[0].id });
  }, 120000);
});
