import * as adapter from './reamaze.json';

/**
 * Re:amaze JSON API v1 (reamaze.com/api): per-brand host https://{brand}.reamaze.io/api/v1,
 * HTTP Basic with the staff user's login email and API token, Accept: application/json.
 * Live part: REAMAZE_BRAND=... REAMAZE_LOGIN_EMAIL=... REAMAZE_API_TOKEN=... RUN_REAMAZE_LIVE=1 npx jest src/adapters/intl/reamaze
 * (reads only: channels, conversations, staff).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean }>;
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
const PREFIX = 'reamaze_';
const WRITES = [
  'reamaze_create_conversation',
  'reamaze_update_conversation',
  'reamaze_create_message',
  'reamaze_create_contact',
  'reamaze_update_contact',
  'reamaze_add_contact_note',
  'reamaze_create_article',
  'reamaze_update_article',
];

describe('reamaze adapter: static spec conformance', () => {
  it('calls the brand host with Basic auth (login email + API token) and asks for JSON', () => {
    expect(a.requiredEnvVars).toEqual(['REAMAZE_BRAND', 'REAMAZE_LOGIN_EMAIL', 'REAMAZE_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://{{REAMAZE_BRAND}}.reamaze.io/api/v1');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{REAMAZE_LOGIN_EMAIL}}', password: '{{REAMAZE_API_TOKEN}}' });
    expect(a.connector.headers?.Accept).toBe('application/json');
    expect(a.envVarMeta?.REAMAZE_API_TOKEN.secret).toBe(true);
    const brand = new RegExp(a.envVarMeta?.REAMAZE_BRAND.pattern ?? '');
    expect(brand.test('mybrand')).toBe(true);
    expect(brand.test('mybrand.reamaze.io')).toBe(false);
    expect(a.probe?.tool).toBe('reamaze_list_channels');
  });

  it('maps conversations and messages to the documented routes and bodies', () => {
    expect(tool('reamaze_list_conversations').endpointMapping).toMatchObject({ method: 'GET', path: '/conversations', queryParams: { filter: '$filter', sort: '$sort', category: '$category', page: '$page' } });
    expect(tool('reamaze_get_conversation').endpointMapping).toMatchObject({ method: 'GET', path: '/conversations/{slug}', queryParams: { id_type: '$id_type' } });
    expect(tool('reamaze_list_conversation_messages').endpointMapping.path).toBe('/conversations/{slug}/messages');
    expect(tool('reamaze_list_messages').endpointMapping).toMatchObject({ method: 'GET', path: '/messages', queryParams: { sent_by: '$sent_by', start_date: '$start_date' } });
    expect(tool('reamaze_create_conversation').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/conversations',
      bodyMapping: { conversation: { subject: '$subject', category: '$category', message: { body: '$body' }, user: { name: '$user_name', email: '$user_email' } } },
    });
    expect(tool('reamaze_update_conversation').endpointMapping).toMatchObject({ method: 'PUT', path: '/conversations/{slug}', bodyMapping: { conversation: { status: '$status', tag_list: '$tag_list', assignee: '$assignee' } } });
    expect(tool('reamaze_create_message').endpointMapping).toMatchObject({ method: 'POST', path: '/conversations/{slug}/messages', bodyMapping: { message: { body: '$body', visibility: '$visibility' } } });
  });

  it('maps contacts, articles, channels, staff, templates, ratings and reports', () => {
    expect(tool('reamaze_list_contacts').endpointMapping).toMatchObject({ method: 'GET', path: '/contacts', queryParams: { q: '$q' } });
    expect(tool('reamaze_create_contact').endpointMapping).toMatchObject({ method: 'POST', path: '/contacts', bodyMapping: { contact: { email: '$email', mobile: '$mobile' } } });
    expect(tool('reamaze_update_contact').endpointMapping).toMatchObject({ method: 'PUT', path: '/contacts/{identifier}', queryParams: { identifier_type: '$identifier_type' } });
    expect(tool('reamaze_get_contact_identities').endpointMapping.path).toBe('/contacts/{email}/identities');
    expect(tool('reamaze_list_contact_notes').endpointMapping).toEqual({ method: 'GET', path: '/contacts/{identifier}/notes' });
    expect(tool('reamaze_add_contact_note').endpointMapping).toMatchObject({ method: 'POST', path: '/contacts/{identifier}/notes', bodyMapping: { body: '$body' } });
    expect(tool('reamaze_list_articles').endpointMapping).toMatchObject({ path: '/articles', queryParams: { status: '$status', q: '$q' } });
    expect(tool('reamaze_get_article').endpointMapping.path).toBe('/articles/{slug}');
    expect(tool('reamaze_create_article').endpointMapping).toMatchObject({ method: 'POST', path: '/topics/{topic_slug}/articles', bodyMapping: { article: { title: '$title' } } });
    expect(tool('reamaze_update_article').endpointMapping).toMatchObject({ method: 'PUT', path: '/articles/{slug}' });
    expect(tool('reamaze_list_channels').endpointMapping.path).toBe('/channels');
    expect(tool('reamaze_get_channel').endpointMapping.path).toBe('/channels/{slug}');
    expect(tool('reamaze_list_staff').endpointMapping.path).toBe('/staff');
    expect(tool('reamaze_list_response_templates').endpointMapping.path).toBe('/response_templates');
    expect(tool('reamaze_get_response_template').endpointMapping.path).toBe('/response_templates/{id}');
    expect(tool('reamaze_list_satisfaction_ratings').endpointMapping).toMatchObject({ path: '/satisfaction_ratings', queryParams: { rating: '$rating' } });
    expect(tool('reamaze_get_report').endpointMapping.path).toBe('/reports/{report}');
    const report = tool('reamaze_get_report').parameters?.properties?.report as { enum: string[] };
    expect(report.enum).toEqual(['volume', 'response_time', 'staff', 'tags', 'channel_summary']);
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

  it('writes are annotated and enabled (no deletes); reads are GET', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      expect(t.endpointMapping.method).not.toBe('DELETE');
      if (WRITES.includes(t.name)) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:false`);
      else expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
    }
  });

  it('documents every tool in the instructions and has no em dash', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const env = process.env;
const live = env.RUN_REAMAZE_LIVE === '1' && env.REAMAZE_BRAND && env.REAMAZE_LOGIN_EMAIL && env.REAMAZE_API_TOKEN ? describe : describe.skip;
live('reamaze adapter: live (read-only)', () => {
  const base = `https://${env.REAMAZE_BRAND}.reamaze.io/api/v1`;
  const headers = {
    Accept: 'application/json',
    Authorization: `Basic ${Buffer.from(`${env.REAMAZE_LOGIN_EMAIL}:${env.REAMAZE_API_TOKEN}`).toString('base64')}`,
  };
  it('reads channels, conversations and staff', async () => {
    const channels = (await (await fetch(`${base}/channels`, { headers })).json()) as { channels: unknown[] };
    expect(Array.isArray(channels.channels)).toBe(true);
    const conversations = (await (await fetch(`${base}/conversations?filter=all`, { headers })).json()) as { conversations: unknown[]; page_size: number };
    expect(Array.isArray(conversations.conversations)).toBe(true);
    const staff = (await (await fetch(`${base}/staff`, { headers })).json()) as { staff: unknown[] };
    expect(Array.isArray(staff.staff)).toBe(true);
  }, 60_000);
});
