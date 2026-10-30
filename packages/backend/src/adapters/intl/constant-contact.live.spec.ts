import * as adapter from './constant-contact.json';

/**
 * Constant Contact V3 API (developer.constantcontact.com, OpenAPI 2.0 at api.cc.email/v3/swagger.yaml):
 * base https://api.cc.email/v3, OAuth2 authorization code with the user's own V3 application
 * (authz.constantcontact.com/oauth2/default, client credentials as HTTP Basic at the token endpoint),
 * Bearer access token of 24 hours, cursor paging through _links.next.href.
 * Live part (reads only: account summary, lists, tags, custom fields, campaigns, campaign summaries):
 *   CONSTANT_CONTACT_ACCESS_TOKEN=... RUN_CONSTANT_CONTACT_LIVE=1 npx jest src/adapters/intl/constant-contact
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
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string>; healthcheckPath?: string };
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
const PREFIX = 'constant_contact_';
const ACT = '/emails/activities/{campaign_activity_id}';

describe('constant-contact adapter: static spec conformance', () => {
  it('signs in with OAuth2 authorization code at authz.constantcontact.com, Basic client auth and offline_access', () => {
    expect(a.slug).toBe('constant-contact');
    expect(a.region).toBe('intl');
    expect(a.requiredEnvVars).toEqual(['CONSTANT_CONTACT_CLIENT_ID', 'CONSTANT_CONTACT_CLIENT_SECRET']);
    expect(a.optionalEnvVars).toEqual(['CONSTANT_CONTACT_REFRESH_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://api.cc.email/v3');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{CONSTANT_CONTACT_CLIENT_ID}}',
      clientSecret: '{{CONSTANT_CONTACT_CLIENT_SECRET}}',
      refreshToken: '{{CONSTANT_CONTACT_REFRESH_TOKEN}}',
      authorizationUrl: 'https://authz.constantcontact.com/oauth2/default/v1/authorize',
      tokenUrl: 'https://authz.constantcontact.com/oauth2/default/v1/token',
      tokenAuthMethod: 'client_secret_basic',
      scopes: 'account_read contact_data campaign_data offline_access',
    });
    expect(a.envVarMeta?.CONSTANT_CONTACT_CLIENT_SECRET.secret).toBe(true);
    expect(a.envVarMeta?.CONSTANT_CONTACT_REFRESH_TOKEN.advanced).toBe(true);
    expect(a.connector.healthcheckPath).toBe('/account/summary');
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith('/v3')).toBe(false);
  });

  it('maps contacts, lists, tags and custom fields to the documented paths and fields', () => {
    expect(tool('constant_contact_list_contacts').endpointMapping).toMatchObject({
      method: 'GET', path: '/contacts',
      queryParams: { email: '$email', status: '$status', lists: '$lists', tags: '$tags', segment_id: '$segment_id', updated_after: '$updated_after', include: '$include', include_count: '$include_count', limit: '$limit', cursor: '$cursor' },
    });
    expect(tool('constant_contact_get_contact').endpointMapping).toEqual({ method: 'GET', path: '/contacts/{contact_id}', queryParams: { include: '$include' } });
    expect(tool('constant_contact_create_contact').endpointMapping).toMatchObject({ method: 'POST', path: '/contacts', bodyMapping: { email_address: { address: '$email', permission_to_send: '$permission_to_send' }, create_source: '$create_source', list_memberships: '$list_memberships' } });
    expect(tool('constant_contact_create_or_update_contact').endpointMapping).toMatchObject({ method: 'POST', path: '/contacts/sign_up_form', bodyMapping: { email_address: '$email', list_memberships: '$list_memberships', street_address: '$street_address' } });
    expect(tool('constant_contact_update_contact').endpointMapping).toMatchObject({ method: 'PUT', path: '/contacts/{contact_id}', bodyMapping: { update_source: '$update_source' } });
    expect(tool('constant_contact_list_contact_lists').endpointMapping.queryParams).toMatchObject({ include_membership_count: '$include_membership_count', cursor: '$cursor' });
    expect(tool('constant_contact_create_contact_list').endpointMapping).toEqual({ method: 'POST', path: '/contact_lists', bodyMapping: { name: '$name', favorite: '$favorite', description: '$description' } });
    expect(tool('constant_contact_add_contacts_to_lists').endpointMapping).toEqual({ method: 'POST', path: '/activities/add_list_memberships', bodyMapping: { source: '$source', list_ids: '$list_ids', exclude: '$exclude' } });
    expect(tool('constant_contact_remove_contacts_from_lists').endpointMapping.path).toBe('/activities/remove_list_memberships');
    expect(tool('constant_contact_add_tags_to_contacts').endpointMapping).toEqual({ method: 'POST', path: '/activities/contacts_taggings_add', bodyMapping: { source: '$source', tag_ids: '$tag_ids', exclude: '$exclude' } });
    expect(tool('constant_contact_remove_tags_from_contacts').endpointMapping.path).toBe('/activities/contacts_taggings_remove');
    expect(tool('constant_contact_list_tags').endpointMapping).toEqual({ method: 'GET', path: '/contact_tags', queryParams: { include_count: '$include_count', limit: '$limit', cursor: '$cursor' } });
    expect(tool('constant_contact_create_custom_field').endpointMapping).toEqual({ method: 'POST', path: '/contact_custom_fields', bodyMapping: { label: '$label', type: '$type', choices: '$choices', metadata: '$metadata' } });
    expect(tool('constant_contact_get_segment').endpointMapping.path).toBe('/segments/{segment_id}');
    expect(tool('constant_contact_get_activity').endpointMapping.path).toBe('/activities/{activity_id}');
  });

  it('maps email campaigns, activities, tests and schedules', () => {
    expect(tool('constant_contact_list_email_campaigns').endpointMapping).toEqual({ method: 'GET', path: '/emails', queryParams: { after_date: '$after_date', before_date: '$before_date', limit: '$limit', cursor: '$cursor' } });
    expect(tool('constant_contact_get_email_campaign').endpointMapping.path).toBe('/emails/{campaign_id}');
    expect(tool('constant_contact_create_email_campaign').endpointMapping).toEqual({
      method: 'POST', path: '/emails',
      bodyMapping: { name: '$name', email_campaign_activities: [{ format_type: 5, from_name: '$from_name', from_email: '$from_email', reply_to_email: '$reply_to_email', subject: '$subject', preheader: '$preheader', html_content: '$html_content', physical_address_in_footer: '$physical_address_in_footer' }] },
    });
    expect(tool('constant_contact_update_email_campaign_activity').endpointMapping).toMatchObject({ method: 'PUT', path: ACT, bodyMapping: { contact_list_ids: '$contact_list_ids', segment_ids: '$segment_ids' } });
    expect(tool('constant_contact_rename_email_campaign').endpointMapping).toEqual({ method: 'PATCH', path: '/emails/{campaign_id}', bodyMapping: { name: '$name' } });
    expect(tool('constant_contact_get_email_preview').endpointMapping.path).toBe(`${ACT}/previews`);
    expect(tool('constant_contact_send_test_email').endpointMapping).toEqual({ method: 'POST', path: `${ACT}/tests`, bodyMapping: { email_addresses: '$email_addresses', personal_message: '$personal_message' } });
    expect(tool('constant_contact_schedule_email_campaign_activity').endpointMapping).toEqual({ method: 'POST', path: `${ACT}/schedules`, bodyMapping: { scheduled_date: '$scheduled_date' } });
    expect(tool('constant_contact_unschedule_email_campaign_activity').endpointMapping).toEqual({ method: 'DELETE', path: `${ACT}/schedules` });
    expect(tool('constant_contact_get_email_send_history').endpointMapping.path).toBe(`${ACT}/send_history`);
  });

  it('maps the reports, with next= paging where the API uses it', () => {
    expect(tool('constant_contact_list_email_campaign_summaries').endpointMapping).toEqual({ method: 'GET', path: '/reports/summary_reports/email_campaign_summaries', queryParams: { limit: '$limit', next: '$next' } });
    expect(tool('constant_contact_get_email_campaign_stats').endpointMapping.path).toBe('/reports/stats/email_campaigns/{campaign_ids}');
    expect(tool('constant_contact_get_email_campaign_activity_stats').endpointMapping.path).toBe('/reports/stats/email_campaign_activities/{campaign_activity_ids}');
    expect(tool('constant_contact_get_email_links_report').endpointMapping).toEqual({ method: 'GET', path: '/reports/email_reports/{campaign_activity_id}/links', queryParams: { no_clicks: '$no_clicks' } });
    const tr = tool('constant_contact_get_email_tracking_report');
    expect(tr.endpointMapping).toEqual({ method: 'GET', path: '/reports/email_reports/{campaign_activity_id}/tracking/{report_type}', queryParams: { url_id: '$url_id', bounce_code: '$bounce_code', limit: '$limit', next: '$next' } });
    expect(tr.parameters?.properties?.report_type.enum).toEqual(['sends', 'opens', 'unique_opens', 'didnotopens', 'clicks', 'forwards', 'optouts', 'bounces']);
    expect(tool('constant_contact_get_contact_activity_details').endpointMapping.queryParams).toMatchObject({ tracking_activities_list: '$tracking_activities_list', next: '$next' });
    expect(tool('constant_contact_get_contact_activity_summary').endpointMapping).toEqual({ method: 'GET', path: '/reports/contact_reports/{contact_id}/activity_summary', queryParams: { start: '$start', end: '$end' } });
    expect(tool('constant_contact_get_contact_open_click_rates').endpointMapping.path).toBe('/reports/contact_reports/{contact_id}/open_and_click_rates');
    expect(tool('constant_contact_list_segments').endpointMapping.queryParams).toMatchObject({ next: '$next' });
  });

  it('installs deletes and the real send switched off, and leaves out events, SMS, social and partner endpoints', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(
      ['constant_contact_delete_contact', 'constant_contact_delete_contact_list', 'constant_contact_schedule_email_campaign_activity'],
    );
    for (const t of a.tools) {
      expect(t.endpointMapping.path).not.toMatch(/^\/(events|social|partner)/);
      expect(t.endpointMapping.path).not.toContain('sms');
    }
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
      for (const r of t.parameters?.required ?? []) expect(`${t.name}:${r}:${props.includes(r)}`).toBe(`${t.name}:${r}:true`);
    }
  });

  it('marks deletes and full replacements destructive and never calls a GET a write', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping.method;
      if (m === 'DELETE') expect(`${t.name}:${t.annotations?.destructiveHint}`).toBe(`${t.name}:true`);
      if (m === 'GET') expect(t.annotations?.readOnlyHint === false).toBe(false);
    }
    for (const n of ['constant_contact_update_contact', 'constant_contact_update_email_campaign_activity', 'constant_contact_schedule_email_campaign_activity', 'constant_contact_remove_contacts_from_lists']) {
      expect(`${n}:${tool(n).annotations?.destructiveHint}`).toBe(`${n}:true`);
    }
  });

  it('probes with a read tool without required parameters and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping).toEqual({ method: 'GET', path: '/account/summary', queryParams: { extra_fields: '$extra_fields' } });
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_CONSTANT_CONTACT_LIVE === '1' && process.env.CONSTANT_CONTACT_ACCESS_TOKEN ? describe : describe.skip;
live('constant-contact adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Bearer ${process.env.CONSTANT_CONTACT_ACCESS_TOKEN}`, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads the account, lists, tags, custom fields, campaigns and campaign summaries', async () => {
    expect(await get('/account/summary')).toHaveProperty('encoded_account_id');
    expect(Array.isArray((await get('/contact_lists?limit=1')).lists)).toBe(true);
    expect(await get('/contact_tags?limit=1')).toHaveProperty('tags');
    expect(await get('/contact_custom_fields?limit=1')).toHaveProperty('custom_fields');
    expect(Array.isArray((await get('/emails?limit=1')).campaigns)).toBe(true);
    expect(await get('/reports/summary_reports/email_campaign_summaries?limit=1')).toHaveProperty('bulk_email_campaign_summaries');
  }, 60_000);
});
