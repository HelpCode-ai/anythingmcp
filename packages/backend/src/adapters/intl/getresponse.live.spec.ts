import * as adapter from './getresponse.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * GetResponse API v3 (apireference.getresponse.com, OpenAPI at
 * apireference.getresponse.com/open-api.json): base https://api.getresponse.com/v3
 * (GetResponse MAX: api3.getresponse360.com/v3 or api3.getresponse360.pl/v3 plus an
 * X-Domain header), header `X-Auth-Token: api-key <key>`, query[...] filters,
 * sort[...] ordering, page/perPage paging with TotalPages/CurrentPage headers.
 * Live part (reads only: account, lists, tags, custom fields, senders, newsletters):
 *   GETRESPONSE_API_KEY=... RUN_GETRESPONSE_LIVE=1 npx jest src/adapters/intl/getresponse
 * Optional: GETRESPONSE_API_URL (MAX host) and GETRESPONSE_DOMAIN (X-Domain).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: unknown;
    headers?: Record<string, unknown>;
    exposeHeaders?: string[];
  };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
// Connector variables (upper case) are not tool arguments.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) if (!/^[A-Z0-9_]+$/.test(p)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
const PREFIX = 'getresponse_';
const READ_POSTS = ['getresponse_search_contacts'];

describe('getresponse adapter: static spec conformance', () => {
  it('sends the key as X-Auth-Token with the api-key prefix, on a host chosen by GETRESPONSE_API_URL', () => {
    expect(a.requiredEnvVars).toEqual(['GETRESPONSE_API_URL', 'GETRESPONSE_API_KEY']);
    expect(a.optionalEnvVars).toEqual(['GETRESPONSE_DOMAIN']);
    expect(a.connector.baseUrl).toBe('{{GETRESPONSE_API_URL}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Auth-Token', apiKey: 'api-key {{GETRESPONSE_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/accounts');
    expect(a.envVarMeta.GETRESPONSE_API_KEY.secret).toBe(true);
    const host = new RegExp(a.envVarMeta.GETRESPONSE_API_URL.pattern as string);
    for (const ok of ['https://api.getresponse.com/v3', 'https://api3.getresponse360.com/v3', 'https://api3.getresponse360.pl/v3']) expect(host.test(ok)).toBe(true);
    for (const bad of ['https://api.getresponse.com/v3/', 'https://api.getresponse.com', 'http://api.getresponse.com/v3']) expect(host.test(bad)).toBe(false);
    const domain = new RegExp(a.envVarMeta.GETRESPONSE_DOMAIN.pattern as string);
    expect(domain.test('example.com')).toBe(true);
    expect(domain.test('https://example.com')).toBe(false);
  });

  it('sends X-Domain on every call only when GETRESPONSE_DOMAIN is set, and exposes the paging headers on lists', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.headers).toEqual({ 'X-Domain': '${GETRESPONSE_DOMAIN}' });
      expect(t.endpointMapping.path).toMatch(/^\/[a-z-]+/);
      if (t.endpointMapping.queryParams && 'perPage' in t.endpointMapping.queryParams) {
        expect(t.endpointMapping.queryParams).toMatchObject({ page: '$page', perPage: '$per_page' });
        expect(`${t.name}:${JSON.stringify(t.endpointMapping.exposeHeaders)}`).toBe(`${t.name}:["totalcount","totalpages","currentpage"]`);
      }
    }
  });

  it('maps contacts with the documented query[...] and sort[...] keys and bodies', () => {
    expect(tool('getresponse_list_contacts').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/contacts',
      queryParams: {
        'query[email]': '$email',
        'query[campaignId]': '$campaign_id',
        'query[createdOn][from]': '$created_from',
        'query[changedOn][to]': '$changed_to',
        additionalFlags: '$exact_match',
        'sort[createdOn]': '$sort_created_on',
      },
    });
    expect(tool('getresponse_get_contact').endpointMapping.path).toBe('/contacts/{contact_id}');
    expect(tool('getresponse_list_contact_activities').endpointMapping.path).toBe('/contacts/{contact_id}/activities');
    expect(tool('getresponse_create_contact').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/contacts',
      bodyMapping: { email: '$email', campaign: { campaignId: '$campaign_id' }, dayOfCycle: '$day_of_cycle', tags: '$tags', customFieldValues: '$custom_field_values' },
    });
    expect(tool('getresponse_create_contact').parameters?.required).toEqual(['email', 'campaign_id']);
    expect(tool('getresponse_update_contact').endpointMapping).toMatchObject({ method: 'POST', path: '/contacts/{contact_id}', bodyMapping: { campaign: '$campaign', note: '$note' } });
    expect(tool('getresponse_upsert_contact_tags').endpointMapping).toMatchObject({ method: 'POST', path: '/contacts/{contact_id}/tags', bodyMapping: { tags: '$tags' } });
    expect(tool('getresponse_upsert_contact_custom_fields').endpointMapping).toMatchObject({ path: '/contacts/{contact_id}/custom-fields', bodyMapping: { customFieldValues: '$custom_field_values' } });
    expect(tool('getresponse_delete_contact').endpointMapping).toMatchObject({ method: 'DELETE', path: '/contacts/{contact_id}', queryParams: { messageId: '$message_id', ipAddress: '$ip_address' } });
  });

  it('maps campaigns (lists) and their statistics', () => {
    expect(tool('getresponse_list_campaigns').endpointMapping.queryParams).toMatchObject({ 'query[name]': '$name', 'query[isDefault]': '$is_default', 'sort[name]': '$sort_name' });
    expect(tool('getresponse_get_campaign').endpointMapping.path).toBe('/campaigns/{campaign_id}');
    expect(tool('getresponse_list_campaign_contacts').endpointMapping.path).toBe('/campaigns/{campaign_id}/contacts');
    expect(tool('getresponse_get_campaigns_summary').endpointMapping).toMatchObject({ path: '/campaigns/statistics/summary', queryParams: { 'query[campaignId]': '$campaign_ids' } });
    for (const [n, p] of [
      ['getresponse_get_campaign_list_size', 'list-size'],
      ['getresponse_get_campaign_subscriptions', 'subscriptions'],
      ['getresponse_get_campaign_removals', 'removals'],
    ]) {
      expect(tool(n).endpointMapping).toMatchObject({ path: `/campaigns/statistics/${p}`, queryParams: { 'query[campaignId]': '$campaign_ids', 'query[groupBy]': '$group_by' } });
      expect(tool(n).parameters?.required).toEqual(['campaign_ids']);
    }
    expect(tool('getresponse_create_campaign').endpointMapping).toMatchObject({ method: 'POST', path: '/campaigns', bodyMapping: { name: '$name', languageCode: '$language_code', optinTypes: '$optin_types' } });
  });

  it('maps newsletters, sending and statistics', () => {
    expect(tool('getresponse_list_newsletters').endpointMapping.queryParams).toMatchObject({ 'query[type]': '$type', 'query[sendOn][from]': '$send_from', 'sort[sendOn]': '$sort_send_on' });
    expect(tool('getresponse_get_newsletter').endpointMapping.path).toBe('/newsletters/{newsletter_id}');
    expect(tool('getresponse_get_newsletter_statistics').endpointMapping.path).toBe('/newsletters/{newsletter_id}/statistics');
    expect(tool('getresponse_get_newsletters_statistics').endpointMapping.queryParams).toMatchObject({ 'query[newsletterId]': '$newsletter_ids', 'query[campaignId]': '$campaign_ids' });
    expect(tool('getresponse_create_newsletter').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/newsletters',
      bodyMapping: { type: '$type', campaign: { campaignId: '$campaign_id' }, fromField: { fromFieldId: '$from_field_id' }, replyTo: '$reply_to', content: { html: '$html', plain: '$plain' }, sendSettings: '$send_settings' },
    });
    expect(tool('getresponse_create_newsletter').parameters?.properties?.type.enum).toEqual(['draft', 'broadcast']);
    expect(tool('getresponse_send_newsletter_draft').endpointMapping).toEqual({
      method: 'POST',
      path: '/newsletters/send-draft',
      bodyMapping: { messageId: '$newsletter_id', sendSettings: '$send_settings' },
      headers: { 'X-Domain': '${GETRESPONSE_DOMAIN}' },
    });
    expect(tool('getresponse_cancel_newsletter').endpointMapping).toMatchObject({ method: 'POST', path: '/newsletters/{newsletter_id}/cancel' });
  });

  it('maps autoresponders, tags, custom fields, segments and senders', () => {
    expect(tool('getresponse_list_autoresponders').endpointMapping.queryParams).toMatchObject({ 'query[campaignId]': '$campaign_id', 'sort[openRate]': '$sort_open_rate' });
    expect(tool('getresponse_get_autoresponder').endpointMapping.path).toBe('/autoresponders/{autoresponder_id}');
    expect(tool('getresponse_get_autoresponder_statistics').endpointMapping.path).toBe('/autoresponders/{autoresponder_id}/statistics');
    // The API documents (and its PHP SDK sends) this spelling.
    expect(tool('getresponse_get_autoresponders_statistics').endpointMapping.queryParams).toMatchObject({ 'query[autoreponderId]': '$autoresponder_ids' });
    expect(tool('getresponse_list_tags').endpointMapping.queryParams).toMatchObject({ 'query[createdAt][from]': '$created_from', 'sort[createdAt]': '$sort_created_at' });
    expect(tool('getresponse_get_tag').endpointMapping.path).toBe('/tags/{tag_id}');
    expect(tool('getresponse_create_tag').endpointMapping).toMatchObject({ method: 'POST', path: '/tags', bodyMapping: { name: '$name' } });
    expect(tool('getresponse_get_custom_field').endpointMapping.path).toBe('/custom-fields/{custom_field_id}');
    expect(tool('getresponse_create_custom_field').parameters?.required).toEqual(['name', 'type', 'format', 'hidden', 'values']);
    expect(tool('getresponse_list_segments').endpointMapping.path).toBe('/search-contacts');
    expect(tool('getresponse_get_segment').endpointMapping.path).toBe('/search-contacts/{segment_id}');
    expect(tool('getresponse_list_segment_contacts').endpointMapping.path).toBe('/search-contacts/{segment_id}/contacts');
    expect(tool('getresponse_search_contacts').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/search-contacts/contacts',
      bodyMapping: { subscribersType: '$subscribers_type', sectionLogicOperator: '$section_logic_operator', section: '$section' },
    });
    expect(tool('getresponse_list_from_fields').endpointMapping.queryParams).toMatchObject({ 'query[isActive]': '$is_active' });
    expect(tool('getresponse_get_from_field').endpointMapping.path).toBe('/from-fields/{from_field_id}');
  });

  it('drops the HTML content from the autoresponder list and keeps the rest', () => {
    const out = applyResponseTransform(
      [{ autoresponderId: 'Q', name: 'Welcome', content: { html: '<p>long</p>', plain: 'long' }, statistics: { delivered: 5 } }],
      tool('getresponse_list_autoresponders').responseMapping as never,
    ).value;
    expect(out).toEqual([{ autoresponderId: 'Q', name: 'Welcome', statistics: { delivered: 5 } }]);
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

  it('marks the POST search read-only, deletes and replacements destructive, and installs delete switched off', () => {
    for (const n of READ_POSTS) expect(tool(n).annotations).toEqual({ readOnlyHint: true });
    expect(tool('getresponse_delete_contact').enabled).toBe(false);
    for (const n of ['getresponse_delete_contact', 'getresponse_update_contact', 'getresponse_cancel_newsletter']) expect(tool(n).annotations?.destructiveHint).toBe(true);
    const writes = a.tools.filter((t) => t.endpointMapping.method !== 'GET' && !READ_POSTS.includes(t.name));
    expect(writes.map((t) => t.name).sort()).toEqual(
      [
        'getresponse_cancel_newsletter',
        'getresponse_create_campaign',
        'getresponse_create_contact',
        'getresponse_create_custom_field',
        'getresponse_create_newsletter',
        'getresponse_create_tag',
        'getresponse_delete_contact',
        'getresponse_send_newsletter_draft',
        'getresponse_update_contact',
        'getresponse_upsert_contact_custom_fields',
        'getresponse_upsert_contact_tags',
      ].sort(),
    );
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe.tool).toBe('getresponse_get_account');
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_GETRESPONSE_LIVE === '1' && process.env.GETRESPONSE_API_KEY ? describe : describe.skip;
live('getresponse adapter: live (read-only)', () => {
  const base = process.env.GETRESPONSE_API_URL || 'https://api.getresponse.com/v3';
  const headers: Record<string, string> = { 'X-Auth-Token': `api-key ${process.env.GETRESPONSE_API_KEY}`, Accept: 'application/json' };
  if (process.env.GETRESPONSE_DOMAIN) headers['X-Domain'] = process.env.GETRESPONSE_DOMAIN;
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return { body: (await res.json()) as unknown, totalPages: res.headers.get('totalpages') };
  };
  it('reads the account, lists, tags, custom fields, senders and newsletters', async () => {
    const account = (await get('/accounts')).body as { accountId?: string; email?: string };
    expect(typeof account.accountId).toBe('string');
    const campaigns = await get('/campaigns?perPage=5');
    expect(Array.isArray(campaigns.body)).toBe(true);
    expect(campaigns.totalPages).not.toBeNull();
    for (const p of ['/tags?perPage=5', '/custom-fields?perPage=5', '/from-fields?perPage=5', '/newsletters?perPage=5&fields=name,subject', '/search-contacts?perPage=5', '/accounts/timezones']) {
      expect(Array.isArray((await get(p)).body)).toBe(true);
    }
    const first = (campaigns.body as Array<{ campaignId: string }>)[0];
    if (first) {
      expect((await get(`/campaigns/${first.campaignId}`)).body).toMatchObject({ campaignId: first.campaignId });
      await get(`/campaigns/statistics/summary?query[campaignId]=${first.campaignId}`);
    }
  }, 60_000);
});
