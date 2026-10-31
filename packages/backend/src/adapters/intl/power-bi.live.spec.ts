import * as adapter from './power-bi.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Power BI REST API (learn.microsoft.com/rest/api/power-bi, Swagger in
 * github.com/microsoft/PowerBI-CSharp sdk/swaggers/swagger.json): base
 * https://api.powerbi.com/v1.0/myorg, delegated OAuth 2.0 with Microsoft Entra ID
 * (scope https://analysis.windows.net/powerbi/api/.default offline_access).
 * Live part (reads only: workspaces, My workspace datasets and reports, apps, gateways):
 *   POWER_BI_ACCESS_TOKEN=<delegated access token> RUN_POWER_BI_LIVE=1 npx jest src/adapters/intl/power-bi
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; type?: string; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
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
  // OData keys ($top, $skip, $filter) are literal parameter names, not references.
  walk(Object.values(m.queryParams ?? {}));
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
const PREFIX = 'power_bi_';
const WRITES = ['power_bi_refresh_dataset', 'power_bi_cancel_refresh', 'power_bi_refresh_dataflow', 'power_bi_update_dataset_parameters'];
const OFF = ['power_bi_update_dataset_parameters'];
const DS = '/groups/{group_id}/datasets/{dataset_id}';

describe('power-bi adapter: static spec conformance', () => {
  it('signs in with Microsoft Entra ID for the Power BI resource and keeps a refresh token', () => {
    expect(a.slug).toBe('power-bi');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('analytics');
    expect(a.icon).toBe('power-bi');
    expect(a.requiredEnvVars).toEqual(['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID']);
    expect(a.connector.baseUrl).toBe('https://api.powerbi.com/v1.0/myorg');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{MICROSOFT_CLIENT_ID}}',
      clientSecret: '{{MICROSOFT_CLIENT_SECRET}}',
      authorizationUrl: 'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/token',
      scopes: 'https://analysis.windows.net/powerbi/api/.default offline_access',
    });
    expect(a.envVarMeta?.MICROSOFT_CLIENT_SECRET.secret).toBe(true);
    const tenant = new RegExp(a.envVarMeta?.MICROSOFT_TENANT_ID.pattern as string);
    for (const ok of ['organizations', 'aaaabbbb-0000-cccc-1111-dddd2222eeee', 'contoso.onmicrosoft.com']) expect(tenant.test(ok)).toBe(true);
    for (const bad of ['common', 'consumers']) expect(tenant.test(bad)).toBe(false);
  });

  it('maps workspace, semantic model and refresh reads to the documented routes', () => {
    expect(tool('power_bi_list_workspaces').endpointMapping).toEqual({ method: 'GET', path: '/groups', queryParams: { $filter: '$filter', $top: '$top', $skip: '$skip' } });
    expect(tool('power_bi_get_workspace').endpointMapping).toEqual({ method: 'GET', path: '/groups/{group_id}' });
    expect(tool('power_bi_list_workspace_users').endpointMapping).toEqual({ method: 'GET', path: '/groups/{group_id}/users', queryParams: { $top: '$top', $skip: '$skip' } });
    expect(tool('power_bi_list_datasets').endpointMapping).toEqual({ method: 'GET', path: '/groups/{group_id}/datasets' });
    expect(tool('power_bi_list_my_datasets').endpointMapping).toEqual({ method: 'GET', path: '/datasets' });
    expect(tool('power_bi_get_dataset').endpointMapping.path).toBe(DS);
    expect(tool('power_bi_list_dataset_datasources').endpointMapping.path).toBe(`${DS}/datasources`);
    expect(tool('power_bi_list_dataset_parameters').endpointMapping.path).toBe(`${DS}/parameters`);
    expect(tool('power_bi_get_refresh_history').endpointMapping).toEqual({ method: 'GET', path: `${DS}/refreshes`, queryParams: { $top: '$top' } });
    expect(tool('power_bi_get_refresh_details').endpointMapping.path).toBe(`${DS}/refreshes/{refresh_id}`);
    expect(tool('power_bi_get_refresh_schedule').endpointMapping.path).toBe(`${DS}/refreshSchedule`);
  });

  it('runs DAX through executeQueries with one query and is marked read-only', () => {
    expect(tool('power_bi_execute_dax_query').endpointMapping).toEqual({
      method: 'POST',
      path: '/datasets/{dataset_id}/executeQueries',
      bodyMapping: { queries: [{ query: '$query' }], serializerSettings: { includeNulls: '$include_nulls' }, impersonatedUserName: '$impersonated_user_name' },
    });
    expect(tool('power_bi_execute_dax_query').parameters?.required).toEqual(['dataset_id', 'query']);
    expect(tool('power_bi_execute_dax_query').annotations?.readOnlyHint).toBe(true);
  });

  it('maps reports, dashboards, dataflows, gateways, apps and imports', () => {
    expect(tool('power_bi_list_reports').endpointMapping.path).toBe('/groups/{group_id}/reports');
    expect(tool('power_bi_list_my_reports').endpointMapping.path).toBe('/reports');
    expect(tool('power_bi_get_report').endpointMapping.path).toBe('/groups/{group_id}/reports/{report_id}');
    expect(tool('power_bi_list_report_pages').endpointMapping.path).toBe('/groups/{group_id}/reports/{report_id}/pages');
    expect(tool('power_bi_list_dashboards').endpointMapping.path).toBe('/groups/{group_id}/dashboards');
    expect(tool('power_bi_list_my_dashboards').endpointMapping.path).toBe('/dashboards');
    expect(tool('power_bi_list_dashboard_tiles').endpointMapping.path).toBe('/groups/{group_id}/dashboards/{dashboard_id}/tiles');
    expect(tool('power_bi_list_dataflows').endpointMapping.path).toBe('/groups/{group_id}/dataflows');
    expect(tool('power_bi_list_dataflow_transactions').endpointMapping.path).toBe('/groups/{group_id}/dataflows/{dataflow_id}/transactions');
    expect(tool('power_bi_list_dataflow_datasources').endpointMapping.path).toBe('/groups/{group_id}/dataflows/{dataflow_id}/datasources');
    expect(tool('power_bi_list_gateways').endpointMapping.path).toBe('/gateways');
    expect(tool('power_bi_list_gateway_datasources').endpointMapping.path).toBe('/gateways/{gateway_id}/datasources');
    expect(tool('power_bi_get_gateway_datasource_status').endpointMapping.path).toBe('/gateways/{gateway_id}/datasources/{datasource_id}/status');
    expect(tool('power_bi_list_apps').endpointMapping.path).toBe('/apps');
    expect(tool('power_bi_get_app').endpointMapping.path).toBe('/apps/{app_id}');
    expect(tool('power_bi_list_app_reports').endpointMapping.path).toBe('/apps/{app_id}/reports');
    expect(tool('power_bi_list_app_dashboards').endpointMapping.path).toBe('/apps/{app_id}/dashboards');
    expect(tool('power_bi_list_imports').endpointMapping.path).toBe('/groups/{group_id}/imports');
    expect(tool('power_bi_get_import').endpointMapping.path).toBe('/groups/{group_id}/imports/{import_id}');
  });

  it('maps refreshes with the documented body names; enhanced options stay optional', () => {
    expect(tool('power_bi_refresh_dataset').endpointMapping).toEqual({
      method: 'POST',
      path: `${DS}/refreshes`,
      bodyMapping: { notifyOption: '$notify_option', type: '$type', commitMode: '$commit_mode', objects: '$objects', maxParallelism: '$max_parallelism', retryCount: '$retry_count', applyRefreshPolicy: '$apply_refresh_policy', effectiveDate: '$effective_date', timeout: '$timeout' },
    });
    // notifyOption must be left out of an enhanced refresh, so it has no default.
    expect(tool('power_bi_refresh_dataset').parameters?.properties?.notify_option.default).toBeUndefined();
    expect(tool('power_bi_refresh_dataset').parameters?.required).toEqual(['group_id', 'dataset_id']);
    expect(tool('power_bi_cancel_refresh').endpointMapping).toEqual({ method: 'DELETE', path: `${DS}/refreshes/{refresh_id}` });
    expect(tool('power_bi_refresh_dataflow').endpointMapping).toEqual({ method: 'POST', path: '/groups/{group_id}/dataflows/{dataflow_id}/refreshes', queryParams: { processType: '$process_type' }, bodyMapping: { notifyOption: '$notify_option' } });
    expect(tool('power_bi_refresh_dataflow').parameters?.properties?.notify_option).toMatchObject({ enum: ['NoNotification', 'MailOnFailure'], default: 'NoNotification' });
    expect(tool('power_bi_update_dataset_parameters').endpointMapping).toEqual({ method: 'POST', path: `${DS}/Default.UpdateParameters`, bodyMapping: { updateDetails: '$update_details' } });
  });

  it('drops user lists and embed URLs from list answers', () => {
    const out = applyResponseTransform(
      { value: [{ id: 'r1', name: 'Sales', datasetId: 'd1', webUrl: 'w', embedUrl: 'e', users: [{ emailAddress: 'x' }], subscriptions: [] }] },
      tool('power_bi_list_reports').responseMapping as never,
    ).value;
    expect(out).toEqual({ value: [{ id: 'r1', name: 'Sales', datasetId: 'd1', webUrl: 'w' }] });
    const ds = applyResponseTransform(
      { value: [{ id: 'd1', name: 'Model', isRefreshable: true, users: [], createReportEmbedURL: 'c', qnaEmbedURL: 'q', upstreamDataflows: [] }] },
      tool('power_bi_list_datasets').responseMapping as never,
    ).value;
    expect(ds).toEqual({ value: [{ id: 'd1', name: 'Model', isRefreshable: true }] });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('annotates the writes, installs the parameter update switched off and keeps the other reads on GET', () => {
    const writes = a.tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name).sort();
    expect(writes).toEqual([...WRITES].sort());
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(OFF);
    for (const t of a.tools) {
      if (WRITES.includes(t.name) || t.name === 'power_bi_execute_dax_query') continue;
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
    }
    expect(tool('power_bi_cancel_refresh').annotations?.destructiveHint).toBe(true);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe.tool).toBe('power_bi_list_workspaces');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_POWER_BI_LIVE === '1' && process.env.POWER_BI_ACCESS_TOKEN ? describe : describe.skip;
live('power-bi adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Bearer ${process.env.POWER_BI_ACCESS_TOKEN}`, Accept: 'application/json' } });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return (await res.json()) as { value: Array<{ id: string }> };
  };
  it('reads workspaces, My workspace content, apps and gateways', async () => {
    const groups = await get('/groups?$top=5');
    expect(Array.isArray(groups.value)).toBe(true);
    expect(Array.isArray((await get('/datasets')).value)).toBe(true);
    expect(Array.isArray((await get('/reports')).value)).toBe(true);
    expect(Array.isArray((await get('/apps')).value)).toBe(true);
    expect(Array.isArray((await get('/gateways')).value)).toBe(true);
    if (groups.value[0]) expect(Array.isArray((await get(`/groups/${groups.value[0].id}/datasets`)).value)).toBe(true);
  }, 60_000);
});
