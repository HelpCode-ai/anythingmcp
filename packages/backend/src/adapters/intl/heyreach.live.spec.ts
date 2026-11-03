import * as adapter from './heyreach.json';

/**
 * HeyReach public API (Postman documentation, documenter.getpostman.com/view/23808049/2sA2xb5F75):
 * base https://api.heyreach.io/api/public, X-API-KEY header, reads mostly as POST with a JSON
 * body (offset/limit paging, items + totalCount), camelCase body fields.
 * Live part (reads only: key check, campaigns, sender accounts, lists, webhooks):
 *   HEYREACH_API_KEY=... RUN_HEYREACH_LIVE=1 npx jest src/adapters/intl/heyreach
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown> };
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
const PREFIX = 'heyreach_';

// POST endpoints of the API that only read.
const POST_READS = [
  'heyreach_list_campaigns',
  'heyreach_list_campaign_leads',
  'heyreach_get_campaigns_for_lead',
  'heyreach_list_conversations',
  'heyreach_list_linkedin_accounts',
  'heyreach_list_lists',
  'heyreach_list_list_leads',
  'heyreach_list_list_companies',
  'heyreach_get_lists_for_lead',
  'heyreach_get_lead',
  'heyreach_get_lead_tags',
  'heyreach_list_network',
  'heyreach_is_connection',
  'heyreach_get_overall_stats',
  'heyreach_get_stats_by_campaign',
  'heyreach_list_webhooks',
];

describe('heyreach adapter: static spec conformance', () => {
  it('authenticates with the X-API-KEY header on the public API base', () => {
    expect(a.requiredEnvVars).toEqual(['HEYREACH_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.heyreach.io/api/public');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-API-KEY', apiKey: '{{HEYREACH_API_KEY}}' });
    expect(a.envVarMeta.HEYREACH_API_KEY.secret).toBe(true);
  });

  it('maps campaign endpoints with the documented camelCase fields', () => {
    expect(tool('heyreach_list_campaigns').endpointMapping).toEqual({
      method: 'POST',
      path: '/campaign/GetAll',
      bodyMapping: { offset: '$offset', limit: '$limit', keyword: '$keyword', statuses: '$statuses', accountIds: '$account_ids' },
    });
    expect(tool('heyreach_get_campaign').endpointMapping).toEqual({ method: 'GET', path: '/campaign/GetById', queryParams: { campaignId: '$campaign_id' } });
    expect(tool('heyreach_get_campaign_sequence').endpointMapping).toEqual({ method: 'GET', path: '/campaign/GetCampaignSequence', queryParams: { campaignId: '$campaign_id' } });
    expect(tool('heyreach_list_campaign_leads').endpointMapping).toMatchObject({ path: '/campaign/GetLeadsFromCampaign', bodyMapping: { campaignId: '$campaign_id', timeFrom: '$time_from', timeTo: '$time_to', timeFilter: '$time_filter' } });
    expect(tool('heyreach_get_campaigns_for_lead').endpointMapping.bodyMapping).toMatchObject({ email: '$email', linkedinId: '$linkedin_id', profileUrl: '$profile_url' });
    expect(tool('heyreach_add_leads_to_campaign').endpointMapping).toEqual({
      method: 'POST',
      path: '/campaign/AddLeadsToCampaignV2',
      bodyMapping: { campaignId: '$campaign_id', accountLeadPairs: '$account_lead_pairs', resumePausedCampaign: '$resume_paused_campaign', resumeFinishedCampaign: '$resume_finished_campaign' },
    });
    expect(tool('heyreach_stop_lead_in_campaign').endpointMapping.bodyMapping).toEqual({ campaignId: '$campaign_id', leadMemberId: '$lead_member_id', leadUrl: '$lead_url' });
    for (const [n, p] of [
      ['heyreach_pause_campaign', '/campaign/Pause'],
      ['heyreach_resume_campaign', '/campaign/Resume'],
      ['heyreach_start_campaign', '/campaign/StartCampaign'],
    ])
      expect(tool(n).endpointMapping).toEqual({ method: 'POST', path: p, queryParams: { campaignId: '$campaign_id' }, bodyMapping: {} });
    expect(tool('heyreach_update_lead_custom_fields').endpointMapping).toEqual({
      method: 'PATCH',
      path: '/campaign/UpdateLeadCustomFields/campaigns/{campaign_id}/leads/custom-fields',
      bodyMapping: { leadMemberIdOrUrl: '$lead_member_id_or_url', customFields: '$custom_fields' },
    });
  });

  it('maps inbox, account, list, lead, stats and webhook endpoints', () => {
    expect(tool('heyreach_list_conversations').endpointMapping).toEqual({ method: 'POST', path: '/inbox/GetConversationsV3', bodyMapping: { limit: '$limit', cursor: '$cursor', from: '$from', to: '$to', filters: '$filters' } });
    expect(tool('heyreach_get_conversation').endpointMapping).toEqual({ method: 'GET', path: '/inbox/GetChatroom/{account_id}/{conversation_id}' });
    expect(tool('heyreach_send_message').endpointMapping).toEqual({ method: 'POST', path: '/inbox/SendMessage', bodyMapping: { conversationId: '$conversation_id', linkedInAccountId: '$linkedin_account_id', message: '$message', subject: '$subject' } });
    expect(tool('heyreach_set_conversation_seen').endpointMapping.bodyMapping).toEqual({ conversationId: '$conversation_id', linkedInAccountId: '$linkedin_account_id', seen: '$seen' });
    expect(tool('heyreach_list_linkedin_accounts').endpointMapping.path).toBe('/li_account/GetAll');
    expect(tool('heyreach_get_linkedin_account').endpointMapping).toEqual({ method: 'GET', path: '/li_account/GetById', queryParams: { accountId: '$account_id' } });
    expect(tool('heyreach_get_linkedin_account_status').endpointMapping.path).toBe('/li_account/GetAccountStatus/{account_id}');
    expect(tool('heyreach_list_lists').endpointMapping.bodyMapping).toMatchObject({ listType: '$list_type', campaignIds: '$campaign_ids' });
    expect(tool('heyreach_get_list').endpointMapping).toEqual({ method: 'GET', path: '/list/GetById', queryParams: { listId: '$list_id' } });
    expect(tool('heyreach_list_list_leads').endpointMapping).toMatchObject({ path: '/list/GetLeadsFromList', bodyMapping: { listId: '$list_id', leadProfileUrl: '$lead_profile_url', createdFrom: '$created_from' } });
    expect(tool('heyreach_add_leads_to_list').endpointMapping).toEqual({ method: 'POST', path: '/list/AddLeadsToListV2', bodyMapping: { listId: '$list_id', leads: '$leads' } });
    expect(tool('heyreach_delete_leads_from_list').endpointMapping).toEqual({ method: 'DELETE', path: '/list/DeleteLeadsFromListByProfileUrl', bodyMapping: { listId: '$list_id', profileUrls: '$profile_urls' } });
    expect(tool('heyreach_create_list').parameters?.properties?.type.enum).toEqual(['USER_LIST', 'COMPANY_LIST']);
    expect(tool('heyreach_get_lead').endpointMapping).toEqual({ method: 'POST', path: '/lead/GetLead', bodyMapping: { profileUrl: '$profile_url' } });
    expect(tool('heyreach_add_lead_tags').endpointMapping.bodyMapping).toEqual({ leadProfileUrl: '$lead_profile_url', leadLinkedInId: '$lead_linkedin_id', tags: '$tags', createTagIfNotExisting: '$create_tag_if_not_existing' });
    expect(tool('heyreach_list_network').endpointMapping.bodyMapping).toEqual({ senderId: '$sender_id', pageNumber: '$page_number', pageSize: '$page_size' });
    expect(tool('heyreach_get_overall_stats').endpointMapping).toEqual({ method: 'POST', path: '/stats/GetOverallStats', bodyMapping: { startDate: '$start_date', endDate: '$end_date', accountIds: '$account_ids', campaignIds: '$campaign_ids' } });
    expect(tool('heyreach_get_stats_by_campaign').endpointMapping.path).toBe('/stats/GetOverallStatsByCampaign');
    expect(tool('heyreach_create_webhook').endpointMapping.bodyMapping).toEqual({ webhookName: '$webhook_name', webhookUrl: '$webhook_url', eventType: '$event_type', campaignIds: '$campaign_ids' });
    expect(tool('heyreach_update_webhook').endpointMapping).toMatchObject({ method: 'PATCH', path: '/webhooks/UpdateWebhook', queryParams: { webhookId: '$webhook_id' } });
    expect(tool('heyreach_delete_webhook').endpointMapping).toEqual({ method: 'DELETE', path: '/webhooks/DeleteWebhook', queryParams: { webhookId: '$webhook_id' } });
  });

  it('marks POST reads read-only and deletions destructive', () => {
    for (const n of POST_READS) {
      expect(tool(n).endpointMapping.method).toBe('POST');
      expect(`${n}:${tool(n).annotations?.readOnlyHint}`).toBe(`${n}:true`);
    }
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'DELETE')) expect(`${t.name}:${t.annotations?.destructiveHint}`).toBe(`${t.name}:true`);
    expect(tool('heyreach_stop_lead_in_campaign').annotations?.destructiveHint).toBe(true);
    expect(tool('heyreach_replace_lead_tags').annotations?.destructiveHint).toBe(true);
    // Account connection (passwords, cookies, proxies) and organization management are left out.
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/li_account\/(Connect|Reconnect|SubmitPin|Relogin|Resync|UpdateProxy|RemoveAccount)|management|blacklist/i);
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

  it('probes with a read tool and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping).toEqual({ method: 'GET', path: '/auth/CheckApiKey' });
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_HEYREACH_LIVE === '1' && process.env.HEYREACH_API_KEY ? describe : describe.skip;
live('heyreach adapter: live (read-only)', () => {
  const headers = { 'X-API-KEY': process.env.HEYREACH_API_KEY as string, 'Content-Type': 'application/json', Accept: 'application/json' };
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    expect(res.status).toBe(200);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as { totalCount?: number; items?: unknown[] };
  };
  it('checks the key and reads campaigns, senders, lists and webhooks', async () => {
    await call('GET', '/auth/CheckApiKey');
    expect(Array.isArray((await call('POST', '/campaign/GetAll', { offset: 0, limit: 5 })).items)).toBe(true);
    expect(Array.isArray((await call('POST', '/li_account/GetAll', { offset: 0, limit: 5 })).items)).toBe(true);
    expect(Array.isArray((await call('POST', '/list/GetAll', { offset: 0, limit: 5 })).items)).toBe(true);
    expect(Array.isArray((await call('POST', '/webhooks/GetAllWebhooks', { offset: 0, limit: 5 })).items)).toBe(true);
  }, 60_000);
});
