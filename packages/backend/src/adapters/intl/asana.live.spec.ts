import * as adapter from './asana.json';

type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, { default?: unknown }>; required?: string[] };
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
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { secret?: boolean; pattern?: string }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: { token: string } };
  tools: Tool[];
};
const byName = Object.fromEntries(a.tools.map((tool) => [tool.name, tool]));

describe('Asana adapter — static contract', () => {
  it('calls the public REST API with the personal access token as a bearer token', () => {
    expect(a.slug).toBe('asana');
    expect(a.region).toBe('intl');
    expect(a.requiredEnvVars).toEqual(['ASANA_ACCESS_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://app.asana.com/api/1.0');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{ASANA_ACCESS_TOKEN}}');
    expect(a.envVarMeta.ASANA_ACCESS_TOKEN.secret).toBe(true);
    expect(new RegExp(a.envVarMeta.ASANA_ACCESS_TOKEN.pattern!).test('Bearer 2/123')).toBe(false);
    expect(a.probe.tool).toBe('asana_get_me');
    expect(byName.asana_get_me.endpointMapping).toMatchObject({ method: 'GET', path: '/users/me' });
  });

  it('offers nine reads and three writes, all prefixed', () => {
    expect(a.tools.every((tool) => tool.name.startsWith('asana_'))).toBe(true);
    const writes = a.tools.filter((tool) => tool.endpointMapping.method !== 'GET').map((tool) => [tool.name, tool.endpointMapping.method]);
    expect(writes).toEqual([
      ['asana_create_task', 'POST'],
      ['asana_update_task', 'PUT'],
      ['asana_add_comment', 'POST'],
    ]);
    expect(a.tools).toHaveLength(12);
    for (const [name] of writes) expect(byName[name as string].description).toMatch(/confirm/i);
  });

  it('pages list endpoints with limit + offset and keeps responses small with opt_fields', () => {
    for (const name of ['asana_list_workspaces', 'asana_list_projects', 'asana_list_tasks', 'asana_list_sections', 'asana_list_task_stories']) {
      const tool = byName[name];
      expect(tool.endpointMapping.queryParams).toMatchObject({ limit: '$limit', offset: '$offset', opt_fields: '$opt_fields' });
      // next_page is only returned when a limit is sent, so a default is required.
      expect(tool.parameters.properties!.limit.default).toBe(50);
    }
    for (const tool of a.tools) {
      expect(tool.endpointMapping.queryParams?.opt_fields).toBe('$opt_fields');
      expect(typeof tool.parameters.properties!.opt_fields.default).toBe('string');
    }
    expect(a.instructions).toContain('next_page.offset');
  });

  it('maps the documented filters and the data envelope of write bodies', () => {
    expect(byName.asana_list_projects.parameters.required).toEqual(['workspace']);
    expect(byName.asana_search_tasks.endpointMapping.path).toBe('/workspaces/{workspace_gid}/tasks/search');
    expect(byName.asana_search_tasks.endpointMapping.queryParams).toMatchObject({
      'assignee.any': '$assignee_any',
      'projects.any': '$projects_any',
      'created_at.after': '$created_after',
    });
    expect(byName.asana_search_tasks.description).toMatch(/premium/i);
    expect(byName.asana_create_task.endpointMapping.bodyMapping).toMatchObject({ data: { name: '$name', projects: '$projects' } });
    expect(byName.asana_update_task.endpointMapping).toMatchObject({ method: 'PUT', path: '/tasks/{task_gid}' });
    expect(byName.asana_update_task.endpointMapping.bodyMapping).toMatchObject({ data: { completed: '$completed', assignee: '$assignee', due_on: '$due_on' } });
    expect(byName.asana_add_comment.endpointMapping.bodyMapping).toEqual({ data: { text: '$text' } });
  });

  it('keeps the instructions within the house limits', () => {
    expect(a.instructions.length).toBeGreaterThanOrEqual(1000);
    expect(a.instructions.length).toBeLessThanOrEqual(2500);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions).toContain('**Getting credentials**');
    expect(a.instructions).toContain('**Cloud reachability**');
  });
});

// Opt-in: run with RUN_ASANA_LIVE=1 and ASANA_ACCESS_TOKEN (a personal access token).
const live = process.env.RUN_ASANA_LIVE === '1';
(live ? describe : describe.skip)('Asana — live read-only smoke test', () => {
  const token = process.env.ASANA_ACCESS_TOKEN;
  const get = async (path: string) => {
    if (!token) throw new Error('Set ASANA_ACCESS_TOKEN for RUN_ASANA_LIVE=1');
    return fetch('https://app.asana.com/api/1.0' + path, { headers: { Authorization: 'Bearer ' + token } });
  };

  it('reads the token user and pages workspaces', async () => {
    const me = await get('/users/me?opt_fields=name,workspaces.name');
    expect(me.status).toBe(200);
    expect(typeof (await me.json()).data.gid).toBe('string');

    const ws = await get('/workspaces?limit=1&opt_fields=name');
    expect(ws.status).toBe(200);
    const body = await ws.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body).toHaveProperty('next_page');
  });
});
