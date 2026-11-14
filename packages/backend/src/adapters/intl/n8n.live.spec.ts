import * as adapter from './n8n.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * n8n public REST API (docs.n8n.io/api, OpenAPI in n8n-io/n8n packages/cli/src/public-api/v1):
 * base <instance>/api/v1, API key in the X-N8N-API-KEY header, cursor paging through nextCursor.
 * Live part (reads only: workflows, executions, tags, projects):
 *   N8N_URL=https://yourname.app.n8n.cloud N8N_API_KEY=... RUN_N8N_LIVE=1 npx jest src/adapters/intl/n8n
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; healthcheckPath?: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
const PREFIX = 'n8n_';

describe('n8n adapter: static spec conformance', () => {
  it('authenticates with the X-N8N-API-KEY header against the instance URL', () => {
    expect(a.requiredEnvVars).toEqual(['N8N_URL', 'N8N_API_KEY']);
    expect(a.connector.baseUrl).toBe('{{N8N_URL}}/api/v1');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-N8N-API-KEY', apiKey: '{{N8N_API_KEY}}' });
    expect(a.envVarMeta?.N8N_API_KEY.secret).toBe(true);
    expect(a.envVarMeta?.N8N_URL.kind).toBe('address');
    const url = new RegExp(a.envVarMeta?.N8N_URL.pattern as string);
    expect(url.test('https://yourname.app.n8n.cloud')).toBe(true);
    expect(url.test('https://example.com/n8n')).toBe(true);
    expect(url.test('https://n8n.example.com/api/v1')).toBe(false);
    expect(url.test('https://n8n.example.com/')).toBe(false);
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith('/')).toBe(true);
  });

  it('maps the workflow endpoints', () => {
    expect(tool('n8n_list_workflows').endpointMapping).toEqual({
      method: 'GET',
      path: '/workflows',
      queryParams: { active: '$active', tags: '$tags', name: '$name', projectId: '$project_id', excludePinnedData: 'true', limit: '$limit', cursor: '$cursor' },
    });
    expect(tool('n8n_get_workflow').endpointMapping).toMatchObject({ method: 'GET', path: '/workflows/{workflow_id}' });
    expect(tool('n8n_create_workflow').endpointMapping).toEqual({
      method: 'POST',
      path: '/workflows',
      bodyMapping: { name: '$name', nodes: '$nodes', connections: '$connections', settings: '$settings', projectId: '$project_id' },
    });
    expect(tool('n8n_update_workflow').endpointMapping).toMatchObject({ method: 'PUT', path: '/workflows/{workflow_id}', queryParams: { publishIfActive: '$publish_if_active' } });
    expect(tool('n8n_update_workflow').parameters?.required).toEqual(['workflow_id', 'name', 'nodes', 'connections', 'settings']);
    expect(tool('n8n_activate_workflow').endpointMapping).toEqual({ method: 'POST', path: '/workflows/{workflow_id}/activate', bodyMapping: { versionId: '$version_id' } });
    expect(tool('n8n_deactivate_workflow').endpointMapping).toEqual({ method: 'POST', path: '/workflows/{workflow_id}/deactivate' });
    expect(tool('n8n_archive_workflow').endpointMapping.path).toBe('/workflows/{workflow_id}/archive');
    expect(tool('n8n_unarchive_workflow').endpointMapping.path).toBe('/workflows/{workflow_id}/unarchive');
    expect(tool('n8n_delete_workflow').endpointMapping).toEqual({ method: 'DELETE', path: '/workflows/{workflow_id}' });
    expect(tool('n8n_transfer_workflow').endpointMapping).toEqual({ method: 'PUT', path: '/workflows/{workflow_id}/transfer', bodyMapping: { destinationProjectId: '$destination_project_id' } });
    // The tags endpoint takes a bare JSON array [{ id }], sent as the raw body.
    expect(tool('n8n_set_workflow_tags').endpointMapping).toEqual({ method: 'PUT', path: '/workflows/{workflow_id}/tags', bodyMapping: { __raw: '$tags' } });
    expect(tool('n8n_list_workflow_versions').endpointMapping.path).toBe('/workflows/{workflow_id}/history');
    expect(tool('n8n_get_workflow_version').endpointMapping.path).toBe('/workflows/{workflow_id}/versions/{version_id}');
  });

  it('maps executions, credentials and the other resources', () => {
    expect(tool('n8n_list_executions').endpointMapping.queryParams).toEqual({
      workflowId: '$workflow_id',
      projectId: '$project_id',
      status: '$status',
      startedAfter: '$started_after',
      startedBefore: '$started_before',
      includeData: '$include_data',
      limit: '$limit',
      cursor: '$cursor',
    });
    expect(tool('n8n_get_execution').endpointMapping).toEqual({ method: 'GET', path: '/executions/{execution_id}', queryParams: { includeData: '$include_data' } });
    expect(tool('n8n_retry_execution').endpointMapping).toEqual({ method: 'POST', path: '/executions/{execution_id}/retry', bodyMapping: { loadWorkflow: '$load_workflow' } });
    expect(tool('n8n_stop_execution').endpointMapping.path).toBe('/executions/{execution_id}/stop');
    expect(tool('n8n_delete_execution').endpointMapping.method).toBe('DELETE');
    expect(tool('n8n_get_credential_schema').endpointMapping.path).toBe('/credentials/schema/{credential_type}');
    expect(tool('n8n_create_credential').endpointMapping).toEqual({ method: 'POST', path: '/credentials', bodyMapping: { name: '$name', type: '$type', data: '$data', projectId: '$project_id' } });
    expect(tool('n8n_update_credential').endpointMapping).toMatchObject({ method: 'PATCH', path: '/credentials/{credential_id}' });
    expect(tool('n8n_test_credential').endpointMapping).toEqual({ method: 'POST', path: '/credentials/{credential_id}/test' });
    expect(tool('n8n_list_variables').endpointMapping.queryParams).toMatchObject({ projectId: '$project_id', state: '$state' });
    expect(tool('n8n_update_variable').endpointMapping).toMatchObject({ method: 'PUT', path: '/variables/{variable_id}' });
    expect(tool('n8n_add_project_users').endpointMapping).toEqual({ method: 'POST', path: '/projects/{project_id}/users', bodyMapping: { relations: '$relations' } });
    expect(tool('n8n_get_user').endpointMapping.path).toBe('/users/{user_id}');
    expect(tool('n8n_generate_audit').endpointMapping).toEqual({
      method: 'POST',
      path: '/audit',
      bodyMapping: { additionalOptions: { categories: '$categories', daysAbandonedWorkflow: '$days_abandoned_workflow' } },
    });
    expect(tool('n8n_get_source_control_status').endpointMapping.queryParams).toEqual({ direction: '$direction' });
    expect(tool('n8n_source_control_pull').endpointMapping).toEqual({ method: 'POST', path: '/source-control/pull', bodyMapping: { force: '$force', autoPublish: '$auto_publish' } });
  });

  it('drops node definitions from the workflow list and keeps the cursor', () => {
    const out = applyResponseTransform(
      {
        data: [{ id: 'w1', name: 'Sync', active: true, isArchived: false, nodes: [{ name: 'Start', parameters: { big: 'x' } }], connections: {}, settings: {}, tags: [{ id: 't1', name: 'prod' }] }],
        nextCursor: 'abc',
      },
      tool('n8n_list_workflows').responseMapping as never,
    ).value;
    expect(out).toEqual({ data: [{ id: 'w1', name: 'Sync', active: true, isArchived: false, tags: [{ id: 't1', name: 'prod' }] }], nextCursor: 'abc' });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('marks writes and deletes, and the POST reads as read-only', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping.method;
      if (m === 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint === false}`).toBe(`${t.name}:false`);
      if (m === 'DELETE') expect(`${t.name}:${t.annotations?.destructiveHint}`).toBe(`${t.name}:true`);
      if (m !== 'GET') expect(`${t.name}:${typeof t.annotations?.readOnlyHint}`).toBe(`${t.name}:boolean`);
    }
    expect(tool('n8n_generate_audit').annotations?.readOnlyHint).toBe(true);
    expect(tool('n8n_test_credential').annotations?.readOnlyHint).toBe(true);
    for (const n of ['n8n_update_workflow', 'n8n_deactivate_workflow', 'n8n_archive_workflow', 'n8n_set_workflow_tags', 'n8n_source_control_pull', 'n8n_update_credential']) {
      expect(`${n}:${tool(n).annotations?.destructiveHint}`).toBe(`${n}:true`);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_N8N_LIVE === '1' && process.env.N8N_URL && process.env.N8N_API_KEY ? describe : describe.skip;
live('n8n adapter: live (read-only)', () => {
  const base = `${process.env.N8N_URL}/api/v1`;
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { 'X-N8N-API-KEY': process.env.N8N_API_KEY as string, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as { data: unknown[]; nextCursor?: string | null };
  };
  it('lists workflows, executions and tags, and reads the first workflow', async () => {
    const workflows = await get('/workflows?limit=2&excludePinnedData=true');
    expect(Array.isArray(workflows.data)).toBe(true);
    const first = workflows.data[0] as { id: string } | undefined;
    if (first) expect(((await fetch(`${base}/workflows/${first.id}`, { headers: { 'X-N8N-API-KEY': process.env.N8N_API_KEY as string } })).status)).toBe(200);
    expect(Array.isArray((await get('/executions?limit=2')).data)).toBe(true);
    expect(Array.isArray((await get('/tags?limit=2')).data)).toBe(true);
  }, 60_000);
});
