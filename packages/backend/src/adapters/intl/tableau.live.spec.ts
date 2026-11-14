import * as adapter from './tableau.json';

/**
 * Tableau REST API 3.23 (help.tableau.com/current/api/rest_api), VizQL Data Service
 * (/api/v1/vizql-data-service) and Metadata API (/api/metadata/graphql). Sign-in with a
 * personal access token at /api/3.23/auth/signin returns credentials.token, sent on every
 * call as X-Tableau-Auth; site-scoped paths need the site LUID from /sessions/current.
 * Live part (reads only: session, projects, workbooks, views, data sources):
 *   TABLEAU_SERVER_URL=https://prod-useast-a.online.tableau.com TABLEAU_SITE=acme TABLEAU_PAT_NAME=... TABLEAU_PAT_SECRET=... RUN_TABLEAU_LIVE=1 npx jest src/adapters/intl/tableau
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta?: Record<string, { secret?: boolean }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string>; healthcheckPath?: string };
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
const PREFIX = 'tableau_';
const V = '/api/3.23';
const SITE = `${V}/sites/{site_id}`;
const LISTQ = { filter: '$filter', sort: '$sort', fields: '$fields', pageSize: '$page_size', pageNumber: '$page_number' };

describe('tableau adapter: static spec conformance', () => {
  it('signs in with a personal access token and sends the session token as X-Tableau-Auth', () => {
    expect(a.requiredEnvVars).toEqual(['TABLEAU_SERVER_URL', 'TABLEAU_PAT_NAME', 'TABLEAU_PAT_SECRET']);
    expect(a.optionalEnvVars).toEqual(['TABLEAU_SITE']);
    expect(a.connector.baseUrl).toBe('{{TABLEAU_SERVER_URL}}');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toMatchObject({
      loginUrl: `{{TABLEAU_SERVER_URL}}${V}/auth/signin`,
      loginMethod: 'POST',
      loginHeaders: { 'Content-Type': 'application/json', Accept: 'application/json' },
      loginBody: { credentials: { personalAccessTokenName: '${username}', personalAccessTokenSecret: '${password}', site: { contentUrl: '{{TABLEAU_SITE}}' } } },
      username: '{{TABLEAU_PAT_NAME}}',
      password: '{{TABLEAU_PAT_SECRET}}',
      tokenJsonPath: 'credentials.token',
      refreshOn401: true,
      headerName: 'X-Tableau-Auth',
      headerTemplate: '${token}',
    });
    expect(a.connector.headers).toEqual({ Accept: 'application/json' });
    expect(a.connector.healthcheckPath).toBe(`${V}/serverinfo`);
    expect(a.envVarMeta?.TABLEAU_PAT_SECRET.secret).toBe(true);
  });

  it('uses the versioned REST base everywhere except search, VizQL Data Service and Metadata API', () => {
    const unversioned = a.tools.filter((t) => !t.endpointMapping.path.startsWith(`${V}/`)).map((t) => `${t.name} ${t.endpointMapping.path}`).sort();
    expect(unversioned).toEqual([
      'tableau_metadata_query /api/metadata/graphql',
      'tableau_query_datasource /api/v1/vizql-data-service/query-datasource',
      'tableau_read_datasource_metadata /api/v1/vizql-data-service/read-metadata',
      'tableau_search_content /api/-/search',
    ]);
  });

  it('maps the content reads with the documented filter, sort and paging keys', () => {
    expect(tool('tableau_get_current_session').endpointMapping).toEqual({ method: 'GET', path: `${V}/sessions/current` });
    expect(tool('tableau_list_projects').endpointMapping).toEqual({ method: 'GET', path: `${SITE}/projects`, queryParams: LISTQ });
    expect(tool('tableau_list_workbooks').endpointMapping).toEqual({ method: 'GET', path: `${SITE}/workbooks`, queryParams: LISTQ });
    expect(tool('tableau_list_datasources').endpointMapping).toEqual({ method: 'GET', path: `${SITE}/datasources`, queryParams: LISTQ });
    expect(tool('tableau_list_users').endpointMapping).toEqual({ method: 'GET', path: `${SITE}/users`, queryParams: LISTQ });
    expect(tool('tableau_list_groups').endpointMapping).toEqual({ method: 'GET', path: `${SITE}/groups`, queryParams: LISTQ });
    expect(tool('tableau_list_jobs').endpointMapping).toEqual({ method: 'GET', path: `${SITE}/jobs`, queryParams: LISTQ });
    expect(tool('tableau_list_views').endpointMapping).toEqual({ method: 'GET', path: `${SITE}/views`, queryParams: { ...LISTQ, includeUsageStatistics: '$include_usage_statistics' } });
    expect(tool('tableau_list_workbook_views').endpointMapping.path).toBe(`${SITE}/workbooks/{workbook_id}/views`);
    expect(tool('tableau_list_workbook_connections').endpointMapping.path).toBe(`${SITE}/workbooks/{workbook_id}/connections`);
    expect(tool('tableau_list_datasource_connections').endpointMapping.path).toBe(`${SITE}/datasources/{datasource_id}/connections`);
    expect(tool('tableau_list_user_groups').endpointMapping.path).toBe(`${SITE}/users/{user_id}/groups`);
    expect(tool('tableau_list_group_users').endpointMapping.path).toBe(`${SITE}/groups/{group_id}/users`);
    expect(tool('tableau_get_job').endpointMapping.path).toBe(`${SITE}/jobs/{job_id}`);
    expect(tool('tableau_list_extract_refresh_tasks').endpointMapping.path).toBe(`${SITE}/tasks/extractRefreshes`);
    expect(tool('tableau_search_content').endpointMapping.queryParams).toEqual({ terms: '$terms', filter: '$filter', order_by: '$order_by', limit: '$limit', page: '$page' });
  });

  it('renders views as data, image, PDF and Excel with vf_ filters merged into the query', () => {
    expect(tool('tableau_get_view_data').endpointMapping).toEqual({ method: 'GET', path: `${SITE}/views/{view_id}/data`, queryParams: { maxAge: '$max_age', __merge: '$filters' } });
    expect(tool('tableau_get_view_image').endpointMapping).toEqual({
      method: 'GET',
      path: `${SITE}/views/{view_id}/image`,
      queryParams: { resolution: '$resolution', vizWidth: '$viz_width', vizHeight: '$viz_height', maxAge: '$max_age', __merge: '$filters' },
    });
    expect(tool('tableau_get_view_pdf').endpointMapping).toEqual({ method: 'GET', path: `${SITE}/views/{view_id}/pdf`, queryParams: { type: '$type', orientation: '$orientation', maxAge: '$max_age', __merge: '$filters' } });
    expect(tool('tableau_download_view_crosstab_excel').endpointMapping.path).toBe(`${SITE}/views/{view_id}/crosstab/excel`);
    expect(tool('tableau_get_workbook_pdf').endpointMapping.path).toBe(`${SITE}/workbooks/{workbook_id}/pdf`);
    expect(tool('tableau_get_view_pdf').parameters?.properties?.type.enum).toContain('A4');
  });

  it('queries data sources through VizQL Data Service and lineage through the Metadata API, read-only over POST', () => {
    expect(tool('tableau_read_datasource_metadata').endpointMapping.bodyMapping).toEqual({ datasource: { datasourceLuid: '$datasource_id' } });
    expect(tool('tableau_query_datasource').endpointMapping.bodyMapping).toEqual({ datasource: { datasourceLuid: '$datasource_id' }, query: '$query', options: '$options' });
    expect(tool('tableau_metadata_query').endpointMapping.bodyMapping).toEqual({ query: '$query', variables: '$variables' });
    for (const n of ['read_datasource_metadata', 'query_datasource', 'metadata_query']) expect(tool(PREFIX + n).annotations?.readOnlyHint).toBe(true);
  });

  it('maps the writes with the documented JSON bodies', () => {
    expect(tool('tableau_refresh_workbook').endpointMapping).toEqual({ method: 'POST', path: `${SITE}/workbooks/{workbook_id}/refresh`, bodyMapping: {} });
    expect(tool('tableau_refresh_datasource').endpointMapping).toEqual({ method: 'POST', path: `${SITE}/datasources/{datasource_id}/refresh`, bodyMapping: {} });
    expect(tool('tableau_run_extract_refresh_task').endpointMapping).toEqual({ method: 'POST', path: `${SITE}/tasks/extractRefreshes/{task_id}/runNow`, bodyMapping: {} });
    expect(tool('tableau_cancel_job').endpointMapping).toEqual({ method: 'PUT', path: `${SITE}/jobs/{job_id}` });
    expect(tool('tableau_create_project').endpointMapping.bodyMapping).toEqual({ project: { name: '$name', description: '$description', parentProjectId: '$parent_project_id', contentPermissions: '$content_permissions' } });
    expect(tool('tableau_update_project').endpointMapping).toMatchObject({ method: 'PUT', path: `${SITE}/projects/{project_id}` });
    expect(tool('tableau_update_workbook').endpointMapping.bodyMapping).toEqual({ workbook: { name: '$name', showTabs: '$show_tabs' } });
    expect(tool('tableau_move_workbook').endpointMapping.bodyMapping).toEqual({ workbook: { project: { id: '$project_id' } } });
    expect(tool('tableau_add_workbook_tags').endpointMapping).toEqual({ method: 'PUT', path: `${SITE}/workbooks/{workbook_id}/tags`, bodyMapping: { tags: { tag: '$tags' } } });
    expect(tool('tableau_add_datasource_tags').endpointMapping).toEqual({ method: 'PUT', path: `${SITE}/datasources/{datasource_id}/tags`, bodyMapping: { tags: { tag: '$tags' } } });
    expect(tool('tableau_add_user_to_group').endpointMapping).toEqual({ method: 'POST', path: `${SITE}/groups/{group_id}/users`, bodyMapping: { user: { id: '$user_id' } } });
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
  });

  it('switches off exactly the job cancel, and says so in the instructions', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['tableau_cancel_job']);
    expect(tool('tableau_cancel_job').annotations?.destructiveHint).toBe(true);
    expect(a.instructions).toContain('**Switched off at install**: `tableau_cancel_job`');
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

  it('probes with a read tool and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const env = process.env;
const live = env.RUN_TABLEAU_LIVE === '1' && env.TABLEAU_SERVER_URL && env.TABLEAU_PAT_NAME && env.TABLEAU_PAT_SECRET ? describe : describe.skip;
live('tableau adapter: live (read-only)', () => {
  const base = String(env.TABLEAU_SERVER_URL).replace(/\/+$/, '');
  let token = '';
  let site = '';
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { 'X-Tableau-Auth': token, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  beforeAll(async () => {
    // Sign-in creates a session; it changes no content.
    const res = await fetch(`${base}${V}/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ credentials: { personalAccessTokenName: env.TABLEAU_PAT_NAME, personalAccessTokenSecret: env.TABLEAU_PAT_SECRET, site: { contentUrl: env.TABLEAU_SITE ?? '' } } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credentials: { token: string; site: { id: string } } };
    token = body.credentials.token;
    site = body.credentials.site.id;
  }, 30_000);
  it('reads the session, projects, workbooks, views and data sources', async () => {
    const session = (await get(`${V}/sessions/current`)) as { session: { site: { id: string } } };
    expect(session.session.site.id).toBe(site);
    for (const [path, key] of [['projects', 'projects'], ['workbooks', 'workbooks'], ['views', 'views'], ['datasources', 'datasources']]) {
      const page = await get(`${V}/sites/${site}/${path}?pageSize=5`);
      expect(page).toHaveProperty('pagination');
      expect(page).toHaveProperty(key);
    }
  }, 60_000);
});
