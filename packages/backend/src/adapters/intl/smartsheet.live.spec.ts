import * as adapter from './smartsheet.json';

/**
 * Smartsheet API 2.0 (developers.smartsheet.com, OpenAPI bundle at
 * developers.smartsheet.com/_bundle/api/smartsheet/openapi.yaml): Bearer access token,
 * one host per region (api.smartsheet.com / .eu / .au / smartsheetgov.com, path /2.0).
 * Live part (reads only: current user, sheets, workspaces, dashboards, reports, search):
 *   SMARTSHEET_ACCESS_TOKEN=... [SMARTSHEET_API_URL=https://api.smartsheet.eu/2.0] RUN_SMARTSHEET_LIVE=1 npx jest src/adapters/intl/smartsheet
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; type?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
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
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
const PREFIX = 'smartsheet_';
const WRITES = [
  'smartsheet_add_rows',
  'smartsheet_update_rows',
  'smartsheet_delete_rows',
  'smartsheet_add_columns',
  'smartsheet_update_column',
  'smartsheet_create_discussion',
  'smartsheet_create_row_discussion',
  'smartsheet_add_comment',
  'smartsheet_create_sheet_in_workspace',
  'smartsheet_create_sheet_in_folder',
  'smartsheet_share_asset',
  'smartsheet_create_update_request',
];
const PAGE = { page: '$page', pageSize: '$page_size', includeAll: '$include_all' };
const TOKEN = { maxItems: '$max_items', lastKey: '$last_key' };

describe('smartsheet adapter: static spec conformance', () => {
  it('authenticates with a Bearer token against the region host the user picks', () => {
    expect(a.slug).toBe('smartsheet');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('project-management');
    expect(a.icon).toBe('smartsheet');
    expect(a.requiredEnvVars).toEqual(['SMARTSHEET_API_URL', 'SMARTSHEET_ACCESS_TOKEN']);
    expect(a.connector.baseUrl).toBe('{{SMARTSHEET_API_URL}}');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{SMARTSHEET_ACCESS_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/users/me');
    expect(a.envVarMeta?.SMARTSHEET_ACCESS_TOKEN.secret).toBe(true);
    const host = new RegExp(a.envVarMeta?.SMARTSHEET_API_URL.pattern as string);
    for (const ok of ['https://api.smartsheet.com/2.0', 'https://api.smartsheet.eu/2.0', 'https://api.smartsheet.au/2.0', 'https://api.smartsheetgov.com/2.0']) expect(host.test(ok)).toBe(true);
    for (const bad of ['https://app.smartsheet.com', 'https://api.smartsheet.com/2.0/', 'https://api.smartsheet.com']) expect(host.test(bad)).toBe(false);
    const token = new RegExp(a.envVarMeta?.SMARTSHEET_ACCESS_TOKEN.pattern as string);
    expect(token.test('ll352u9jujauoqz4gstvsae05u')).toBe(true);
    expect(token.test('Bearer ll352u9jujauoqz4gstvsae05u')).toBe(false);
  });

  it('maps sheet, row, column and search reads to the documented routes and query names', () => {
    expect(tool('smartsheet_get_current_user').endpointMapping).toEqual({ method: 'GET', path: '/users/me', queryParams: { include: '$include' } });
    expect(tool('smartsheet_list_sheets').endpointMapping).toEqual({ method: 'GET', path: '/sheets', queryParams: { modifiedSince: '$modified_since', ...PAGE } });
    expect(tool('smartsheet_get_sheet').endpointMapping).toEqual({
      method: 'GET',
      path: '/sheets/{sheet_id}',
      queryParams: { columnIds: '$column_ids', rowIds: '$row_ids', rowNumbers: '$row_numbers', rowsModifiedSince: '$rows_modified_since', filterId: '$filter_id', include: '$include', exclude: '$exclude', level: '$level', page: '$page', pageSize: '$page_size' },
    });
    expect(tool('smartsheet_get_row').endpointMapping.path).toBe('/sheets/{sheet_id}/rows/{row_id}');
    expect(tool('smartsheet_search_sheet').endpointMapping).toEqual({ method: 'GET', path: '/search/sheets/{sheet_id}', queryParams: { query: '$query' } });
    expect(tool('smartsheet_search').endpointMapping).toEqual({ method: 'GET', path: '/search', queryParams: { query: '$query', scopes: '$scopes', modifiedSince: '$modified_since', include: '$include' } });
    expect(tool('smartsheet_list_columns').endpointMapping).toEqual({ method: 'GET', path: '/sheets/{sheet_id}/columns', queryParams: { level: '$level', ...PAGE } });
    expect(tool('smartsheet_get_cell_history').endpointMapping.path).toBe('/sheets/{sheet_id}/rows/{row_id}/columns/{column_id}/history');
    expect(tool('smartsheet_get_sheet_summary').endpointMapping.path).toBe('/sheets/{sheet_id}/summary');
    expect(tool('smartsheet_list_discussions').endpointMapping).toEqual({ method: 'GET', path: '/sheets/{sheet_id}/discussions', queryParams: { include: '$include', ...PAGE } });
    expect(tool('smartsheet_list_row_discussions').endpointMapping.path).toBe('/sheets/{sheet_id}/rows/{row_id}/discussions');
    expect(tool('smartsheet_list_attachments').endpointMapping).toEqual({ method: 'GET', path: '/sheets/{sheet_id}/attachments', queryParams: PAGE });
    expect(tool('smartsheet_list_row_attachments').endpointMapping.path).toBe('/sheets/{sheet_id}/rows/{row_id}/attachments');
    expect(tool('smartsheet_get_attachment').endpointMapping.path).toBe('/sheets/{sheet_id}/attachments/{attachment_id}');
  });

  it('uses the current metadata and children routes, token paging and the /shares API', () => {
    expect(tool('smartsheet_list_workspaces').endpointMapping).toEqual({ method: 'GET', path: '/workspaces', queryParams: TOKEN });
    expect(tool('smartsheet_get_workspace').endpointMapping).toEqual({ method: 'GET', path: '/workspaces/{workspace_id}/metadata' });
    expect(tool('smartsheet_list_workspace_children').endpointMapping).toEqual({ method: 'GET', path: '/workspaces/{workspace_id}/children', queryParams: { childrenResourceTypes: '$children_resource_types', include: '$include', ...TOKEN } });
    expect(tool('smartsheet_get_folder').endpointMapping).toEqual({ method: 'GET', path: '/folders/{folder_id}/metadata' });
    expect(tool('smartsheet_list_folder_children').endpointMapping.path).toBe('/folders/{folder_id}/children');
    expect(tool('smartsheet_list_dashboards').endpointMapping).toEqual({ method: 'GET', path: '/sights', queryParams: TOKEN });
    expect(tool('smartsheet_get_dashboard').endpointMapping.path).toBe('/sights/{sight_id}');
    expect(tool('smartsheet_list_reports').endpointMapping.path).toBe('/reports');
    expect(tool('smartsheet_get_report').endpointMapping.path).toBe('/reports/{report_id}');
    expect(tool('smartsheet_list_users').endpointMapping).toEqual({ method: 'GET', path: '/users', queryParams: { email: '$email', include: '$include', ...PAGE } });
    expect(tool('smartsheet_get_user').endpointMapping.path).toBe('/users/{user_id}');
    expect(tool('smartsheet_list_shares').endpointMapping).toEqual({ method: 'GET', path: '/shares', queryParams: { assetType: '$asset_type', assetId: '$asset_id', sharingInclude: '$sharing_include', ...TOKEN } });
    expect(tool('smartsheet_list_shares').parameters?.properties?.asset_type.enum).toEqual(['sheet', 'report', 'sight', 'workspace']);
    // The deprecated routes (home, personal folder, GET /workspaces/{id}, GET /folders/{id}, per-object /shares) are not used.
    for (const t of a.tools) {
      expect(t.endpointMapping.path).not.toMatch(/^\/(home|folders\/personal)/);
      expect(t.endpointMapping.path).not.toMatch(/^\/(workspaces|folders)\/\{\w+\}$/);
      if (t.endpointMapping.path.endsWith('/shares')) expect(t.endpointMapping.path).toBe('/shares');
    }
  });

  it('sends row, column and share lists as the JSON array body the API expects', () => {
    expect(tool('smartsheet_add_rows').endpointMapping).toEqual({
      method: 'POST',
      path: '/sheets/{sheet_id}/rows',
      queryParams: { allowPartialSuccess: '$allow_partial_success', overrideValidation: '$override_validation' },
      bodyMapping: { __raw: '$rows' },
    });
    expect(tool('smartsheet_update_rows').endpointMapping).toMatchObject({ method: 'PUT', path: '/sheets/{sheet_id}/rows', bodyMapping: { __raw: '$rows' } });
    expect(tool('smartsheet_delete_rows').endpointMapping).toEqual({ method: 'DELETE', path: '/sheets/{sheet_id}/rows', queryParams: { ids: '$row_ids', ignoreRowsNotFound: '$ignore_rows_not_found' } });
    expect(tool('smartsheet_add_columns').endpointMapping).toEqual({ method: 'POST', path: '/sheets/{sheet_id}/columns', bodyMapping: { __raw: '$columns' } });
    expect(tool('smartsheet_update_column').endpointMapping).toMatchObject({ method: 'PUT', path: '/sheets/{sheet_id}/columns/{column_id}', bodyMapping: { title: '$title', type: '$type', index: '$index', options: '$options' } });
    expect(tool('smartsheet_share_asset').endpointMapping).toEqual({ method: 'POST', path: '/shares', queryParams: { assetType: '$asset_type', assetId: '$asset_id', sendEmail: '$send_email' }, bodyMapping: { __raw: '$shares' } });
    for (const n of ['smartsheet_add_rows', 'smartsheet_update_rows', 'smartsheet_add_columns', 'smartsheet_share_asset']) {
      const raw = (tool(n).endpointMapping.bodyMapping as { __raw: string }).__raw.slice(1);
      expect(tool(n).parameters?.properties?.[raw].type).toBe('array');
    }
  });

  it('maps comments, sheet creation and update requests with the documented body fields', () => {
    expect(tool('smartsheet_create_discussion').endpointMapping).toEqual({ method: 'POST', path: '/sheets/{sheet_id}/discussions', bodyMapping: { comment: { text: '$text' } } });
    expect(tool('smartsheet_create_row_discussion').endpointMapping).toEqual({ method: 'POST', path: '/sheets/{sheet_id}/rows/{row_id}/discussions', bodyMapping: { comment: { text: '$text' } } });
    expect(tool('smartsheet_add_comment').endpointMapping).toEqual({ method: 'POST', path: '/sheets/{sheet_id}/discussions/{discussion_id}/comments', bodyMapping: { text: '$text' } });
    expect(tool('smartsheet_create_sheet_in_workspace').endpointMapping).toEqual({ method: 'POST', path: '/workspaces/{workspace_id}/sheets', queryParams: { include: '$include' }, bodyMapping: { name: '$name', columns: '$columns', fromId: '$from_id' } });
    expect(tool('smartsheet_create_sheet_in_folder').endpointMapping.path).toBe('/folders/{folder_id}/sheets');
    expect(tool('smartsheet_create_update_request').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/sheets/{sheet_id}/updaterequests',
      bodyMapping: { sendTo: '$send_to', rowIds: '$row_ids', columnIds: '$column_ids', subject: '$subject', message: '$message', ccMe: '$cc_me', includeAttachments: '$include_attachments', includeDiscussions: '$include_discussions' },
    });
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

  it('annotates every write, marks deletes and changes destructive, and keeps the reads on GET', () => {
    const writes = a.tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name).sort();
    expect(writes).toEqual([...WRITES].sort());
    for (const t of a.tools) {
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:${t.name === 'smartsheet_delete_rows' ? false : undefined}`);
      if (!WRITES.includes(t.name)) expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      if (['PUT', 'DELETE'].includes(t.endpointMapping.method)) expect(`${t.name}:${t.annotations?.destructiveHint}`).toBe(`${t.name}:true`);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe.tool).toBe('smartsheet_get_current_user');
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_SMARTSHEET_LIVE === '1' && process.env.SMARTSHEET_ACCESS_TOKEN ? describe : describe.skip;
live('smartsheet adapter: live (read-only)', () => {
  const base = process.env.SMARTSHEET_API_URL || 'https://api.smartsheet.com/2.0';
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${process.env.SMARTSHEET_ACCESS_TOKEN}`, Accept: 'application/json' } });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads the current user, sheets, workspaces, dashboards, reports and a sheet', async () => {
    const me = await get('/users/me');
    expect(typeof me.email).toBe('string');
    const sheets = await get('/sheets?pageSize=5');
    expect(Array.isArray(sheets.data)).toBe(true);
    expect(Array.isArray((await get('/workspaces?maxItems=100')).data)).toBe(true);
    expect(Array.isArray((await get('/sights?maxItems=100')).data)).toBe(true);
    expect(Array.isArray((await get('/reports')).data)).toBe(true);
    const first = (sheets.data as Array<{ id: number }>)[0];
    if (first) {
      const sheet = await get(`/sheets/${first.id}?pageSize=5&page=1`);
      expect(Array.isArray(sheet.columns)).toBe(true);
      expect(Array.isArray((await get(`/sheets/${first.id}/columns`)).data)).toBe(true);
    }
  }, 60_000);
});
