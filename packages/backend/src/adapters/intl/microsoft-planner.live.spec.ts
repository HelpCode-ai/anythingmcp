import axios from 'axios';
import * as adapter from './microsoft-planner.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Microsoft Planner (Microsoft Graph) adapter:
 *
 *   1. Static: always runs. Pins the Entra OAuth setup shared with the other
 *      Microsoft connectors (tenant in both endpoints, offline_access,
 *      Tasks.ReadWrite and no admin-only Group.* scope), the If-Match header
 *      every Planner change needs, taken from the etag the model passes, the
 *      Prefer header that returns the updated item with its new etag, the
 *      task bodies Graph documents, and that delete installs switched off.
 *
 *   2. Live: skipped unless MS_GRAPH_ACCESS_TOKEN is set (a delegated Graph
 *      token of a work or school account with Tasks.ReadWrite, e.g. from
 *      Graph Explorer):
 *
 *        MS_GRAPH_ACCESS_TOKEN=eyJ... npx jest src/adapters/intl/microsoft-planner.live.spec.ts
 *
 *      With PLANNER_LIVE_PLAN_ID set as well (a plan the account may edit), a
 *      task is created in the plan's first bucket, assigned to the user,
 *      updated with its etag, given a description and a checklist item, and
 *      deleted in `finally`.
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
  parameters: { properties?: Record<string, { default?: unknown; enum?: unknown[] }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  responseMapping?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  appRegistrationUrl: string;
  requiredEnvVars: string[];
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
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping as any, annotations: t.annotations });

const BASE = 'https://graph.microsoft.com/v1.0';
const newEngine = () =>
  new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  );
const connectorConfig = () => ({
  baseUrl: a.connector.baseUrl,
  authType: a.connector.authType,
  authConfig: { ...a.connector.authConfig },
  headers: { ...a.connector.headers },
});
const call = (name: string, params: Record<string, unknown>) =>
  newEngine().execute(connectorConfig(), tool(name).endpointMapping as any, applySchemaDefaults(tool(name).parameters as any, params));
const sent = () => mockedAxios.mock.calls[0][0];

const PLAN = 'xqQg5FS2LkCp935s-FIFm2QAFkHM';
const BUCKET = 'hsOf2dhOJkqyYYZEtdzDe2QAIUCR';
const TASK = '01gzSlKkIUSUl6DF_EilrmQAKDhh';
const GROUP = '02bd9fd6-8f93-4758-87c3-1fb73740a315';
const ETAG = 'W/"JzEtVGFzayAgQEBAQEBAQEBAQEBAQEBAWCc="';
const USER = 'fbab97d0-4932-4511-b675-204639209557';

describe('microsoft-planner adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: verified on a live account on 14 Oct 2026, and says up front that it needs a work account and an Entra app', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.prerequisites).toMatch(/work or school account/);
    expect(a.prerequisites).toMatch(/Outlook connector can be reused/);
    expect(a.appRegistrationUrl).toMatch(/^https:\/\/entra\.microsoft\.com\//);
  });

  it('signs in with Tasks.ReadWrite and asks for no admin-only Group scope', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.requiredEnvVars).toEqual(['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID']);
    expect(a.connector.authConfig).toEqual({
      clientId: '{{MICROSOFT_CLIENT_ID}}',
      clientSecret: '{{MICROSOFT_CLIENT_SECRET}}',
      authorizationUrl: 'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/token',
      scopes: 'offline_access User.Read Tasks.ReadWrite',
    });
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toMatch(/One Entra app for all Microsoft connectors/);
    expect(a.instructions).toMatch(/personal Microsoft accounts have no Planner/);
  });

  it('probes with the user\'s tasks, which need no arguments', () => {
    expect(a.probe.tool).toBe('microsoft_planner_list_my_tasks');
    expect(tool('microsoft_planner_list_my_tasks').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/me/planner/tasks');
  });

  it('prefixes every tool with microsoft_planner_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^microsoft_planner_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('percent-encodes every id in the path', () => {
    for (const t of a.tools) {
      if (/\{\w+\}/.test(t.endpointMapping.path)) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('requires an etag on every change of an existing item and sends it as If-Match', () => {
    const changes = a.tools.filter((t) => ['PATCH', 'DELETE'].includes(t.endpointMapping.method));
    expect(changes.map((t) => t.name).sort()).toEqual([
      'microsoft_planner_delete_task',
      'microsoft_planner_update_task',
      'microsoft_planner_update_task_details',
    ]);
    for (const t of changes) {
      expect(t.parameters.required).toContain('etag');
      expect(t.endpointMapping.headers?.['If-Match']).toBe('$etag');
    }
  });

  it('installs only delete switched off, and asks the model to confirm every write', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['microsoft_planner_delete_task']);
    expect(a.instructions).toMatch(/Switched off at install\*\*: `microsoft_planner_delete_task`/);
    expect(annotationsOf(tool('microsoft_planner_delete_task')).destructiveHint).toBe(true);
    for (const t of a.tools.filter((x) => x.endpointMapping.method !== 'GET')) {
      expect(`${t.name}: ${t.description}`).toMatch(/Confirm with the user before calling\.$/);
    }
  });

  it('marks every GET read-only', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual(a.tools.filter((t) => t.endpointMapping.method === 'GET').map((t) => t.name).sort());
    expect(readOnly).toHaveLength(12);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bmicrosoft_planner_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bmicrosoft_planner_[a-z_]+/g)]),
      ...a.tools.flatMap((t) =>
        Object.values(t.parameters.properties ?? {}).flatMap((p) => [...String((p as { description?: string }).description).matchAll(/\bmicrosoft_planner_[a-z_]+/g)]),
      ),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it.each([
    ['microsoft_planner_get_me', {}, 'GET', '/me'],
    ['microsoft_planner_list_my_tasks', {}, 'GET', '/me/planner/tasks'],
    ['microsoft_planner_list_my_plans', {}, 'GET', '/me/planner/plans'],
    ['microsoft_planner_list_my_groups', {}, 'GET', '/me/memberOf'],
    ['microsoft_planner_list_group_plans', { group_id: GROUP }, 'GET', `/groups/${GROUP}/planner/plans`],
    ['microsoft_planner_get_plan', { plan_id: PLAN }, 'GET', `/planner/plans/${PLAN}`],
    ['microsoft_planner_get_plan_details', { plan_id: PLAN }, 'GET', `/planner/plans/${PLAN}/details`],
    ['microsoft_planner_list_buckets', { plan_id: PLAN }, 'GET', `/planner/plans/${PLAN}/buckets`],
    ['microsoft_planner_list_plan_tasks', { plan_id: PLAN }, 'GET', `/planner/plans/${PLAN}/tasks`],
    ['microsoft_planner_list_bucket_tasks', { bucket_id: BUCKET }, 'GET', `/planner/buckets/${BUCKET}/tasks`],
    ['microsoft_planner_get_task', { task_id: TASK }, 'GET', `/planner/tasks/${TASK}`],
    ['microsoft_planner_get_task_details', { task_id: TASK }, 'GET', `/planner/tasks/${TASK}/details`],
    ['microsoft_planner_create_task', { plan_id: PLAN, title: 'T' }, 'POST', '/planner/tasks'],
    ['microsoft_planner_update_task', { task_id: TASK, etag: ETAG, title: 'T' }, 'PATCH', `/planner/tasks/${TASK}`],
    ['microsoft_planner_update_task_details', { task_id: TASK, etag: ETAG, description: 'D' }, 'PATCH', `/planner/tasks/${TASK}/details`],
    ['microsoft_planner_create_bucket', { plan_id: PLAN, name: 'B' }, 'POST', '/planner/buckets'],
    ['microsoft_planner_delete_task', { task_id: TASK, etag: ETAG }, 'DELETE', `/planner/tasks/${TASK}`],
  ])('%s sends %s to the right Graph URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method,
        url: `${BASE}${path}`,
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
  });

  it('creates a task with planId, bucketId, assignments and the other documented fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const assignments = { [USER]: { '@odata.type': '#microsoft.graph.plannerAssignment', orderHint: ' !' } };
    await call('microsoft_planner_create_task', {
      plan_id: PLAN,
      bucket_id: BUCKET,
      title: 'Update client list',
      assignments,
      due_date_time: '2026-10-31T16:00:00Z',
      priority: 1,
      percent_complete: 0,
      applied_categories: { category1: true },
    });
    expect(sent().data).toEqual({
      planId: PLAN,
      bucketId: BUCKET,
      title: 'Update client list',
      assignments,
      dueDateTime: '2026-10-31T16:00:00Z',
      priority: 1,
      percentComplete: 0,
      appliedCategories: { category1: true },
    });
    expect(sent().headers['If-Match']).toBeUndefined();
  });

  it('updates a task with If-Match and Prefer, sending only the named fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('microsoft_planner_update_task', {
      task_id: TASK,
      etag: ETAG,
      percent_complete: 100,
      assignments: { [USER]: null },
    });
    expect(sent().headers).toMatchObject({ 'If-Match': ETAG, Prefer: 'return=representation' });
    expect(sent().data).toEqual({ percentComplete: 100, assignments: { [USER]: null } });
  });

  it('updates task details with their own etag and passes checklist changes through', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const checklist = {
      '95e27074-6c4a-447a-aa24-9d718a0b86fa': { '@odata.type': 'microsoft.graph.plannerChecklistItem', title: 'Draft', isChecked: false },
      'a93c93c5-10a6-4167-9551-8bafa09967a7': null,
    };
    await call('microsoft_planner_update_task_details', {
      task_id: TASK,
      etag: 'W/"details-etag"',
      description: 'Notes',
      checklist,
      preview_type: 'checklist',
    });
    expect(sent().headers).toMatchObject({ 'If-Match': 'W/"details-etag"', Prefer: 'return=representation' });
    expect(sent().data).toEqual({ description: 'Notes', checklist, previewType: 'checklist' });
  });

  it('deletes with If-Match and no body, and creates buckets with name and planId', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('microsoft_planner_delete_task', { task_id: TASK, etag: ETAG });
    expect(sent().headers['If-Match']).toBe(ETAG);
    expect(sent().data).toBeUndefined();
    mockedAxios.mockClear();
    await call('microsoft_planner_create_bucket', { plan_id: PLAN, name: 'Waiting' });
    expect(sent().data).toEqual({ name: 'Waiting', planId: PLAN });
  });

  it('selects only the profile fields assignments need, and pages group memberships', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('microsoft_planner_get_me', {});
    expect(sent().params).toEqual({ $select: 'id,displayName,mail,userPrincipalName' });
    mockedAxios.mockClear();
    await call('microsoft_planner_list_my_groups', { skip_token: 'abc' });
    expect(sent().params).toEqual({ $select: 'id,displayName,groupTypes,mail', $skiptoken: 'abc' });
  });
});

const TOKEN = process.env.MS_GRAPH_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('microsoft-planner adapter: live Graph API', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    new RestEngine({} as OAuth2TokenService, {} as LoginTokenService)
      .execute(
        { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: TOKEN as string }, headers: a.connector.headers },
        tool(name).endpointMapping as any,
        applySchemaDefaults(tool(name).parameters as any, params),
      )
      .then((raw) => applyResponseTransform(raw, tool(name).responseMapping).value);

  it('reads the user, their tasks, plans and groups, and a plan\'s buckets and tasks', async () => {
    const me = await run('microsoft_planner_get_me');
    expect(typeof me.id).toBe('string');
    const tasks = await run('microsoft_planner_list_my_tasks');
    expect(Array.isArray(tasks.value)).toBe(true);
    const plans = await run('microsoft_planner_list_my_plans');
    expect(Array.isArray(plans.value)).toBe(true);
    const groups = await run('microsoft_planner_list_my_groups');
    expect(Array.isArray(groups.value)).toBe(true);
    const planId = plans.value[0]?.id ?? tasks.value[0]?.planId;
    if (planId) {
      const plan = await run('microsoft_planner_get_plan', { plan_id: planId });
      expect(plan.id).toBe(planId);
      const details = await run('microsoft_planner_get_plan_details', { plan_id: planId });
      expect(details.categoryDescriptions).toBeDefined();
      const buckets = await run('microsoft_planner_list_buckets', { plan_id: planId });
      expect(Array.isArray(buckets.value)).toBe(true);
      const planTasks = await run('microsoft_planner_list_plan_tasks', { plan_id: planId });
      expect(Array.isArray(planTasks.value)).toBe(true);
    }
  }, 60_000);

  (process.env.PLANNER_LIVE_PLAN_ID ? it : it.skip)(
    'creates a task, updates it and its details with their etags, then deletes it',
    async () => {
      const planId = process.env.PLANNER_LIVE_PLAN_ID as string;
      const me = await run('microsoft_planner_get_me');
      const buckets = await run('microsoft_planner_list_buckets', { plan_id: planId });
      const task = await run('microsoft_planner_create_task', {
        plan_id: planId,
        bucket_id: buckets.value[0]?.id,
        title: `AnythingMCP test ${new Date().toISOString()}`,
        assignments: { [me.id]: { '@odata.type': '#microsoft.graph.plannerAssignment', orderHint: ' !' } },
        due_date_time: '2030-01-15T16:00:00Z',
        priority: 5,
      });
      let etag: string = task['@odata.etag'];
      try {
        const fresh = await run('microsoft_planner_get_task', { task_id: task.id });
        etag = fresh['@odata.etag'];
        const updated = await run('microsoft_planner_update_task', { task_id: task.id, etag, percent_complete: 50, title: 'AnythingMCP test (updated)' });
        expect(updated.percentComplete).toBe(50);
        etag = updated['@odata.etag'];
        // Graph answers a stale etag with 409 Conflict (412 in some cases).
        const stale = await run('microsoft_planner_update_task', { task_id: task.id, etag: fresh['@odata.etag'], percent_complete: 100 }).then(
          () => 200,
          (e: any) => e.response?.status,
        );
        expect([409, 412]).toContain(stale);
        const details = await run('microsoft_planner_get_task_details', { task_id: task.id });
        const changed = await run('microsoft_planner_update_task_details', {
          task_id: task.id,
          etag: details['@odata.etag'],
          description: 'Grüße, perché',
          checklist: { '95e27074-6c4a-447a-aa24-9d718a0b86fa': { '@odata.type': 'microsoft.graph.plannerChecklistItem', title: 'Step 1', isChecked: false } },
        });
        expect(changed.description).toBe('Grüße, perché');
        expect(Object.keys(changed.checklist)).toHaveLength(1);
      } finally {
        const latest = await run('microsoft_planner_get_task', { task_id: task.id });
        await run('microsoft_planner_delete_task', { task_id: task.id, etag: latest['@odata.etag'] ?? etag });
      }
    },
    120_000,
  );
});
