import * as adapter from './mailtrap.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Mailtrap API (docs.mailtrap.io/developers, OpenAPI specs at github.com/mailtrap/mailtrap-openapi):
 * management on https://mailtrap.io with account-less paths (the token is bound to one account),
 * transactional sending on send.api.mailtrap.io, the Bulk stream on bulk.api.mailtrap.io and
 * Email Sandbox test sends on sandbox.api.mailtrap.io. Bearer token on every host.
 * Live part (reads only: accounts, sandboxes, sending domains, templates, contact lists):
 *   MAILTRAP_API_TOKEN=... RUN_MAILTRAP_LIVE=1 npx jest src/adapters/intl/mailtrap
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    queryParams?: Record<string, unknown>;
    bodyMapping?: unknown;
    headers?: Record<string, unknown>;
  };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string };
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
const PREFIX = 'mailtrap_';
const SEND = 'https://send.api.mailtrap.io';
const BULK = 'https://bulk.api.mailtrap.io';
const SANDBOX = 'https://sandbox.api.mailtrap.io';
const SBM = '/api/sandboxes/{sandbox_id}/messages/{message_id}';

describe('mailtrap adapter: static spec conformance', () => {
  it('authenticates with the API token as a Bearer token on https://mailtrap.io', () => {
    expect(a.requiredEnvVars).toEqual(['MAILTRAP_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://mailtrap.io');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{MAILTRAP_API_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/api/accounts');
    expect(a.envVarMeta?.MAILTRAP_API_TOKEN.secret).toBe(true);
    expect(new RegExp(a.envVarMeta?.MAILTRAP_API_TOKEN.pattern ?? '').test('Bearer abc')).toBe(false);
  });

  it('uses the account-less management paths and only the three documented sending hosts', () => {
    for (const t of a.tools) {
      const p = t.endpointMapping.path;
      if (/^https?:\/\//.test(p)) {
        expect(`${t.name}:${[SEND, BULK, SANDBOX].some((h) => p.startsWith(`${h}/api/`))}`).toBe(`${t.name}:true`);
        expect(t.endpointMapping.method).toBe('POST');
      } else {
        expect(p).toMatch(/^\/api\//);
        expect(p).not.toMatch(/\/accounts\/\{/);
      }
    }
  });

  it('maps the sending endpoints with the documented body fields', () => {
    const body = {
      from: { email: '$from_email', name: '$from_name' },
      to: '$to', cc: '$cc', bcc: '$bcc', reply_to: '$reply_to',
      subject: '$subject', text: '$text', html: '$html', category: '$category',
      template_uuid: '$template_uuid', template_variables: '$template_variables',
      attachments: '$attachments', headers: '$headers', custom_variables: '$custom_variables',
    };
    expect(tool('mailtrap_send_email').endpointMapping).toEqual({ method: 'POST', path: `${SEND}/api/send`, bodyMapping: body });
    expect(tool('mailtrap_send_bulk_email').endpointMapping).toEqual({ method: 'POST', path: `${BULK}/api/send`, bodyMapping: body });
    expect(tool('mailtrap_send_sandbox_email').endpointMapping).toEqual({ method: 'POST', path: `${SANDBOX}/api/send/{sandbox_id}`, bodyMapping: body });
    for (const [n, host] of [['mailtrap_send_batch_emails', SEND], ['mailtrap_send_bulk_batch_emails', BULK]]) {
      expect(tool(n).endpointMapping).toEqual({ method: 'POST', path: `${host}/api/batch`, bodyMapping: { base: '$base', requests: '$requests' } });
      expect(tool(n).parameters?.required).toEqual(['requests']);
    }
    expect(tool('mailtrap_send_email').parameters?.required).toEqual(['from_email', 'to']);
  });

  it('maps domains, suppressions, stats and email logs', () => {
    expect(tool('mailtrap_list_sending_domains').endpointMapping).toEqual({ method: 'GET', path: '/api/domains' });
    expect(tool('mailtrap_get_sending_domain').endpointMapping.path).toBe('/api/domains/{domain_id}');
    expect(tool('mailtrap_create_sending_domain').endpointMapping).toEqual({ method: 'POST', path: '/api/domains', bodyMapping: { domain: { domain_name: '$domain_name' } } });
    expect(tool('mailtrap_send_domain_setup_instructions').endpointMapping.path).toBe('/api/domains/{domain_id}/send_setup_instructions');
    expect(tool('mailtrap_list_suppressions').endpointMapping.queryParams).toEqual({ email: '$email', start_time: '$start_time', end_time: '$end_time', last_id: '$last_id' });
    expect(tool('mailtrap_create_suppression').endpointMapping.bodyMapping).toEqual({ email: '$email', domain_id: '$domain_id', sending_stream: '$sending_stream', type: '$type' });
    expect(tool('mailtrap_delete_suppression').endpointMapping).toEqual({ method: 'DELETE', path: '/api/suppressions/{suppression_id}' });
    const statsQuery = {
      start_date: '$start_date', end_date: '$end_date', 'domain_ids[]': '$domain_ids', 'sending_streams[]': '$sending_streams',
      'categories[]': '$categories', 'email_service_providers[]': '$email_service_providers',
    };
    expect(tool('mailtrap_get_sending_stats').endpointMapping).toEqual({ method: 'GET', path: '/api/stats', queryParams: statsQuery });
    expect(tool('mailtrap_get_sending_stats_grouped').endpointMapping).toEqual({ method: 'GET', path: '/api/stats/{group_by}', queryParams: statsQuery });
    expect(tool('mailtrap_get_sending_stats_grouped').parameters?.properties?.group_by.enum).toEqual(['domains', 'categories', 'email_service_providers', 'date']);
    expect(tool('mailtrap_list_email_logs').endpointMapping.queryParams).toEqual({
      'filters[sent_after]': '$sent_after', 'filters[sent_before]': '$sent_before', filters: '$filters', search_after: '$search_after',
    });
    expect(tool('mailtrap_get_email_log').endpointMapping.path).toBe('/api/email_logs/{message_id}');
  });

  it('maps the Email Sandbox endpoints', () => {
    expect(tool('mailtrap_list_sandboxes').endpointMapping.path).toBe('/api/sandboxes');
    expect(tool('mailtrap_list_sandbox_projects').endpointMapping.path).toBe('/api/projects');
    expect(tool('mailtrap_list_sandbox_messages').endpointMapping).toMatchObject({ path: '/api/sandboxes/{sandbox_id}/messages', queryParams: { search: '$search', last_id: '$last_id', page: '$page' } });
    expect(tool('mailtrap_get_sandbox_message').endpointMapping.path).toBe(SBM);
    expect(tool('mailtrap_get_sandbox_message_body').endpointMapping.path).toBe(`${SBM}/body.{format}`);
    expect(tool('mailtrap_get_sandbox_message_body').parameters?.properties?.format.enum).toEqual(['txt', 'html', 'htmlsource', 'raw']);
    expect(tool('mailtrap_get_sandbox_message_headers').endpointMapping.path).toBe(`${SBM}/mail_headers`);
    expect(tool('mailtrap_get_sandbox_spam_report').endpointMapping.path).toBe(`${SBM}/spam_report`);
    expect(tool('mailtrap_get_sandbox_html_analysis').endpointMapping.path).toBe(`${SBM}/analyze`);
    expect(tool('mailtrap_list_sandbox_attachments').endpointMapping.path).toBe(`${SBM}/attachments`);
    expect(tool('mailtrap_create_sandbox').endpointMapping).toMatchObject({ method: 'POST', path: '/api/projects/{project_id}/sandboxes', bodyMapping: { sandbox: { name: '$name' } } });
    expect(tool('mailtrap_clean_sandbox').endpointMapping).toEqual({ method: 'PATCH', path: '/api/sandboxes/{sandbox_id}/clean' });
  });

  it('maps contacts, templates and campaigns with their wrapper objects', () => {
    expect(tool('mailtrap_list_contacts').endpointMapping.queryParams).toEqual({ list_id: '$list_id', status: '$status', email: '$email', per_page: '$per_page', token: '$token' });
    expect(tool('mailtrap_create_contact').endpointMapping.bodyMapping).toEqual({ contact: { email: '$email', fields: '$fields', list_ids: '$list_ids' } });
    expect(tool('mailtrap_update_contact').endpointMapping).toMatchObject({ method: 'PATCH', path: '/api/contacts/{contact_identifier}', encodePathParams: true });
    for (const n of ['mailtrap_get_contact', 'mailtrap_update_contact', 'mailtrap_delete_contact', 'mailtrap_create_contact_event']) {
      expect(tool(n).endpointMapping.encodePathParams).toBe(true);
    }
    expect(tool('mailtrap_create_contact_event').endpointMapping.path).toBe('/api/contacts/{contact_identifier}/events');
    expect(tool('mailtrap_list_contact_lists').endpointMapping).toEqual({ method: 'GET', path: '/api/contacts/lists', queryParams: { search: '$search' } });
    expect(tool('mailtrap_list_contact_fields').endpointMapping.path).toBe('/api/contacts/fields');
    expect(tool('mailtrap_import_contacts').endpointMapping).toEqual({ method: 'POST', path: '/api/contacts/imports', bodyMapping: { contacts: '$contacts' } });
    expect(tool('mailtrap_get_contact_import').endpointMapping.path).toBe('/api/contacts/imports/{import_id}');
    const tpl = { email_template: { name: '$name', category: '$category', subject: '$subject', body_html: '$body_html', body_text: '$body_text' } };
    expect(tool('mailtrap_create_template').endpointMapping).toEqual({ method: 'POST', path: '/api/email_templates', bodyMapping: tpl });
    expect(tool('mailtrap_update_template').endpointMapping).toEqual({ method: 'PATCH', path: '/api/email_templates/{template_id}', bodyMapping: tpl });
    expect(tool('mailtrap_list_campaigns').endpointMapping).toEqual({ method: 'GET', path: '/api/email_campaigns', queryParams: { search: '$search', per_page: '$per_page', token: '$token' } });
    expect(tool('mailtrap_create_campaign').endpointMapping.bodyMapping).toMatchObject({
      name: '$name', domain_id: '$domain_id', from_local_part: '$from_local_part', contact_list_ids: '$contact_list_ids',
      template_attributes: { subject: '$subject', body_html: '$body_html', body_text: '$body_text' },
    });
    expect(tool('mailtrap_schedule_campaign').endpointMapping).toEqual({ method: 'POST', path: '/api/email_campaigns/{campaign_id}/schedule', bodyMapping: { datetime: '$datetime' } });
    for (const action of ['start', 'cancel']) {
      expect(tool(`mailtrap_${action}_campaign`).endpointMapping).toEqual({ method: 'POST', path: `/api/email_campaigns/{campaign_id}/${action}` });
    }
    expect(tool('mailtrap_get_campaign_stats').endpointMapping.path).toBe('/api/email_campaigns/{campaign_id}/stats');
  });

  it('keeps SMTP credentials and template bodies out of the answers', () => {
    const sb = { id: 1, name: 'Dev', username: 'smtpuser', password: 'smtppass', emails_count: 3 };
    for (const n of ['mailtrap_list_sandboxes']) {
      expect(applyResponseTransform([sb], tool(n).responseMapping as never).value).toEqual([{ id: 1, name: 'Dev', emails_count: 3 }]);
    }
    for (const n of ['mailtrap_get_sandbox', 'mailtrap_create_sandbox', 'mailtrap_clean_sandbox']) {
      expect(applyResponseTransform(sb, tool(n).responseMapping as never).value).toEqual({ id: 1, name: 'Dev', emails_count: 3 });
    }
    expect(applyResponseTransform([{ id: 7, sandboxes: [sb] }], tool('mailtrap_list_sandbox_projects').responseMapping as never).value)
      .toEqual([{ id: 7, sandboxes: [{ id: 1, name: 'Dev', emails_count: 3 }] }]);
    expect(applyResponseTransform([{ id: 2, uuid: 'u', name: 'Reset', body_html: '<p>x</p>', body_text: 'x' }], tool('mailtrap_list_templates').responseMapping as never).value)
      .toEqual([{ id: 2, uuid: 'u', name: 'Reset' }]);
    const domains = applyResponseTransform({ data: [{ id: 3, domain_name: 'example.com', dns_verified: true, dns_records: [{ key: 'dkim' }] }] }, tool('mailtrap_list_sending_domains').responseMapping as never).value;
    expect(domains).toEqual({ data: [{ id: 3, domain_name: 'example.com', dns_verified: true }] });
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

  it('marks irreversible writes destructive and never calls a write read-only', () => {
    for (const n of ['mailtrap_clean_sandbox', 'mailtrap_delete_contact', 'mailtrap_delete_suppression', 'mailtrap_start_campaign']) {
      expect(tool(n).annotations?.destructiveHint).toBe(true);
    }
    for (const t of a.tools) {
      if (t.endpointMapping.method !== 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint === true}`).toBe(`${t.name}:false`);
    }
    const realMail = ['mailtrap_send_email', 'mailtrap_send_batch_emails', 'mailtrap_send_bulk_email', 'mailtrap_send_bulk_batch_emails', 'mailtrap_schedule_campaign', 'mailtrap_start_campaign'];
    for (const n of realMail) {
      expect(`${n}:${/confirm/i.test(tool(n).description)}`).toBe(`${n}:true`);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const live = process.env.RUN_MAILTRAP_LIVE === '1' && process.env.MAILTRAP_API_TOKEN ? describe : describe.skip;
live('mailtrap adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${process.env.MAILTRAP_API_TOKEN}`, Accept: 'application/json' },
    });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return (await res.json()) as unknown;
  };
  it('reads accounts, sandboxes, sending domains, templates and contact lists', async () => {
    const accounts = (await get('/api/accounts')) as Array<{ id: number; name: string }>;
    expect(accounts.length).toBeGreaterThan(0);
    expect(typeof accounts[0].id).toBe('number');
    expect(Array.isArray(await get('/api/sandboxes'))).toBe(true);
    expect(Array.isArray(((await get('/api/domains')) as { data: unknown[] }).data)).toBe(true);
    expect(Array.isArray(await get('/api/email_templates'))).toBe(true);
    expect(Array.isArray(await get('/api/contacts/lists'))).toBe(true);
  }, 60_000);
});
