import * as adapter from './chatwoot.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Chatwoot Application API (developers.chatwoot.com, swagger in the chatwoot repository):
 * api_access_token header, /api/v1/accounts/{id}/... and the /api/v2 reports.
 * Built from a customer's hand-built Cloud connector (self-hosted Chatwoot) and checked
 * read-only with its token on 22 Oct 2026.
 * Live part: CHATWOOT_URL=... CHATWOOT_API_TOKEN=... CHATWOOT_ACCOUNT_ID=... RUN_CHATWOOT_LIVE=1 npx jest src/adapters/intl/chatwoot
 * (reads only: profile, inboxes, open conversations, contacts).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  unlisted?: boolean;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
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
const PREFIX = 'chatwoot_';
const WRITES: string[] = ["chatwoot_create_conversation", "chatwoot_send_message"];
// Tool names of the customers' own connectors for this API on the Cloud (read 22 Oct 2026).
const HAND_BUILT: string[] = ["add_new_agent_to_account", "contactsearch", "conversation_add_labels", "conversationfilter", "conversationlist", "create_a_new_message_in_a_conversation", "delete_agent_from_account", "fetchprofile", "get_account_agents", "get_details_of_a_conversation", "get_inbox_members", "get_sso_url_of_a_user", "getconversationmessages", "list_all_account_users", "list_all_labels", "list_all_messages", "listallinboxes", "newconversation"];

describe('chatwoot adapter: static spec conformance', () => {

  it('sends the access token in api_access_token to the configured Chatwoot address and account', () => {
    expect(a.requiredEnvVars).toEqual(['CHATWOOT_URL', 'CHATWOOT_API_TOKEN', 'CHATWOOT_ACCOUNT_ID']);
    expect(a.connector.baseUrl).toBe('{{CHATWOOT_URL}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'api_access_token', apiKey: '{{CHATWOOT_API_TOKEN}}' });
    expect(a.envVarMeta?.CHATWOOT_API_TOKEN.secret).toBe(true);
    expect(a.category).toBe('support');
    for (const t of a.tools) {
      if (t.name === 'chatwoot_get_profile') continue;
      expect(t.endpointMapping.path).toMatch(/^\/api\/v[12]\/accounts\/\{\{CHATWOOT_ACCOUNT_ID\}\}/);
    }
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/^\/platform\//);
  });

  it('maps the documented Application API routes', () => {
    const ACC = '/api/v1/accounts/{{CHATWOOT_ACCOUNT_ID}}';
    expect(tool('chatwoot_list_conversations').endpointMapping).toMatchObject({ method: 'GET', path: `${ACC}/conversations`, queryParams: { status: '$status', assignee_type: '$assignee_type', labels: '$labels', page: '$page' } });
    expect(tool('chatwoot_filter_conversations').endpointMapping).toMatchObject({ method: 'POST', path: `${ACC}/conversations/filter`, bodyMapping: { payload: '$conditions' } });
    expect(tool('chatwoot_list_messages').endpointMapping).toMatchObject({ path: `${ACC}/conversations/{conversation_id}/messages`, queryParams: { before: '$before', after: '$after' } });
    expect(tool('chatwoot_search_contacts').endpointMapping).toMatchObject({ path: `${ACC}/contacts/search`, queryParams: { q: '$q' } });
    expect(tool('chatwoot_get_summary_by').endpointMapping.path).toBe('/api/v2/accounts/{{CHATWOOT_ACCOUNT_ID}}/summary_reports/{group}');
    expect(tool('chatwoot_send_message').endpointMapping).toMatchObject({ method: 'POST', bodyMapping: { content: '$content', message_type: 'outgoing', private: '$private' } });
    expect(tool('chatwoot_set_conversation_labels').endpointMapping).toMatchObject({ method: 'POST', path: `${ACC}/conversations/{conversation_id}/labels`, bodyMapping: { labels: '$labels' } });
    expect(tool('chatwoot_set_conversation_labels').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tool('chatwoot_set_conversation_labels').description).toMatch(/REPLACES/);
  });

  it('never hands channel secrets or the user token to the model', () => {
    const inbox = applyResponseTransform(
      { payload: [{ id: 1, name: 'WhatsApp', channel_type: 'Channel::Whatsapp', provider_config: { api_key: 'k' }, hmac_token: 'h', website_token: 'w', imap_password: 'p' }] },
      tool('chatwoot_list_inboxes').responseMapping as never,
    ).value as { inboxes: Record<string, unknown>[] };
    expect(inbox.inboxes[0]).toMatchObject({ id: 1, name: 'WhatsApp' });
    expect(JSON.stringify(inbox)).not.toMatch(/provider_config|hmac_token|website_token|imap_password/);
    const profile = applyResponseTransform({ id: 1, name: 'A', access_token: 't', pubsub_token: 'p', accounts: [{ id: 3 }] }, tool('chatwoot_get_profile').responseMapping as never).value;
    expect(profile).toEqual({ id: 1, name: 'A', accounts: [{ id: 3 }] });
    const contact = applyResponseTransform(
      { payload: { id: 9, name: 'C', contact_inboxes: [{ source_id: 's', inbox: { id: 1, name: 'W', channel_type: 'x', provider_config: { api_key: 'k' } } }] } },
      tool('chatwoot_get_contact').responseMapping as never,
    ).value;
    expect(JSON.stringify(contact)).not.toMatch(/provider_config/);
    expect(contact).toMatchObject({ contact: { id: 9, contact_inboxes: [{ source_id: 's', inbox_id: 1 }] } });
  });

  it('slims conversation lists to the fields an agent needs', () => {
    const out = applyResponseTransform(
      { data: { meta: { all_count: 1 }, payload: [{ id: 7, status: 'open', messages: [{ content: 'x' }], meta: { sender: { id: 2, name: 'Ana' }, assignee: { id: 4, name: 'Bo' } }, last_non_activity_message: { content: 'hi', message_type: 0 } }] } },
      tool('chatwoot_list_conversations').responseMapping as never,
    ).value as { counts: unknown; conversations: Record<string, unknown>[] };
    expect(out.counts).toEqual({ all_count: 1 });
    expect(out.conversations[0]).toMatchObject({ id: 7, status: 'open', contact: { id: 2, name: 'Ana' }, assignee: { id: 4, name: 'Bo' }, last_message: { content: 'hi' } });
    expect(out.conversations[0].messages).toBeUndefined();
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

  it('writes are annotated, the risky ones installed switched off; reads are GET or marked read-only', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...WRITES].sort());
    for (const t of a.tools) {
      if (t.annotations?.readOnlyHint === false) continue;
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      if (t.endpointMapping.method !== 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
    }
    for (const n of WRITES) expect(tool(n).annotations?.readOnlyHint).toBe(false);
  });

  it('never reuses the tool names of hand-built Cloud connectors for the same API', () => {
    const names = new Set(a.tools.map((t) => t.name));
    for (const n of HAND_BUILT) expect(`${n}:${names.has(n)}`).toBe(`${n}:false`);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.annotations?.readOnlyHint === false).toBe(false);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const live = process.env.RUN_CHATWOOT_LIVE === '1' && process.env.CHATWOOT_URL && process.env.CHATWOOT_API_TOKEN && process.env.CHATWOOT_ACCOUNT_ID ? describe : describe.skip;
live('chatwoot adapter: live (read-only)', () => {
  const base = (process.env.CHATWOOT_URL ?? '').replace(/\/$/, '');
  const acc = `${base}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}`;
  const headers = { api_access_token: process.env.CHATWOOT_API_TOKEN as string, Accept: 'application/json' };
  it('reads the profile, inboxes, open conversations and contacts', async () => {
    const me = (await (await fetch(`${base}/api/v1/profile`, { headers })).json()) as { accounts: Array<{ id: number }> };
    expect(me.accounts.map((x) => String(x.id))).toContain(process.env.CHATWOOT_ACCOUNT_ID);
    const inboxes = (await (await fetch(`${acc}/inboxes`, { headers })).json()) as { payload: unknown[] };
    expect(Array.isArray(inboxes.payload)).toBe(true);
    const conv = (await (await fetch(`${acc}/conversations?status=open`, { headers })).json()) as { data: { meta: { all_count: number }; payload: unknown[] } };
    expect(typeof conv.data.meta.all_count).toBe('number');
    const contacts = (await (await fetch(`${acc}/contacts?page=1`, { headers })).json()) as { meta: { count: number } };
    expect(typeof contacts.meta.count).toBe('number');
  }, 60_000);
});
