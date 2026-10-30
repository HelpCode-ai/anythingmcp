import * as adapter from './canny.json';
import { assertNoResponseBodyError } from '../../connectors/engines/response-error.util';

/**
 * Canny API (developers.canny.io/api-reference; no OpenAPI file is published): every call is a POST
 * to https://canny.io/api/v1/... or /api/v2/... with a JSON body that carries the secret key as
 * `apiKey`. Lists page with limit/skip (v1) or limit/cursor (v2).
 * Live part (reads only, all POST: boards, posts, tags, users):
 *   CANNY_API_KEY=... RUN_CANNY_LIVE=1 npx jest src/adapters/intl/canny
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string>; config: { errorWhen: unknown[] } };
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
const PREFIX = 'canny_';
const READS = [
  'canny_list_boards',
  'canny_get_board',
  'canny_list_posts',
  'canny_get_post',
  'canny_list_comments',
  'canny_get_comment',
  'canny_list_votes',
  'canny_list_users',
  'canny_get_user',
  'canny_list_companies',
  'canny_list_categories',
  'canny_list_tags',
  'canny_list_status_changes',
  'canny_list_changelog_entries',
];

describe('canny adapter: static spec conformance', () => {
  it('sends the secret key as apiKey in the JSON body of every POST', () => {
    expect(a.requiredEnvVars).toEqual(['CANNY_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://canny.io');
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.headers?.['Content-Type']).toBe('application/json');
    expect(a.envVarMeta?.CANNY_API_KEY.secret).toBe(true);
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:POST`);
      expect(t.endpointMapping.bodyMapping?.apiKey).toBe('{{CANNY_API_KEY}}');
      expect(t.endpointMapping.queryParams).toBeUndefined();
      expect(t.endpointMapping.path).toMatch(/^\/api\/v[12]\/[a-z_]+\/[a-z_]+$/);
    }
  });

  it('marks every read (a POST at Canny) read-only and leaves the writes unmarked', () => {
    for (const t of a.tools) {
      const isRead = READS.includes(t.name);
      expect(`${t.name}:${t.annotations?.readOnlyHint === true}`).toBe(`${t.name}:${isRead}`);
      for (const verb of ['delete', 'merge', 'link_jira']) expect(t.endpointMapping.path).not.toContain(verb);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
    }
    expect(tool(a.probe.tool).annotations?.readOnlyHint).toBe(true);
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
  });

  it('maps the documented endpoints and body field names', () => {
    expect(tool('canny_list_boards').endpointMapping).toEqual({ method: 'POST', path: '/api/v1/boards/list', bodyMapping: { apiKey: '{{CANNY_API_KEY}}' } });
    expect(tool('canny_list_posts').endpointMapping.bodyMapping).toMatchObject({ boardID: '$board_id', authorID: '$author_id', companyID: '$company_id', tagIDs: '$tag_ids', status: '$status', sort: '$sort', limit: '$limit', skip: '$skip' });
    expect(tool('canny_list_posts').parameters?.properties?.sort.enum).toEqual(['newest', 'oldest', 'relevance', 'score', 'statusChanged', 'trending']);
    expect(tool('canny_get_post').endpointMapping.bodyMapping).toMatchObject({ id: '$id', urlName: '$url_name', boardID: '$board_id' });
    expect(tool('canny_create_post').endpointMapping).toMatchObject({ path: '/api/v1/posts/create', bodyMapping: { authorID: '$author_id', boardID: '$board_id', title: '$title', details: '$details', customFields: '$custom_fields' } });
    expect(tool('canny_update_post').endpointMapping).toMatchObject({ path: '/api/v1/posts/update', bodyMapping: { postID: '$post_id', ownerID: '$owner_id', changerID: '$changer_id' } });
    expect(tool('canny_change_post_status').endpointMapping.bodyMapping).toMatchObject({ postID: '$post_id', status: '$status', changerID: '$changer_id', shouldNotifyVoters: '$should_notify_voters', commentValue: '$comment_value' });
    expect(tool('canny_change_post_status').parameters?.required).toEqual(['post_id', 'status', 'changer_id', 'should_notify_voters']);
    expect(tool('canny_change_post_category').endpointMapping.path).toBe('/api/v1/posts/change_category');
    expect(tool('canny_add_post_tag').endpointMapping.bodyMapping).toMatchObject({ postID: '$post_id', tagID: '$tag_id' });
    expect(tool('canny_remove_post_tag').endpointMapping.path).toBe('/api/v1/posts/remove_tag');
    expect(tool('canny_list_comments').endpointMapping).toMatchObject({ path: '/api/v2/comments/list', bodyMapping: { postID: '$post_id', cursor: '$cursor' } });
    expect(tool('canny_create_comment').endpointMapping.bodyMapping).toMatchObject({ postID: '$post_id', authorID: '$author_id', value: '$value', parentID: '$parent_id', internal: '$internal' });
    expect(tool('canny_list_votes').endpointMapping).toMatchObject({ path: '/api/v2/votes/list', bodyMapping: { postID: '$post_id', userID: '$user_id', cursor: '$cursor' } });
    expect(tool('canny_create_vote').endpointMapping.bodyMapping).toMatchObject({ postID: '$post_id', voterID: '$voter_id', votePriority: '$vote_priority' });
    expect(tool('canny_list_users').endpointMapping.path).toBe('/api/v2/users/list');
    expect(tool('canny_get_user').endpointMapping.bodyMapping).toMatchObject({ id: '$id', email: '$email', userID: '$user_id' });
    expect(tool('canny_create_or_update_user').endpointMapping).toMatchObject({ path: '/api/v1/users/create_or_update', bodyMapping: { name: '$name', userID: '$user_id', companies: '$companies' } });
    expect(tool('canny_list_companies').endpointMapping.path).toBe('/api/v2/companies/list');
    expect(tool('canny_update_company').endpointMapping.bodyMapping).toMatchObject({ id: '$id', monthlySpend: '$monthly_spend' });
    expect(tool('canny_list_categories').endpointMapping.path).toBe('/api/v1/categories/list');
    expect(tool('canny_create_category').endpointMapping.bodyMapping).toMatchObject({ boardID: '$board_id', name: '$name', subscribeAdmins: '$subscribe_admins' });
    expect(tool('canny_list_tags').endpointMapping.path).toBe('/api/v1/tags/list');
    expect(tool('canny_create_tag').endpointMapping.path).toBe('/api/v1/tags/create');
    expect(tool('canny_list_status_changes').endpointMapping.path).toBe('/api/v2/status_changes/list');
    expect(tool('canny_list_changelog_entries').endpointMapping).toMatchObject({ path: '/api/v1/entries/list', bodyMapping: { labelIDs: '$label_ids', sort: '$sort' } });
    expect(tool('canny_create_changelog_entry').endpointMapping.bodyMapping).toMatchObject({ title: '$title', details: '$details', scheduledFor: '$scheduled_for', postIDs: '$post_ids' });
    expect(tool('canny_update_changelog_entry').endpointMapping.bodyMapping).toMatchObject({ entryID: '$entry_id', types: '$types' });
    expect(tool('canny_change_changelog_entry_status').parameters?.properties?.status.enum).toEqual(['published', 'scheduled', 'draft']);
  });

  it('turns an {"error": ...} body into a failed call', () => {
    const rules = a.connector.config.errorWhen;
    expect(() => assertNoResponseBodyError({ error: 'invalid post id' }, rules)).toThrow('invalid post id');
    expect(() => assertNoResponseBodyError({ boards: [] }, rules)).not.toThrow();
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
    }
  });

  it('documents every tool in the instructions and has no em dash', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_CANNY_LIVE === '1' && process.env.CANNY_API_KEY ? describe : describe.skip;
live('canny adapter: live (read-only)', () => {
  // Canny reads are POSTs too; these only list data.
  const read = async (path: string, extra: Record<string, unknown> = {}) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: process.env.CANNY_API_KEY, ...extra }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads boards, posts, tags and users', async () => {
    const { boards } = (await read('/api/v1/boards/list')) as { boards: Array<{ id: string }> };
    expect(Array.isArray(boards)).toBe(true);
    const posts = await read('/api/v1/posts/list', { limit: 2, ...(boards[0] ? { boardID: boards[0].id } : {}) });
    expect(Array.isArray(posts.posts)).toBe(true);
    expect(Array.isArray((await read('/api/v1/tags/list', { limit: 2 })).tags)).toBe(true);
    expect(await read('/api/v2/users/list', { limit: 2 })).toBeDefined();
  }, 60_000);
});
