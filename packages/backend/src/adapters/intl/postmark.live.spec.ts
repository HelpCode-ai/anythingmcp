import * as adapter from './postmark.json';

/**
 * Postmark API (postmarkapp.com/developer): base https://api.postmarkapp.com, server token in
 * X-Postmark-Server-Token; account endpoints (servers, domains, sender signatures) also need
 * X-Postmark-Account-Token, sent per tool from the optional POSTMARK_ACCOUNT_TOKEN.
 * Live part (reads only: server, templates, outbound search, stats, streams):
 *   POSTMARK_SERVER_TOKEN=... RUN_POSTMARK_LIVE=1 npx jest src/adapters/intl/postmark
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string; advanced?: boolean }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const ENV = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings (connector variables excluded).
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
  for (const e of ENV) out.delete(e);
  return out;
};
const PREFIX = 'postmark_';

describe('postmark adapter: static spec conformance', () => {

  it('authenticates with the server token header and sends the account token only on account tools', () => {
    expect(a.requiredEnvVars).toEqual(['POSTMARK_SERVER_TOKEN']);
    expect(a.optionalEnvVars).toEqual(['POSTMARK_ACCOUNT_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://api.postmarkapp.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Postmark-Server-Token', apiKey: '{{POSTMARK_SERVER_TOKEN}}' });
    expect(a.envVarMeta?.POSTMARK_SERVER_TOKEN.secret).toBe(true);
    expect(new RegExp(a.envVarMeta?.POSTMARK_SERVER_TOKEN.pattern as string).test('a1b2c3d4-0000-4000-8000-1234567890ab')).toBe(true);
    const account = ['postmark_list_servers', 'postmark_get_server_by_id', 'postmark_list_domains', 'postmark_get_domain', 'postmark_verify_domain_dkim', 'postmark_verify_domain_return_path', 'postmark_list_sender_signatures', 'postmark_get_sender_signature'];
    for (const t of a.tools) {
      const h = t.endpointMapping.headers?.['X-Postmark-Account-Token'];
      expect(`${t.name}:${h ?? ''}`).toBe(`${t.name}:${account.includes(t.name) ? '${POSTMARK_ACCOUNT_TOKEN}' : ''}`);
    }
  });

  it('maps sending, with batch bodies as the documented top-level array and Messages wrapper', () => {
    expect(tool('postmark_send_email').endpointMapping).toMatchObject({ method: 'POST', path: '/email', bodyMapping: { From: '$From', To: '$To', Subject: '$Subject', HtmlBody: '$HtmlBody', TextBody: '$TextBody', MessageStream: '$MessageStream' } });
    expect(tool('postmark_send_batch').endpointMapping).toEqual({ method: 'POST', path: '/email/batch', bodyMapping: { __raw: '$messages' } });
    expect(tool('postmark_send_email_with_template').endpointMapping).toMatchObject({ path: '/email/withTemplate', bodyMapping: { TemplateId: '$TemplateId', TemplateAlias: '$TemplateAlias', TemplateModel: '$TemplateModel' } });
    expect(tool('postmark_send_batch_with_templates').endpointMapping).toEqual({ method: 'POST', path: '/email/batchWithTemplates', bodyMapping: { Messages: '$messages' } });
  });

  it('maps templates, messages, bounces, stats, suppressions, streams and webhooks', () => {
    expect(tool('postmark_list_templates').endpointMapping.queryParams).toEqual({ Count: '$count', Offset: '$offset', TemplateType: '$template_type', LayoutTemplate: '$layout_template' });
    expect(tool('postmark_update_template').endpointMapping).toMatchObject({ method: 'PUT', path: '/templates/{template}' });
    expect(tool('postmark_search_outbound_messages').endpointMapping).toMatchObject({ path: '/messages/outbound', queryParams: { count: '$count', offset: '$offset', recipient: '$recipient', messagestream: '$messagestream' } });
    expect(tool('postmark_get_outbound_message').endpointMapping.path).toBe('/messages/outbound/{message_id}/details');
    expect(tool('postmark_list_bounces').endpointMapping.queryParams).toMatchObject({ emailFilter: '$email_filter', messageID: '$message_id', inactive: '$inactive' });
    expect(tool('postmark_activate_bounce').endpointMapping).toEqual({ method: 'PUT', path: '/bounces/{bounce_id}/activate' });
    expect(tool('postmark_get_outbound_stats').endpointMapping.path).toBe('/stats/outbound/{metric}');
    expect(tool('postmark_get_outbound_stats').parameters?.properties?.metric.enum).toContain('clicks/location');
    expect(tool('postmark_list_suppressions').endpointMapping.path).toBe('/message-streams/{stream_id}/suppressions/dump');
    expect(tool('postmark_delete_suppressions').endpointMapping).toEqual({ method: 'POST', path: '/message-streams/{stream_id}/suppressions/delete', bodyMapping: { Suppressions: '$suppressions' } });
    expect(tool('postmark_archive_message_stream').endpointMapping).toEqual({ method: 'POST', path: '/message-streams/{stream_id}/archive' });
    expect(tool('postmark_update_webhook').endpointMapping).toMatchObject({ method: 'PUT', path: '/webhooks/{webhook_id}', bodyMapping: { Url: '$Url', Triggers: '$Triggers' } });
  });

  it('gives the required count and offset a default so list calls are valid without them', () => {
    for (const t of a.tools.filter((x) => x.parameters?.properties?.count)) {
      expect(t.parameters?.properties?.count.default).toBe(50);
      expect(t.parameters?.properties?.offset.default).toBe(0);
    }
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
      for (const r of t.parameters?.required ?? []) expect(`${t.name}:${r}:${props.includes(r)}`).toBe(`${t.name}:${r}:true`);
    }
  });

  it('marks reads over POST or PATCH read-only and deletes destructive', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping.method;
      if (m === 'DELETE') expect(`${t.name}:${t.annotations?.destructiveHint}`).toBe(`${t.name}:true`);
      if (m !== 'GET' && /_(search|find|preview|validate)_|_list_/.test(t.name)) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
      if (m === 'GET') expect(t.annotations?.readOnlyHint === false).toBe(false);
    }
  });

  it('probes with a read tool without required parameters and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const live = process.env.RUN_POSTMARK_LIVE === '1' && process.env.POSTMARK_SERVER_TOKEN ? describe : describe.skip;
live('postmark adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { 'X-Postmark-Server-Token': process.env.POSTMARK_SERVER_TOKEN as string, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads the server, templates, outbound messages, stats and streams', async () => {
    expect(typeof (await get('/server')).ID).toBe('number');
    expect(Array.isArray((await get('/templates?Count=1&Offset=0')).Templates)).toBe(true);
    expect(typeof (await get('/messages/outbound?count=1&offset=0')).TotalCount).toBe('number');
    expect(typeof (await get('/stats/outbound')).Sent).toBe('number');
    expect(Array.isArray((await get('/message-streams')).MessageStreams)).toBe(true);
  }, 60_000);
});
