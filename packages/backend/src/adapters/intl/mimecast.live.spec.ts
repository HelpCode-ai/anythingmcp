import * as adapter from './mimecast.json';

/**
 * Mimecast API 2.0 adapter.
 *
 * Static checks always run: the three API 2.0 gateways offered as choices, the
 * client-credentials token request on the same gateway, every tool's method and
 * path against the OpenAPI documents of the developer portal (Data Retention,
 * Email Security Cloud Gateway, Security Events, Audit Events, Policy
 * Management, Account Management, Threats), the "data" envelope of the API 1.0
 * style calls, the rules that turn a 200 answer with a "fail" list into an
 * error, and which tools install switched off (release, reject, permit or block).
 * https://developer.services.mimecast.com/api-overview
 *
 * Live checks run only with RUN_MIMECAST_LIVE=1. Without credentials they confirm
 * that the token endpoint refuses wrong ones; with MIMECAST_CLIENT_ID and
 * MIMECAST_CLIENT_SECRET they read the account summary. Nothing is written.
 *
 *   RUN_MIMECAST_LIVE=1 MIMECAST_CLIENT_ID=... MIMECAST_CLIENT_SECRET=... \
 *     npx jest src/adapters/intl/mimecast.live.spec.ts
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { description?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  description: string;
  instructions: string;
  prerequisites?: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string; help?: string; options?: Array<{ value: string; label: string }> }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string>; config?: Record<string, unknown> };
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
// Text outside `code` spans: the website renders descriptions as MDX.
const prose = (text: string) => text.replace(/`[^`]*`/g, '');

const PREFIX = 'mimecast_';
// Method and path of every tool, as the vendor documents them.
const ROUTES: Record<string, [string, string]> = {
  mimecast_get_account: ['POST', '/api/account/get-account'],
  mimecast_search_archive: ['POST', '/api/archive/search'],
  mimecast_list_archive_messages: ['POST', '/api/archive/get-message-list'],
  mimecast_get_archive_message: ['POST', '/api/archive/get-message-detail'],
  mimecast_get_archive_message_part: ['POST', '/api/archive/get-message-part'],
  mimecast_get_archive_file: ['POST', '/api/archive/get-file'],
  mimecast_list_smart_tags: ['GET', '/dataretention/v1/smart-tags'],
  mimecast_search_smart_tag_messages: ['POST', '/dataretention/v1/smart-tags/{smart_tag_id}/messages/search'],
  mimecast_add_messages_to_smart_tag: ['POST', '/dataretention/v1/smart-tags/{smart_tag_id}/messages'],
  mimecast_search_messages: ['POST', '/api/message-finder/search'],
  mimecast_get_message_info: ['POST', '/api/message-finder/get-message-info'],
  mimecast_list_held_messages: ['POST', '/api/gateway/get-hold-message-list'],
  mimecast_get_held_summary: ['POST', '/api/gateway/get-hold-summary-list'],
  mimecast_release_held_message: ['POST', '/api/gateway/hold-release'],
  mimecast_reject_held_messages: ['POST', '/api/gateway/hold-reject'],
  mimecast_get_email_queues: ['POST', '/api/email/get-email-queues'],
  mimecast_get_ttp_url_logs: ['POST', '/api/ttp/url/get-logs'],
  mimecast_get_ttp_attachment_logs: ['POST', '/api/ttp/attachment/get-logs'],
  mimecast_get_ttp_impersonation_logs: ['POST', '/api/ttp/impersonation/get-logs'],
  mimecast_get_dlp_logs: ['POST', '/api/dlp/get-logs'],
  mimecast_decode_url: ['POST', '/api/ttp/url/decode-url'],
  mimecast_get_audit_events: ['POST', '/api/audit/get-audit-events'],
  mimecast_list_audit_categories: ['POST', '/api/audit/get-categories'],
  mimecast_get_rejection_logs: ['POST', '/api/gateway/get-rejections'],
  mimecast_get_held_release_logs: ['POST', '/api/gateway/get-held-release-logs'],
  mimecast_list_blocked_sender_policies: ['GET', '/policy-management/cloud-gateway/v1/blocked-senders/policies'],
  mimecast_permit_or_block_sender: ['POST', '/api/managedsender/permit-or-block-sender'],
  mimecast_list_threat_events: ['GET', '/threats/v1/events'],
};
const REQUIRED: Record<string, string[]> = {
  mimecast_search_archive: ['query'],
  mimecast_get_archive_message: ['id'],
  mimecast_get_archive_message_part: ['id'],
  mimecast_get_archive_file: ['id'],
  mimecast_search_smart_tag_messages: ['smart_tag_id'],
  mimecast_add_messages_to_smart_tag: ['smart_tag_id', 'message_ids'],
  mimecast_get_message_info: ['id'],
  mimecast_release_held_message: ['id'],
  mimecast_reject_held_messages: ['ids'],
  mimecast_get_email_queues: ['start', 'end'],
  mimecast_decode_url: ['url'],
  mimecast_get_audit_events: ['start_date_time', 'end_date_time'],
  mimecast_permit_or_block_sender: ['sender', 'to', 'action'],
  mimecast_list_threat_events: ['timestamp_range_starts_at'],
};
// Installed switched off: an administrator turns them on per connector.
const SWITCHED_OFF: string[] = ['mimecast_release_held_message', 'mimecast_reject_held_messages', 'mimecast_permit_or_block_sender'];
// Writes that are on at install.
const WRITES: string[] = ['mimecast_add_messages_to_smart_tag'];
// POST requests that only read (searches and log queries).
const READ_POSTS: string[] = ['mimecast_get_account', 'mimecast_search_archive', 'mimecast_list_archive_messages', 'mimecast_get_archive_message', 'mimecast_get_archive_message_part', 'mimecast_get_archive_file', 'mimecast_search_smart_tag_messages', 'mimecast_search_messages', 'mimecast_get_message_info', 'mimecast_list_held_messages', 'mimecast_get_held_summary', 'mimecast_get_email_queues', 'mimecast_get_ttp_url_logs', 'mimecast_get_ttp_attachment_logs', 'mimecast_get_ttp_impersonation_logs', 'mimecast_get_dlp_logs', 'mimecast_decode_url', 'mimecast_get_audit_events', 'mimecast_list_audit_categories', 'mimecast_get_rejection_logs', 'mimecast_get_held_release_logs'];

describe('mimecast adapter: static contract', () => {
  it('declares the catalog envelope, the base URL and the authentication', () => {
    expect(a.slug).toBe('mimecast');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('email');
    expect(a.icon).toBe('mimecast');
    expect(a.requiredEnvVars).toEqual(['MIMECAST_API_URL', 'MIMECAST_CLIENT_ID', 'MIMECAST_CLIENT_SECRET']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{MIMECAST_API_URL}}');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({ grant: 'client_credentials', clientId: '{{MIMECAST_CLIENT_ID}}', clientSecret: '{{MIMECAST_CLIENT_SECRET}}', tokenUrl: '{{MIMECAST_API_URL}}/oauth/token', tokenAuthMethod: 'client_secret_post' });
    for (const name of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) {
      expect(`${name}:${Boolean(a.envVarMeta[name]?.help)}`).toBe(`${name}:true`);
      expect(`${name}:${a.envVarMeta[name]?.secret === true}`).toBe(`${name}:${(['MIMECAST_CLIENT_SECRET'] as string[]).includes(name)}`);
    }
    // An optional variable in a connector header would be sent as the literal placeholder.
    for (const name of a.optionalEnvVars ?? []) expect(JSON.stringify(a.connector.headers ?? {})).not.toContain(name);
  });

  it('checks the credentials with a cheap read and explains the usual refusals', () => {
    expect(a.probe).toEqual({ tool: 'mimecast_get_account' });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('POST');
    for (const key of ['401', '403', '404', 'rate_limited', 'auth_failed']) expect(`${key}:${Boolean(a.verifyHints[key])}`).toBe(`${key}:true`);
  });

  it('maps every tool to its documented method and path', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const t of a.tools) {
      expect(`${t.name} ${t.endpointMapping.method} ${t.endpointMapping.path}`).toBe(`${t.name} ${ROUTES[t.name][0]} ${ROUTES[t.name][1]}`);
      expect(`${t.name}:${JSON.stringify(t.parameters?.required ?? [])}`).toBe(`${t.name}:${JSON.stringify(REQUIRED[t.name] ?? [])}`);
    }
  });

  it('prefixes every tool, sends every declared parameter, declares every argument it reads and requires its path parameters', () => {
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) {
        expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
        expect(`${t.name}:${p}:${Boolean(t.parameters?.properties?.[p]?.description)}`).toBe(`${t.name}:${p}:true`);
      }
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p) || envNames.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required ?? []).toContain(p);
    }
  });

  it('installs deletes and other risky calls switched off and marks reading POSTs read-only', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...SWITCHED_OFF].sort());
    for (const t of a.tools) {
      const method = t.endpointMapping.method;
      if (method === 'DELETE') expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:false`);
      if (READ_POSTS.includes(t.name)) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
      else expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:undefined`);
      const reads = method === 'GET' || READ_POSTS.includes(t.name);
      expect(`${t.name}:${reads || WRITES.includes(t.name) || SWITCHED_OFF.includes(t.name)}`).toBe(`${t.name}:true`);
      if (reads) expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
    }
  });

  it('names every tool in the instructions and keeps the texts MDX-safe', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    const texts = [a.description, a.instructions, a.prerequisites ?? '', ...Object.values(a.verifyHints)];
    for (const t of a.tools) {
      texts.push(t.description);
      for (const p of Object.values(t.parameters?.properties ?? {})) texts.push(p.description ?? '');
    }
    for (const text of texts) expect(prose(text)).not.toMatch(/[{}<]/);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });


  it('offers the three gateways and requests the token on the same one', () => {
    const meta = a.envVarMeta.MIMECAST_API_URL;
    expect(meta.options?.map((o) => o.value)).toEqual(['https://api.services.mimecast.com', 'https://uk-api.services.mimecast.com', 'https://us-api.services.mimecast.com']);
    const url = new RegExp(meta.pattern ?? '');
    for (const o of meta.options ?? []) expect(`${o.value}:${url.test(o.value)}`).toBe(`${o.value}:true`);
    for (const bad of ['https://api.services.mimecast.com/', 'https://eu-api.mimecast.com', 'http://api.services.mimecast.com', 'https://api.services.mimecast.com.example.org']) {
      expect(`${bad}:${url.test(bad)}`).toBe(`${bad}:false`);
    }
    expect(a.connector.authConfig.tokenUrl).toBe('{{MIMECAST_API_URL}}/oauth/token');
  });

  it('wraps the API 1.0 style calls in a one-item data list and pages them through meta.pagination', () => {
    for (const t of a.tools) {
      if (!t.endpointMapping.path.startsWith('/api/')) continue;
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:POST`);
      const body = t.endpointMapping.bodyMapping as { data?: unknown[]; meta?: unknown };
      expect(`${t.name}:${Array.isArray(body.data)}`).toBe(`${t.name}:true`);
      expect((body.data ?? []).length).toBeLessThanOrEqual(1);
      const props = t.parameters?.properties ?? {};
      if ('page_token' in props) expect(body.meta).toEqual({ pagination: { pageSize: '$page_size', pageToken: '$page_token' } });
      else expect(body.meta).toBeUndefined();
    }
    expect(tool('mimecast_search_archive').endpointMapping.bodyMapping).toEqual({ data: [{ query: '$query', admin: '$admin' }] });
    expect(tool('mimecast_get_archive_message_part').endpointMapping.bodyMapping).toEqual({ data: [{ id: '$id', type: '$type', context: '$context', mailbox: '$mailbox' }] });
    expect(tool('mimecast_search_messages').endpointMapping.bodyMapping).toMatchObject({
      data: [{ advancedTrackAndTraceOptions: '$advanced', messageId: '$message_id' }],
    });
    expect(tool('mimecast_get_audit_events').endpointMapping.bodyMapping).toMatchObject({ data: [{ startDateTime: '$start_date_time', endDateTime: '$end_date_time' }] });
    // Nested filter objects are handed through whole, so an unused one is left out instead of going out empty.
    for (const name of ['mimecast_list_held_messages', 'mimecast_get_rejection_logs', 'mimecast_get_held_release_logs']) {
      expect(tool(name).endpointMapping.bodyMapping).toMatchObject({ data: [{ searchBy: '$search_by' }] });
    }
    expect(JSON.stringify(a.tools.map((t) => t.endpointMapping.bodyMapping ?? null))).not.toContain('{}');
  });

  it('maps the Smart Tag, policy and threat calls of the newer API style', () => {
    expect(tool('mimecast_list_smart_tags').endpointMapping.queryParams).toEqual({ pageSize: '$page_size', pageToken: '$page_token' });
    expect(tool('mimecast_search_smart_tag_messages').endpointMapping).toMatchObject({
      queryParams: { pageSize: '$page_size', pageToken: '$page_token' },
      bodyMapping: { startDateTime: '$start_date_time', endDateTime: '$end_date_time' },
    });
    expect(tool('mimecast_add_messages_to_smart_tag').endpointMapping.bodyMapping).toEqual({ messageIds: '$message_ids' });
    expect(tool('mimecast_list_threat_events').endpointMapping.queryParams).toMatchObject({ timestampRangeStartsAt: '$timestamp_range_starts_at', pageToken: '$page_token' });
  });

  it('reports a 200 answer with a fail list as an error, permission problems as 403', () => {
    const rules = a.connector.config?.errorWhen as Array<{ path: string; status: number; messageMatches?: string }>;
    expect(rules.map((r) => r.status)).toEqual([403, 404, 400]);
    for (const r of rules) expect(r.path).toBe('fail[0].errors[0].code');
    expect(new RegExp(rules[0].messageMatches ?? '', 'i').test('err_developer_key_permission_denied You do not have permission')).toBe(true);
    expect(rules[2].messageMatches).toBeUndefined();
  });

  it('keeps release, reject and permit-or-block switched off and sends no email', () => {
    expect(tool('mimecast_release_held_message').endpointMapping.bodyMapping).toEqual({ data: [{ id: '$id' }] });
    expect(tool('mimecast_reject_held_messages').endpointMapping.bodyMapping).toEqual({ data: [{ ids: '$ids', reasonType: '$reason_type', message: '$message', notify: '$notify' }] });
    expect(tool('mimecast_permit_or_block_sender').endpointMapping.bodyMapping).toEqual({ data: [{ sender: '$sender', to: '$to', action: '$action' }] });
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/send-email|file-upload|create-policy|remediation|retention-adjustment|visibility|bulk-delete/);
  });
});

const env = process.env;
(env.RUN_MIMECAST_LIVE === '1' ? describe : describe.skip)('mimecast adapter: live (read-only)', () => {
  const base = env.MIMECAST_API_URL ?? 'https://api.services.mimecast.com';
  const form = (id: string, secret: string) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString(),
  });

  it('refuses wrong client credentials at the token endpoint', async () => {
    const res = await fetch(`${base}/oauth/token`, form('not-a-client', 'not-a-secret'));
    expect(res.status).toBe(401);
  }, 30_000);

  it('reads the account summary', async () => {
    if (!env.MIMECAST_CLIENT_ID || !env.MIMECAST_CLIENT_SECRET) throw new Error('Set MIMECAST_CLIENT_ID and MIMECAST_CLIENT_SECRET for the live check');
    const token = await fetch(`${base}/oauth/token`, form(env.MIMECAST_CLIENT_ID, env.MIMECAST_CLIENT_SECRET));
    expect(token.status).toBe(200);
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${((await token.json()) as { access_token: string }).access_token}`,
    };
    const account = await fetch(`${base}/api/account/get-account`, { method: 'POST', headers, body: JSON.stringify({ data: [] }) });
    expect(account.status).toBe(200);
    const body = (await account.json()) as { data?: Array<{ accountCode?: string }>; fail?: unknown[] };
    expect(body.fail ?? []).toEqual([]);
    expect(body.data?.[0]?.accountCode).toBeTruthy();
  }, 60_000);
});
