import * as adapter from './tenderplan.json';

/**
 * Tenderplan API (https://tenderplan.ru/api/doc/, OpenAPI 3.0.3, version 3.5.0). Bearer token: a personal
 * access token from the user's profile settings, or an OAuth 2.0 access token of a registered application.
 * Quotas: 100 calls per 10 s and 500 per 60 s; tender lists 60 per minute, tenders/get 300 per minute.
 * Live part (read-only, four calls): RUN_TENDERPLAN_LIVE=1 TENDERPLAN_API_TOKEN=... npx jest src/adapters/intl/tenderplan
 */

type Prop = {
  type?: string;
  default?: unknown;
  pattern?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  description?: string;
  items?: { type?: string; pattern?: string; enum?: unknown[] };
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, Prop>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  region: string;
  icon: string;
  category: string;
  docsUrl: string;
  aliases?: string[];
  description: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { label: string; kind: string; secret?: boolean; help: string; link?: string; pattern?: string; patternMessage?: string }>;
  verifyHints: Record<string, string>;
  probe?: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { type: string; baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments and "$arg" values in query, body and headers.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
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
// Text the website renders as MDX: nothing but backticked code may hold braces or an opening angle bracket.
const outsideBackticks = (text: string) => text.replace(/`[^`]*`/g, '');

const SLUG = 'tenderplan';
const BASE = 'https://tenderplan.ru';
const PREFIX = 'tenderplan_';
const TOKEN_VAR = 'TENDERPLAN_API_TOKEN';
const OBJECT_ID = '^[0-9a-fA-F]{24}$';

// name -> [method, path, required parameters], from the published OpenAPI document.
const TOOLS: Record<string, [string, string, string[]]> = {
  tenderplan_get_firm: ['GET', '/api/info/firm', []],
  tenderplan_get_current_user: ['GET', '/api/info/user', []],
  tenderplan_list_users: ['GET', '/api/users/getall', []],
  tenderplan_list_keys: ['GET', '/api/keys/getall', []],
  tenderplan_list_marks: ['GET', '/api/marks/getall', []],
  tenderplan_list_tenders: ['GET', '/api/tenders/getlist', []],
  tenderplan_filter_tenders: ['GET', '/api/tenders/v2/getlist', []],
  tenderplan_get_tender: ['GET', '/api/tenders/get', ['tender_id']],
  tenderplan_get_tender_related_info: ['GET', '/api/tenders/v2/info', ['tender_id']],
  tenderplan_list_tender_records: ['GET', '/api/tenders/{section}', ['section', 'tender_id']],
  tenderplan_search_tenders: ['POST', '/api/search/v2/list', []],
  tenderplan_find_tender_by_number: ['GET', '/api/search/tender', ['number']],
  tenderplan_list_saved_filters: ['GET', '/api/searchfilters/v2/getall', []],
  tenderplan_list_comments: ['GET', '/api/comments/getall', ['tender_id']],
  tenderplan_add_comment: ['POST', '/api/comments/add', ['tender_id', 'text']],
  tenderplan_list_open_tasks: ['GET', '/api/tasks/getlist', []],
  tenderplan_list_tender_tasks: ['GET', '/api/tasks/getall', ['tender_id']],
  tenderplan_add_task: ['POST', '/api/tasks/add', ['tender_id', 'name']],
  tenderplan_complete_task: ['POST', '/api/tasks/complete', ['task_id']],
  tenderplan_search_organizations: ['GET', '/api/organizations/search', ['query']],
  tenderplan_get_organization: ['GET', '/api/organizations/get', ['organization_id']],
  tenderplan_get_organization_egrul: ['GET', '/api/organizations/data/egrul', ['organization_id']],
  tenderplan_get_organization_contacts: ['GET', '/api/organizations/getcontacts', ['organization_id']],
  tenderplan_list_rnp_records: ['GET', '/api/rnp/v2/getlist', ['participant_id']],
  tenderplan_list_notifications: ['GET', '/api/notifications/v2/getlist', []],
  tenderplan_list_calendar_events: ['GET', '/api/calendar/v2/events', ['from', 'to']],
  tenderplan_list_reference_values: ['GET', '/api/tools/{list_name}/list', ['list_name']],
  tenderplan_add_tender_marks: ['POST', '/api/relations/marks/add', ['tender_id', 'mark_ids']],
  tenderplan_mark_tenders_read: ['POST', '/api/relations/read', ['tender_ids']],
  tenderplan_remove_tender_marks: ['POST', '/api/relations/marks/remove', ['tender_id', 'mark_ids']],
};
// Tools that change something in Tenderplan. tenderplan_search_tenders is a POST that only reads.
const WRITE_TOOLS = [
  'tenderplan_add_comment',
  'tenderplan_add_task',
  'tenderplan_complete_task',
  'tenderplan_add_tender_marks',
  'tenderplan_mark_tenders_read',
  'tenderplan_remove_tender_marks',
];
const SWITCHED_OFF = ['tenderplan_remove_tender_marks'];

describe('tenderplan adapter: static spec conformance', () => {
  it('is a bearer token REST adapter with the expected envelope', () => {
    expect(a.slug).toBe(SLUG);
    expect(a.name).toBe('Tenderplan');
    expect(a.region).toBe('intl');
    expect(a.icon).toBe(SLUG);
    expect(a.category).toBe('data');
    expect(a.docsUrl).toBe('https://tenderplan.ru/api/doc/');
    expect(a.requiredEnvVars).toEqual([TOKEN_VAR]);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: `{{${TOKEN_VAR}}}` });
    expect(a.connector.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'AnythingMCP' });
    expect(a.aliases).toContain('Тендерплан');
    for (const alias of a.aliases ?? []) expect(alias.length).toBeLessThanOrEqual(40);
  });

  it('describes the token variable as a secret with a loose pattern', () => {
    expect(Object.keys(a.envVarMeta)).toEqual([TOKEN_VAR]);
    const meta = a.envVarMeta[TOKEN_VAR];
    expect(meta.kind).toBe('credential');
    expect(meta.secret).toBe(true);
    expect(meta.link).toBe('https://tenderplan.ru/api/doc/');
    const re = new RegExp(meta.pattern ?? '');
    expect(re.test('96b1c0ffee0123456789abcdef0123456789d53f')).toBe(true);
    expect(re.test('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl')).toBe(true);
    expect(re.test('Bearer 96b1c0ffee0123456789abcdef0123456789d53f')).toBe(false);
    expect(meta.patternMessage).toBeTruthy();
    expect(Object.keys(a.verifyHints).sort()).toEqual(['401', '403', '404', 'rate_limited']);
  });

  it('probes with the firm read, which takes no arguments', () => {
    const p = a.probe!;
    expect(p.tool).toBe('tenderplan_get_firm');
    expect(p.params).toEqual({});
    const t = tool(p.tool);
    expect(t.endpointMapping.method).toBe('GET');
    expect(t.parameters?.required ?? []).toEqual([]);
  });

  it('ships exactly the documented tools with their method, path and required parameters', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOLS).sort());
    expect(a.tools.length).toBe(30);
    for (const [name, [method, path, required]] of Object.entries(TOOLS)) {
      const t = tool(name);
      expect(`${name}:${t.endpointMapping.method}`).toBe(`${name}:${method}`);
      expect(`${name}:${t.endpointMapping.path}`).toBe(`${name}:${path}`);
      expect(`${name}:${[...(t.parameters?.required ?? [])].sort().join(',')}`).toBe(`${name}:${[...required].sort().join(',')}`);
    }
  });

  it('every tool is prefixed, maps every declared argument and requires its path parameters', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
      for (const r of t.parameters?.required ?? []) expect(props).toContain(r);
      for (const [p, def] of Object.entries(t.parameters?.properties ?? {})) expect(`${t.name}:${p}:${Boolean(def.description)}`).toBe(`${t.name}:${p}:true`);
    }
  });

  it('marks reads as read-only, leaves writes unmarked and installs only the mark removal switched off', () => {
    for (const t of a.tools) {
      const isWrite = WRITE_TOOLS.includes(t.name);
      expect(`${t.name}:${t.annotations?.readOnlyHint === true}`).toBe(`${t.name}:${!isWrite}`);
      if (isWrite) expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:POST`);
      expect(`${t.name}:${t.enabled === false}`).toBe(`${t.name}:${SWITCHED_OFF.includes(t.name)}`);
    }
    expect(tool('tenderplan_search_tenders').endpointMapping.method).toBe('POST');
    expect(tool('tenderplan_search_tenders').annotations?.readOnlyHint).toBe(true);
  });

  it('stays away from orders, invoices, payers, sign-in and token management', () => {
    for (const t of a.tools) {
      const path = t.endpointMapping.path;
      expect(path.startsWith('/api/')).toBe(true);
      expect(path).not.toMatch(/^\/api\/(orders|invoice|payers|share|partners|users\/pat|firms\/update|invites)/);
      if (/\/(remove|restore|delete)$/.test(path)) expect(SWITCHED_OFF).toContain(t.name);
    }
  });

  it('documents every tool in the instructions and keeps the texts MDX-safe', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions.startsWith('## Tenderplan\n')).toBe(true);
    expect(a.instructions).toContain(TOKEN_VAR);
    expect(JSON.stringify(a)).not.toMatch(/—/);
    const texts: string[] = [a.description, a.instructions, a.prerequisites, ...Object.values(a.verifyHints)];
    for (const meta of Object.values(a.envVarMeta)) texts.push(meta.help, meta.patternMessage ?? '');
    for (const t of a.tools) {
      texts.push(t.description);
      for (const def of Object.values(t.parameters?.properties ?? {})) texts.push(def.description ?? '');
    }
    for (const text of texts) {
      expect((text.match(/`/g) ?? []).length % 2).toBe(0);
      expect(outsideBackticks(text)).not.toMatch(/[{}<]/);
    }
  });

  it('covers the four endpoints known to work with the documented query and body names', () => {
    expect(tool('tenderplan_get_firm').endpointMapping).toEqual({ method: 'GET', path: '/api/info/firm' });
    expect(tool('tenderplan_get_tender').endpointMapping).toEqual({ method: 'GET', path: '/api/tenders/get', queryParams: { id: '$tender_id' } });
    expect(tool('tenderplan_list_tenders').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/api/tenders/getlist',
      queryParams: {
        key: '$key_id',
        mark: '$mark_id',
        q: '$q',
        isActual: '$is_actual',
        fromSubmissionCloseDateTime: '$from_submission_close',
        toSubmissionCloseDateTime: '$to_submission_close',
        placingWay: '$placing_way',
        kind: '$kind',
        smp: '$smp',
        users: '$user_ids',
        isDeleted: '$is_deleted',
        submissionCloseDateTime: '$sort_submission_close',
        publicationDateTime: '$sort_publication',
        maxPrice: '$sort_max_price',
        isChanged: '$sort_changed',
        isRead: '$sort_read',
        page: '$page',
      },
    });
    const search = tool('tenderplan_search_tenders');
    expect(search.endpointMapping).toMatchObject({
      method: 'POST',
      path: '/api/search/v2/list',
      queryParams: { set: '$set', q: '$q', page: '$page', maxPrice: '$sort_max_price', submissionCloseDateTime: '$sort_submission_close' },
      bodyMapping: { key: '$key', filter: '$filter', marks: '$mark_ids' },
    });
    expect(search.parameters?.properties?.set.enum).toEqual(['actual', 'closed', 'future', 'participants', 'customers', 'products']);
    expect(search.parameters?.properties?.set.default).toBe('actual');
    expect(search.parameters?.properties?.key.type).toBe('object');
    expect(search.parameters?.properties?.filter.type).toBe('object');
  });

  it('maps the version 2 list, the tender records and the reference lists as documented', () => {
    const filter = tool('tenderplan_filter_tenders');
    expect(filter.endpointMapping.queryParams).toMatchObject({
      type: '$subset_type',
      id: '$subset_id',
      statuses: '$statuses',
      marks: '$mark_ids',
      users: '$user_ids',
      fromPublicationDateTime: '$from_publication',
      toPublicationDateTime: '$to_publication',
      placingWays: '$placing_ways',
      kinds: '$kinds',
      commentStatuses: '$comment_statuses',
      taskStatuses: '$task_statuses',
      taskAssignees: '$task_assignee_ids',
    });
    expect(filter.parameters?.properties?.subset_type.enum).toEqual([0, 1, 2, 3, 4, 5]);
    const records = tool('tenderplan_list_tender_records');
    expect(records.endpointMapping.queryParams).toEqual({ id: '$tender_id' });
    expect(records.parameters?.properties?.section.enum).toEqual(['protocols', 'contracts', 'stages', 'explanations', 'complaints', 'bankguarantees', 'rnp', 'attachments']);
    expect(tool('tenderplan_get_tender_related_info').endpointMapping.queryParams).toEqual({ id: '$tender_id' });
    expect(tool('tenderplan_list_reference_values').parameters?.properties?.list_name.enum).toEqual(['statuses', 'placingways', 'types', 'regions']);
    expect(tool('tenderplan_find_tender_by_number').endpointMapping.queryParams).toEqual({ number: '$number', page: '$page' });
    expect(tool('tenderplan_list_rnp_records').endpointMapping.queryParams).toEqual({ participant: '$participant_id' });
    expect(tool('tenderplan_list_calendar_events').endpointMapping.queryParams).toMatchObject({ from: '$from', to: '$to', marks: '$mark_ids', users: '$user_ids' });
    expect(tool('tenderplan_list_notifications').parameters?.properties?.types.items?.enum).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(tool('tenderplan_get_organization_egrul').parameters?.properties?.set.enum).toEqual(['branches', 'agencies', 'founders', 'changes', 'arbitration']);
    expect(tool('tenderplan_search_organizations').parameters?.properties?.size.maximum).toBe(50);
  });

  it('pins the bodies of the write tools', () => {
    expect(tool('tenderplan_add_comment').endpointMapping.bodyMapping).toEqual({ tenderId: '$tender_id', text: '$text', mentions: '$mention_user_ids' });
    expect(tool('tenderplan_add_task').endpointMapping.bodyMapping).toEqual({
      type: 'task',
      tenderId: '$tender_id',
      name: '$name',
      desc: '$notes',
      assigneeId: '$assignee_id',
      dueAt: '$due_at',
      dueReminderAt: '$reminder_at',
    });
    expect(tool('tenderplan_complete_task').endpointMapping.bodyMapping).toEqual({ _id: '$task_id', complete: '$complete' });
    expect(tool('tenderplan_complete_task').parameters?.properties?.complete.default).toBe(true);
    expect(tool('tenderplan_add_tender_marks').endpointMapping.bodyMapping).toEqual({ tenders: ['$tender_id'], marks: '$mark_ids' });
    expect(tool('tenderplan_remove_tender_marks').endpointMapping.bodyMapping).toEqual({ tenders: ['$tender_id'], marks: '$mark_ids' });
    expect(tool('tenderplan_mark_tenders_read').endpointMapping.bodyMapping).toEqual({ tenders: '$tender_ids' });
    expect(tool('tenderplan_mark_tenders_read').parameters?.properties?.tender_ids.maxItems).toBe(100);
  });

  it('validates ids as 24 hex characters and takes none as a task assignee', () => {
    const re = new RegExp(tool('tenderplan_get_tender').parameters?.properties?.tender_id.pattern ?? '');
    expect(tool('tenderplan_get_tender').parameters?.properties?.tender_id.pattern).toBe(OBJECT_ID);
    expect(re.test('507f191e810c19729de860ea')).toBe(true);
    expect(re.test('0373100064625000012')).toBe(false);
    for (const name of ['tenderplan_list_comments', 'tenderplan_list_tender_tasks', 'tenderplan_add_task', 'tenderplan_add_tender_marks']) {
      expect(`${name}:${tool(name).parameters?.properties?.tender_id.pattern}`).toBe(`${name}:${OBJECT_ID}`);
    }
    const assignee = new RegExp(tool('tenderplan_list_open_tasks').parameters?.properties?.assignee_ids.items?.pattern ?? '');
    expect(assignee.test('none')).toBe(true);
    expect(assignee.test('507f191e810c19729de860ea')).toBe(true);
    expect(assignee.test('nobody')).toBe(false);
  });
});

const live = process.env.RUN_TENDERPLAN_LIVE === '1' ? describe : describe.skip;
live('tenderplan adapter: live (read-only)', () => {
  const token = process.env.TENDERPLAN_API_TOKEN ?? '';
  const get = (path: string, withToken = true) =>
    fetch(`${BASE}${path}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'AnythingMCP', ...(withToken ? { Authorization: `Bearer ${token}` } : {}) },
    });

  it('has a token to test with', () => {
    expect(token).not.toBe('');
  });

  it('refuses a call without a token and reads the firm with one', async () => {
    expect((await get('/api/info/firm', false)).status).toBe(401);
    const res = await get('/api/info/firm');
    expect(res.status).toBe(200);
    const firm = (await res.json()) as Record<string, unknown>;
    expect(firm && typeof firm === 'object').toBe(true);
  }, 60_000);

  it('reads a reference list and the first page of monitored tenders', async () => {
    const statuses = (await (await get('/api/tools/statuses/list')).json()) as { _id: number; name: string }[];
    expect(statuses.find((s) => s._id === 1)?.name).toBe('Прием заявок');
    const res = await get('/api/tenders/getlist?page=0');
    expect(res.status).toBe(200);
    expect(await res.json()).toBeTruthy();
  }, 60_000);
});
