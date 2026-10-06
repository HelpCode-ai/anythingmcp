import * as adapter from './moco.json';

type Tool = {
  name: string;
  parameters: { required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, string>;
    bodyMapping?: Record<string, string>;
  };
  annotations?: unknown;
};

const a = adapter as unknown as {
  requiredEnvVars: string[];
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: { token: string } };
  tools: Tool[];
};
const byName = Object.fromEntries(a.tools.map((tool) => [tool.name, tool]));

describe('MOCO adapter — static contract', () => {
  it('uses a tenant-scoped API URL and the user/account key as a bearer token', () => {
    expect(a.requiredEnvVars).toEqual(['MOCO_SUBDOMAIN', 'MOCO_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://{{MOCO_SUBDOMAIN}}.mocoapp.com/api/v1');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{MOCO_API_KEY}}');
    expect(a.probe.tool).toBe('moco_list_users');
  });

  it('offers the eight requested tools with read-only GETs and one additive POST', () => {
    expect(a.tools.map((tool) => tool.name)).toEqual([
      'moco_list_users',
      'moco_list_projects',
      'moco_get_project',
      'moco_list_activities',
      'moco_list_companies',
      'moco_list_invoices',
      'moco_report_utilization',
      'moco_create_activity',
    ]);
    expect(a.tools.every((tool) => tool.name.startsWith('moco_'))).toBe(true);
    expect(a.tools.filter((tool) => tool.endpointMapping.method === 'POST').map((tool) => tool.name)).toEqual(['moco_create_activity']);
    expect(a.tools.every((tool) => tool.endpointMapping.method === 'GET' || tool.endpointMapping.method === 'POST')).toBe(true);
    expect(a.tools.every((tool) => tool.annotations === undefined)).toBe(true);
  });

  it('passes the API filters and required create fields without deprecated hours', () => {
    expect(byName.moco_list_projects.endpointMapping.queryParams).toMatchObject({
      include_archived: '$include_archived',
      company_id: '$company_id',
      updated_after: '$updated_after',
    });
    expect(byName.moco_list_activities.parameters.required).toEqual(['from', 'to']);
    expect(byName.moco_list_activities.endpointMapping.queryParams).toMatchObject({
      from: '$from',
      to: '$to',
      billable: '$billable',
    });
    expect(byName.moco_create_activity.parameters.required).toEqual(['date', 'project_id', 'task_id', 'seconds']);
    expect(byName.moco_create_activity.endpointMapping.bodyMapping).toEqual({
      date: '$date',
      project_id: '$project_id',
      task_id: '$task_id',
      seconds: '$seconds',
      description: '$description',
    });
  });
});

// Opt-in: run with RUN_MOCO_LIVE=1, MOCO_SUBDOMAIN and MOCO_API_KEY from a trial account.
const live = process.env.RUN_MOCO_LIVE === '1';
(live ? describe : describe.skip)('MOCO — live read-only smoke test', () => {
  it.each(['/users', '/projects'])('lists %s from the configured account', async (path) => {
    const subdomain = process.env.MOCO_SUBDOMAIN;
    const key = process.env.MOCO_API_KEY;
    if (!subdomain || !key) throw new Error('Set MOCO_SUBDOMAIN and MOCO_API_KEY for RUN_MOCO_LIVE=1');

    const response = await fetch('https://' + subdomain + '.mocoapp.com/api/v1' + path, {
      headers: { Authorization: 'Bearer ' + key },
    });
    expect(response.status).toBe(200);
    expect(Array.isArray(await response.json())).toBe(true);
  });
});
