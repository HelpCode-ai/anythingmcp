import * as adapter from './weeek.json';

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { type?: unknown; enum?: unknown[] }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, string>;
    bodyMapping?: Record<string, unknown>;
  };
};

const a = adapter as unknown as {
  slug: string;
  region: string;
  unlisted?: boolean;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { secret?: boolean; pattern?: string }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: { token: string }; healthcheckPath: string };
  tools: Tool[];
};
const byName = Object.fromEntries(a.tools.map((tool) => [tool.name, tool]));

describe('Weeek adapter — static contract', () => {
  it('calls the public v1 API with the token as a bearer token', () => {
    expect(a.slug).toBe('weeek');
    expect(a.region).toBe('intl');
    expect(a.unlisted).toBeFalsy();
    expect(a.icon).toBe('weeek');
    expect(a.requiredEnvVars).toEqual(['WEEEK_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://api.weeek.net/public/v1');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{WEEEK_API_TOKEN}}');
    expect(a.envVarMeta.WEEEK_API_TOKEN.secret).toBe(true);
    const pattern = new RegExp(a.envVarMeta.WEEEK_API_TOKEN.pattern!);
    expect(pattern.test('123e4567-e89b-12d3-a456-426655440000')).toBe(true);
    expect(pattern.test('Bearer 123e4567-e89b-12d3-a456-426655440000')).toBe(false);
  });

  it('checks the connection with the token user', () => {
    expect(a.connector.healthcheckPath).toBe('/user/me');
    expect(a.probe.tool).toBe('weeek_get_profile');
    expect(byName.weeek_get_profile.endpointMapping).toEqual({ method: 'GET', path: '/user/me' });
  });

  it('prefixes every tool and describes it', () => {
    for (const tool of a.tools) {
      expect(tool.name.startsWith('weeek_')).toBe(true);
      expect(tool.description.length).toBeGreaterThanOrEqual(60);
    }
  });

  it('maps the documented task endpoints and filters', () => {
    expect(byName.weeek_list_tasks.endpointMapping.queryParams).toMatchObject({
      projectId: '$projectId',
      boardColumnId: '$boardColumnId',
      completed: '$completed',
      perPage: '$perPage',
      offset: '$offset',
    });
    expect(byName.weeek_create_task.endpointMapping).toMatchObject({ method: 'POST', path: '/tm/tasks' });
    expect(byName.weeek_create_task.parameters.required).toEqual(['title', 'locations']);
    expect(byName.weeek_update_task.endpointMapping).toMatchObject({ method: 'PUT', path: '/tm/tasks/{id}' });
    expect(byName.weeek_complete_task.endpointMapping).toEqual({ method: 'POST', path: '/tm/tasks/{id}/complete' });
    expect(byName.weeek_reopen_task.endpointMapping).toEqual({ method: 'POST', path: '/tm/tasks/{id}/un-complete' });
    expect(byName.weeek_move_task_to_column.endpointMapping).toMatchObject({
      path: '/tm/tasks/{id}/board-column',
      bodyMapping: { boardColumnId: '$boardColumnId' },
    });
    expect(byName.weeek_list_board_columns.parameters.required).toEqual(['boardId']);
    expect(byName.weeek_list_deals.endpointMapping.path).toBe('/crm/statuses/{statusId}/deals');
  });

  it('removes a task from one project with the project id in the DELETE body', () => {
    expect(byName.weeek_remove_task_from_project.endpointMapping).toEqual({
      method: 'DELETE',
      path: '/tm/tasks/{id}/locations',
      bodyMapping: { projectId: '$projectId' },
    });
    expect(byName.weeek_remove_task_from_project.parameters.required).toEqual(['id', 'projectId']);
    expect(byName.weeek_remove_task_from_project.enabled).not.toBe(false);
  });

  it('sends Weeek flags as 0 or 1, never booleans', () => {
    expect(byName.weeek_create_project.parameters.properties!.isPrivate.enum).toEqual([0, 1]);
    expect(byName.weeek_list_tasks.parameters.properties!.completed.enum).toEqual([0, 1]);
    expect(byName.weeek_log_time.parameters.properties!.isOvertime.enum).toEqual([0, 1]);
  });

  it('asks for confirmation on writes and installs the task delete switched off', () => {
    const writes = a.tools.filter((tool) => tool.endpointMapping.method !== 'GET');
    for (const tool of writes) expect(tool.description).toMatch(/confirm/i);
    expect(byName.weeek_delete_task.endpointMapping).toEqual({ method: 'DELETE', path: '/tm/tasks/{id}' });
    expect(byName.weeek_delete_task.enabled).toBe(false);
    const disabled = a.tools.filter((tool) => tool.enabled === false).map((tool) => tool.name);
    expect(disabled).toEqual(['weeek_delete_task']);
  });

  it('keeps the instructions free of em dashes and within the house limits', () => {
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    expect(a.instructions.length).toBeLessThanOrEqual(2500);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions).toContain('**Getting credentials');
  });
});

// Opt-in: run with RUN_WEEEK_LIVE=1 and WEEEK_API_TOKEN. Read-only calls only.
const live = process.env.RUN_WEEEK_LIVE === '1';
(live ? describe : describe.skip)('Weeek — live read-only smoke test', () => {
  const token = process.env.WEEEK_API_TOKEN;
  const get = async (path: string) => {
    if (!token) throw new Error('Set WEEEK_API_TOKEN for RUN_WEEEK_LIVE=1');
    return fetch('https://api.weeek.net/public/v1' + path, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
  };

  it('reads the token user and the workspace', async () => {
    const me = await get('/user/me');
    expect(me.status).toBe(200);
    expect(typeof (await me.json()).user.id).toBe('string');

    const ws = await get('/ws');
    expect(ws.status).toBe(200);
    expect((await ws.json()).success).toBe(true);
  });

  it('lists projects and one page of tasks', async () => {
    const projects = await get('/tm/projects');
    expect(projects.status).toBe(200);
    expect(Array.isArray((await projects.json()).projects)).toBe(true);

    const tasks = await get('/tm/tasks?perPage=1');
    expect(tasks.status).toBe(200);
    const body = await tasks.json();
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body).toHaveProperty('hasMore');
  });
});
