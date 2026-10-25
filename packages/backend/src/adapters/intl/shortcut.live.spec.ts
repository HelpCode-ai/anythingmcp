import axios from 'axios';
import * as adapter from './shortcut.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Shortcut adapter:
 *
 *   1. Static: always runs. Pins the Shortcut-Token header, every tool's
 *      method and URL through the real RestEngine (checked against Shortcut's
 *      published OpenAPI spec for API v3), the request bodies of the writes,
 *      the confirm-first wording, the switched-off delete, and the response
 *      mappings against payloads shaped like the spec's examples.
 *
 *   2. Live: skipped unless RUN_SHORTCUT_LIVE=1 and SHORTCUT_API_TOKEN are set:
 *
 *        RUN_SHORTCUT_LIVE=1 SHORTCUT_API_TOKEN=... npx jest src/adapters/intl/shortcut.live.spec.ts
 *
 *      Reads only. With SHORTCUT_LIVE_WRITE=1 as well, a story named
 *      "AnythingMCP test story" is created, updated, commented and then
 *      archived (not deleted).
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
  parameters: { properties?: Record<string, { default?: unknown; maximum?: number }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
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
  description: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { secret?: boolean; pattern?: string }>;
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

const BASE = 'https://api.app.shortcut.com/api/v3';
const run = async (name: string, params: Record<string, unknown>, token = 'test-token') => {
  const { body } = await new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).executeWithMeta(
    {
      baseUrl: a.connector.baseUrl,
      authType: a.connector.authType,
      authConfig: { ...a.connector.authConfig, apiKey: token },
      headers: a.connector.headers,
    },
    tool(name).endpointMapping,
    applySchemaDefaults(tool(name).parameters as never, params),
  );
  return body as any;
};
const runShaped = async (name: string, params: Record<string, unknown>, token?: string) =>
  applyResponseTransform(await run(name, params, token), tool(name).responseMapping as never).value as any;
const sent = () => mockedAxios.mock.calls[0][0];
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as never);

const WRITES = ['shortcut_create_story', 'shortcut_update_story', 'shortcut_add_story_comment'];

describe('shortcut adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('shortcut');
    expect(a.icon).toBe('shortcut');
    expect(a.category).toBe('project-management');
  });

  it('sends the personal API token in the Shortcut-Token header', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Shortcut-Token', apiKey: '{{SHORTCUT_API_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['SHORTCUT_API_TOKEN']);
    expect(a.envVarMeta.SHORTCUT_API_TOKEN.secret).toBe(true);
    const re = new RegExp(a.envVarMeta.SHORTCUT_API_TOKEN.pattern!);
    expect(re.test('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true);
    expect(re.test('Bearer a1b2c3d4')).toBe(false);
    expect(a.connector.healthcheckPath).toBe('/member');
    expect(a.probe.tool).toBe('shortcut_get_current_member');
    expect(tool('shortcut_get_current_member').parameters.required).toBeUndefined();
  });

  it('prefixes every tool with shortcut_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^shortcut_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('reads are GETs; every write asks to confirm first; the delete is switched off', () => {
    for (const t of a.tools) {
      const write = t.endpointMapping.method !== 'GET';
      expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:${!write}`);
      if (write) expect(`${t.name}:${/confirm/i.test(t.description)}`).toBe(`${t.name}:true`);
    }
    for (const name of WRITES) expect(tool(name).enabled).toBeUndefined();
    expect(tool('shortcut_delete_story').enabled).toBe(false);
    expect(tool('shortcut_delete_story').endpointMapping.method).toBe('DELETE');
    expect(a.tools.filter((t) => t.endpointMapping.method === 'DELETE').map((t) => t.name)).toEqual(['shortcut_delete_story']);
    expect(a.instructions).toContain('**Writes: confirm first.**');
  });

  it('every tool except the delete shapes its answer, and lists are capped', () => {
    for (const t of a.tools) {
      if (t.name === 'shortcut_delete_story') continue;
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${Boolean(tr && (tr.select || tr.exclude || tr.include))}`).toBe(`${t.name}:true`);
    }
    for (const t of a.tools.filter((x) => /_(list|search)_/.test(x.name) || x.name.endsWith('_history'))) {
      expect(`${t.name}:${(t.responseMapping!.transform!.maxBytes as number) > 0}`).toBe(`${t.name}:true`);
    }
    for (const name of ['shortcut_search_stories', 'shortcut_search_epics', 'shortcut_list_epics']) {
      expect(tool(name).parameters.properties!.page_size).toMatchObject({ default: 25, maximum: 250 });
    }
  });

  it('only points the model at tools that exist and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bshortcut_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bshortcut_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(15);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Shortcut\n')).toBe(true);
    expect(a.instructions).toContain('**Out of scope**');
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['shortcut_get_current_member', {}, 'GET', `${BASE}/member`],
    ['shortcut_list_members', {}, 'GET', `${BASE}/members`],
    ['shortcut_list_workflows', {}, 'GET', `${BASE}/workflows`],
    ['shortcut_list_teams', {}, 'GET', `${BASE}/groups`],
    ['shortcut_list_projects', {}, 'GET', `${BASE}/projects`],
    ['shortcut_list_epics', {}, 'GET', `${BASE}/epics/paginated`],
    ['shortcut_search_epics', { query: 'x' }, 'GET', `${BASE}/search/epics`],
    ['shortcut_get_epic', { epic_id: 12 }, 'GET', `${BASE}/epics/12`],
    ['shortcut_list_epic_stories', { epic_id: 12 }, 'GET', `${BASE}/epics/12/stories`],
    ['shortcut_list_iterations', {}, 'GET', `${BASE}/iterations`],
    ['shortcut_list_iteration_stories', { iteration_id: 7 }, 'GET', `${BASE}/iterations/7/stories`],
    ['shortcut_list_objectives', {}, 'GET', `${BASE}/objectives`],
    ['shortcut_list_labels', {}, 'GET', `${BASE}/labels`],
    ['shortcut_search_stories', { query: 'x' }, 'GET', `${BASE}/search/stories`],
    ['shortcut_get_story', { story_id: 123 }, 'GET', `${BASE}/stories/123`],
    ['shortcut_get_story_history', { story_id: 123 }, 'GET', `${BASE}/stories/123/history`],
    ['shortcut_create_story', { name: 'x' }, 'POST', `${BASE}/stories`],
    ['shortcut_update_story', { story_id: 123, name: 'y' }, 'PUT', `${BASE}/stories/123`],
    ['shortcut_add_story_comment', { story_id: 123, text: 'hi' }, 'POST', `${BASE}/stories/123/comments`],
    ['shortcut_delete_story', { story_id: 123 }, 'DELETE', `${BASE}/stories/123`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends the right method and URL with the token header', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await run(name, params);
    expect(sent().method).toBe(method);
    expect(sent().url).toBe(url);
    expect(sent().headers['Shortcut-Token']).toBe('test-token');
    expect(sent().headers.Authorization).toBeUndefined();
  });

  it('encodes path ids, so a crafted id cannot reach another route', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await run('shortcut_get_story', { story_id: '1/../../member' });
    expect(sent().url).toBe(`${BASE}/stories/1%2F..%2F..%2Fmember`);
    for (const t of a.tools.filter((x) => /\{[a-z_]+\}/.test(x.endpointMapping.path))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('searches with slim detail, the default page size and the next token', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await run('shortcut_search_stories', { query: 'owner:jane is:started', next: 'a8acc6577548df7a' });
    expect(sent().params).toEqual({ query: 'owner:jane is:started', page_size: 25, next: 'a8acc6577548df7a', detail: 'slim' });
    mockedAxios.mockClear();
    await run('shortcut_list_epics', {});
    expect(sent().params).toEqual({ page: 1, page_size: 25 });
    mockedAxios.mockClear();
    await run('shortcut_list_labels', {});
    expect(sent().params).toEqual({ slim: 'true' });
    mockedAxios.mockClear();
    await run('shortcut_list_members', {});
    expect(sent().params).toEqual({ disabled: false });
  });

  it('builds the create, update and comment bodies the API expects', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await run('shortcut_create_story', {
      name: 'Login fails',
      story_type: 'bug',
      workflow_state_id: 500000008,
      owner_ids: ['12345678-9012-3456-7890-123456789012'],
      labels: [{ name: 'customer' }],
    });
    expect(sent().data).toEqual({
      name: 'Login fails',
      story_type: 'bug',
      workflow_state_id: 500000008,
      owner_ids: ['12345678-9012-3456-7890-123456789012'],
      labels: [{ name: 'customer' }],
    });
    expect(tool('shortcut_create_story').parameters.required).toEqual(['name']);
    mockedAxios.mockClear();
    await run('shortcut_update_story', { story_id: 9, workflow_state_id: 500000010, archived: true });
    expect(sent().data).toEqual({ workflow_state_id: 500000010, archived: true });
    mockedAxios.mockClear();
    await run('shortcut_add_story_comment', { story_id: 9, text: 'Fixed in v2' });
    expect(sent().data).toEqual({ text: 'Fixed in v2' });
  });

  it('shapes the member, a search page, a story and its history', () => {
    const me = shape('shortcut_get_current_member', {
      id: 'u-1', name: 'Jane Doe', mention_name: 'jane', role: 'admin', is_owner: false,
      workspace2: { id: 'w', name: 'Acme', url_slug: 'acme', default_workflow_id: 500000001, estimate_scale: [1, 2, 3], utc_offset: '+02:00', created_at: 't' },
      organization2: { id: 'o' },
    }).value;
    expect(me).toEqual({
      id: 'u-1', name: 'Jane Doe', mention_name: 'jane', role: 'admin', is_owner: false,
      workspace: { name: 'Acme', url_slug: 'acme', default_workflow_id: 500000001, estimate_scale: [1, 2, 3], utc_offset: '+02:00' },
    });
    const page = shape('shortcut_search_stories', {
      total: 1,
      next: '/api/v3/search/stories?query=x&next=a8acc6577548df7a',
      data: [{ id: 123, name: 'Login fails', story_type: 'bug', workflow_state_id: 5, epic_id: null, iteration_id: 7, group_id: 'g', owner_ids: ['u-1'], estimate: 2, deadline: null, started: true, completed: false, blocked: false, archived: false, app_url: 'https://app.shortcut.com/acme/story/123', updated_at: 't', labels: [{ id: 1, name: 'customer', color: '#fff', entity_type: 'label' }], description: 'long', comment_ids: [1, 2], position: 1, global_id: 'x' }],
    }).value as any;
    expect(page.total).toBe(1);
    expect(page.next).toContain('next=a8acc6577548df7a');
    expect(page.stories[0]).toMatchObject({ id: 123, name: 'Login fails', labels: ['customer'], owner_ids: ['u-1'] });
    expect(page.stories[0].description).toBeUndefined();
    expect(page.stories[0].global_id).toBeUndefined();
    const story = shape('shortcut_get_story', {
      id: 123, name: 'Login fails', description: 'Steps...', labels: [{ name: 'customer' }], tasks: [{ id: 1, description: 'repro', complete: true, owner_ids: [], entity_type: 'task' }],
      comments: [{ id: 2, author_id: 'u-1', text: 'seen', created_at: 't', entity_type: 'story-comment', reactions: [] }],
      story_links: [{ id: 3, verb: 'blocks', subject_id: 123, object_id: 124, type: 'subject', entity_type: 'typed-story-link' }],
      branches: [{ id: 1 }], commits: [], pull_requests: [], files: [],
    }).value as any;
    expect(story).toMatchObject({ id: 123, description: 'Steps...', labels: ['customer'] });
    expect(story.tasks).toEqual([{ id: 1, description: 'repro', complete: true, owner_ids: [] }]);
    expect(story.comments).toEqual([{ id: 2, author_id: 'u-1', text: 'seen', created_at: 't' }]);
    expect(story.branches).toBeUndefined();
    const history = shape('shortcut_get_story_history', [
      { id: 'h', changed_at: 't', member_id: 'u-1', actor_name: 'Jane', version: 'v1', primary_id: 123, actions: [{ action: 'update', entity_type: 'story', id: 123, name: 'Login fails', app_url: 'x', story_type: 'bug', changes: { workflow_state_id: { old: 1, new: 2 } } }], references: [{ entity_type: 'workflow-state', id: 2, name: 'Done', type: 'done', app_url: 'y' }] },
    ]).value as any;
    expect(history.history[0]).toEqual({
      id: 'h', changed_at: 't', member_id: 'u-1', actor_name: 'Jane',
      actions: [{ action: 'update', entity_type: 'story', id: 123, name: 'Login fails', changes: { workflow_state_id: { old: 1, new: 2 } } }],
      references: [{ entity_type: 'workflow-state', id: 2, name: 'Done', type: 'done' }],
    });
  });

  it('shapes workflows with their states', () => {
    const wf = shape('shortcut_list_workflows', [
      { id: 500000001, name: 'Engineering', default_state_id: 500000008, team_id: 1, project_ids: [], description: '', auto_assign_owner: false, created_at: 't',
        states: [{ id: 500000008, name: 'Unstarted', type: 'unstarted', position: 1, num_stories: 4, color: '#fff', verb: null, global_id: 'g' }] },
    ]).value as any;
    expect(wf.workflows[0].states).toEqual([{ id: 500000008, name: 'Unstarted', type: 'unstarted', position: 1, num_stories: 4 }]);
    expect(wf.workflows[0].auto_assign_owner).toBeUndefined();
  });
});

const live = process.env.RUN_SHORTCUT_LIVE === '1' && process.env.SHORTCUT_API_TOKEN ? describe : describe.skip;

live('shortcut adapter: live API', () => {
  const token = process.env.SHORTCUT_API_TOKEN!;
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  it('reads the member, workflows, teams, labels and a story search', async () => {
    const me = await runShaped('shortcut_get_current_member', {}, token);
    expect(typeof me.id).toBe('string');
    expect(typeof me.mention_name).toBe('string');
    const wf = await runShaped('shortcut_list_workflows', {}, token);
    expect(wf.workflows.length).toBeGreaterThan(0);
    expect(wf.workflows[0].states.length).toBeGreaterThan(0);
    const teams = await runShaped('shortcut_list_teams', {}, token);
    expect(Array.isArray(teams.teams)).toBe(true);
    const labels = await runShaped('shortcut_list_labels', {}, token);
    expect(Array.isArray(labels.labels)).toBe(true);
    const found = await runShaped('shortcut_search_stories', { query: '!is:archived', page_size: 5 }, token);
    expect(found.stories.length).toBeLessThanOrEqual(5);
    if (found.stories[0]) {
      const story = await runShaped('shortcut_get_story', { story_id: found.stories[0].id }, token);
      expect(story.id).toBe(found.stories[0].id);
      const history = await runShaped('shortcut_get_story_history', { story_id: found.stories[0].id }, token);
      expect(Array.isArray(history.history)).toBe(true);
    }
  }, 60_000);

  const writes = process.env.SHORTCUT_LIVE_WRITE === '1' ? it : it.skip;
  writes('creates, updates, comments and archives a test story', async () => {
    const wf = await runShaped('shortcut_list_workflows', {}, token);
    const created = await runShaped('shortcut_create_story', { name: 'AnythingMCP test story', workflow_state_id: wf.workflows[0].default_state_id }, token);
    expect(created.name).toBe('AnythingMCP test story');
    const updated = await runShaped('shortcut_update_story', { story_id: created.id, story_type: 'chore' }, token);
    expect(updated.story_type).toBe('chore');
    const comment = await runShaped('shortcut_add_story_comment', { story_id: created.id, text: 'Test comment from AnythingMCP' }, token);
    expect(comment.story_id).toBe(created.id);
    const archived = await runShaped('shortcut_update_story', { story_id: created.id, archived: true }, token);
    expect(archived.archived).toBe(true);
  }, 60_000);
});
