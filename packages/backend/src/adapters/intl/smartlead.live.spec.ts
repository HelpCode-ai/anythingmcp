import * as adapter from './smartlead.json';

/**
 * Smartlead API (api.smartlead.ai): base https://server.smartlead.ai/api/v1, the key
 * as the api_key query parameter on every request, offset/limit paging.
 * Live part (reads only: campaigns, lead categories, email accounts, one campaign's leads):
 *   SMARTLEAD_API_KEY=... RUN_SMARTLEAD_LIVE=1 npx jest src/adapters/intl/smartlead
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
const PREFIX = 'smartlead_';
const C = '/campaigns/{campaign_id}';

describe('smartlead adapter: static spec conformance', () => {
  it('sends the key as the api_key query parameter', () => {
    expect(a.requiredEnvVars).toEqual(['SMARTLEAD_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://server.smartlead.ai/api/v1');
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ api_key: '{{SMARTLEAD_API_KEY}}' });
    expect(a.envVarMeta.SMARTLEAD_API_KEY.secret).toBe(true);
    // No tool declares its own api_key: it would collide with the injected one.
    for (const t of a.tools) expect(Object.keys(t.endpointMapping.queryParams ?? {})).not.toContain('api_key');
  });

  it('maps campaign setup and control endpoints', () => {
    expect(tool('smartlead_list_campaigns').endpointMapping).toEqual({ method: 'GET', path: '/campaigns/', queryParams: { client_id: '$client_id', include_tags: '$include_tags' } });
    expect(tool('smartlead_get_campaign').endpointMapping.path).toBe(C);
    expect(tool('smartlead_get_campaign_sequences').endpointMapping).toEqual({ method: 'GET', path: `${C}/sequences` });
    expect(tool('smartlead_create_campaign').endpointMapping).toEqual({ method: 'POST', path: '/campaigns/create', bodyMapping: { name: '$name', client_id: '$client_id' } });
    expect(tool('smartlead_update_campaign_status').endpointMapping).toEqual({ method: 'POST', path: `${C}/status`, bodyMapping: { status: '$status' } });
    expect(tool('smartlead_update_campaign_status').parameters?.properties?.status.enum).toEqual(['START', 'PAUSED', 'STOPPED', 'ARCHIVED']);
    expect(tool('smartlead_update_campaign_schedule').endpointMapping).toMatchObject({
      method: 'POST',
      path: `${C}/schedule`,
      bodyMapping: { timezone: '$timezone', days_of_the_week: '$days_of_the_week', start_hour: '$start_hour', end_hour: '$end_hour', min_time_btw_emails: '$min_time_btw_emails', max_new_leads_per_day: '$max_new_leads_per_day' },
    });
    expect(tool('smartlead_update_campaign_settings').endpointMapping).toMatchObject({ method: 'POST', path: `${C}/settings`, bodyMapping: { track_settings: '$track_settings', stop_lead_settings: '$stop_lead_settings' } });
    expect(tool('smartlead_save_campaign_sequences').endpointMapping).toEqual({ method: 'POST', path: `${C}/sequences`, bodyMapping: { sequences: '$sequences' } });
    expect(tool('smartlead_add_email_accounts_to_campaign').endpointMapping).toEqual({ method: 'POST', path: `${C}/email-accounts`, bodyMapping: { email_account_ids: '$email_account_ids' } });
  });

  it('maps lead, reply and analytics endpoints', () => {
    expect(tool('smartlead_list_campaign_leads').endpointMapping).toMatchObject({ path: `${C}/leads`, queryParams: { offset: '$offset', limit: '$limit', lead_category_id: '$lead_category_id', emailStatus: '$emailStatus' } });
    expect(tool('smartlead_add_leads_to_campaign').endpointMapping).toEqual({ method: 'POST', path: `${C}/leads`, bodyMapping: { lead_list: '$lead_list', settings: '$settings' } });
    expect(tool('smartlead_get_lead_by_email').endpointMapping).toEqual({ method: 'GET', path: '/leads/', queryParams: { email: '$email' } });
    expect(tool('smartlead_get_lead_message_history').endpointMapping.path).toBe(`${C}/leads/{lead_id}/message-history`);
    expect(tool('smartlead_update_lead_category').endpointMapping).toEqual({ method: 'POST', path: `${C}/leads/{lead_id}/category`, bodyMapping: { category_id: '$category_id', pause_lead: '$pause_lead' } });
    expect(tool('smartlead_pause_lead').endpointMapping.path).toBe(`${C}/leads/{lead_id}/pause`);
    expect(tool('smartlead_resume_lead').endpointMapping.bodyMapping).toEqual({ resume_lead_with_delay_days: '$resume_lead_with_delay_days' });
    expect(tool('smartlead_unsubscribe_lead_globally').endpointMapping.path).toBe('/leads/{lead_id}/unsubscribe');
    expect(tool('smartlead_delete_lead_from_campaign').endpointMapping).toEqual({ method: 'DELETE', path: `${C}/leads/{lead_id}` });
    expect(tool('smartlead_list_lead_categories').endpointMapping).toEqual({ method: 'GET', path: '/leads/fetch-categories' });
    expect(tool('smartlead_list_inbox_replies').endpointMapping).toEqual({
      method: 'POST',
      path: '/master-inbox/inbox-replies',
      queryParams: { fetch_message_history: '$fetch_message_history' },
      bodyMapping: { offset: '$offset', limit: '$limit', filters: '$filters', sortBy: '$sortBy' },
    });
    expect(tool('smartlead_reply_to_lead').endpointMapping).toMatchObject({ method: 'POST', path: `${C}/reply-email-thread`, bodyMapping: { email_stats_id: '$email_stats_id', email_body: '$email_body', reply_message_id: '$reply_message_id', reply_email_time: '$reply_email_time' } });
    expect(tool('smartlead_create_lead_note').endpointMapping).toEqual({ method: 'POST', path: '/master-inbox/create-note', bodyMapping: { email_lead_map_id: '$email_lead_map_id', note_message: '$note_message' } });
    expect(tool('smartlead_get_campaign_analytics_by_date').endpointMapping).toMatchObject({ path: `${C}/analytics-by-date`, queryParams: { start_date: '$start_date', end_date: '$end_date' } });
    expect(tool('smartlead_get_campaign_sequence_analytics').endpointMapping.path).toBe(`${C}/sequence-analytics`);
    expect(tool('smartlead_get_campaign_statistics').endpointMapping.path).toBe(`${C}/statistics`);
    expect(tool('smartlead_get_overall_analytics').endpointMapping).toMatchObject({ path: '/analytics/overall-stats-v2', queryParams: { start_date: '$start_date', end_date: '$end_date' } });
  });

  it('maps mailbox and webhook endpoints', () => {
    expect(tool('smartlead_list_email_accounts').endpointMapping).toMatchObject({ method: 'GET', path: '/email-accounts/', queryParams: { offset: '$offset', limit: '$limit' } });
    expect(tool('smartlead_get_email_account').endpointMapping.path).toBe('/email-accounts/{email_account_id}/');
    expect(tool('smartlead_get_warmup_stats').endpointMapping.path).toBe('/email-accounts/{email_account_id}/warmup-stats');
    expect(tool('smartlead_update_warmup').endpointMapping).toMatchObject({ method: 'POST', path: '/email-accounts/{email_account_id}/warmup', bodyMapping: { warmup_enabled: '$warmup_enabled' } });
    expect(tool('smartlead_upsert_campaign_webhook').endpointMapping).toEqual({
      method: 'POST',
      path: `${C}/webhooks`,
      bodyMapping: { id: '$id', name: '$name', webhook_url: '$webhook_url', event_types: '$event_types', categories: '$categories' },
    });
    expect(tool('smartlead_delete_campaign_webhook').endpointMapping).toEqual({ method: 'DELETE', path: `${C}/webhooks/{webhook_id}` });
  });

  it('marks the POST inbox read read-only and every delete, stop and unsubscribe destructive', () => {
    expect(tool('smartlead_list_inbox_replies').annotations).toEqual({ readOnlyHint: true });
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'DELETE')) expect(`${t.name}:${t.annotations?.destructiveHint}`).toBe(`${t.name}:true`);
    for (const n of ['smartlead_update_campaign_status', 'smartlead_save_campaign_sequences', 'smartlead_unsubscribe_lead_from_campaign', 'smartlead_unsubscribe_lead_globally'])
      expect(tool(n).annotations?.destructiveHint).toBe(true);
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
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_SMARTLEAD_LIVE === '1' && process.env.SMARTLEAD_API_KEY ? describe : describe.skip;
live('smartlead adapter: live (read-only)', () => {
  const get = async (path: string, query: Record<string, string> = {}) => {
    const qs = new URLSearchParams({ ...query, api_key: process.env.SMARTLEAD_API_KEY as string });
    const res = await fetch(`${a.connector.baseUrl}${path}?${qs}`, { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as unknown;
  };
  it('reads campaigns, lead categories, mailboxes and the leads of the newest campaign', async () => {
    const campaigns = (await get('/campaigns/')) as Array<{ id: number; status: string }>;
    expect(Array.isArray(campaigns)).toBe(true);
    expect(Array.isArray(await get('/leads/fetch-categories'))).toBe(true);
    expect(Array.isArray(await get('/email-accounts/', { offset: '0', limit: '5' }))).toBe(true);
    if (campaigns.length) {
      const leads = (await get(`/campaigns/${campaigns[0].id}/leads`, { offset: '0', limit: '5' })) as { data?: unknown[] };
      expect(Array.isArray(leads.data)).toBe(true);
    }
  }, 60_000);
});
