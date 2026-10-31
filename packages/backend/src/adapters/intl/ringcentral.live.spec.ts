import * as adapter from './ringcentral.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * RingCentral REST API (developers.ringcentral.com/api-reference, OpenAPI rc-platform.yml from
 * netstorage.ringcentral.com/dpw/api-reference/specs, checked on 30 Oct 2026): production host
 * https://platform.ringcentral.com with /restapi/v1.0 and /rcvideo paths, OAuth 2.0 authorization
 * code with the client authenticating by HTTP Basic at /restapi/oauth/token. The developer sandbox
 * (platform.devtest.ringcentral.com) was retired at the end of 2024 and no longer resolves.
 * Live part (reads only: extension, account, phone numbers, call log, messages, contacts, presence):
 *   RINGCENTRAL_ACCESS_TOKEN=... RUN_RINGCENTRAL_LIVE=1 npx jest src/adapters/intl/ringcentral
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
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
const ACC = '/restapi/v1.0/account/~';
const ME = `${ACC}/extension/~`;

describe('ringcentral adapter: static spec conformance', () => {
  it('signs in with OAuth 2.0 authorization code on the production host, Basic client auth at the token URL', () => {
    expect(a.requiredEnvVars).toEqual(['RINGCENTRAL_CLIENT_ID', 'RINGCENTRAL_CLIENT_SECRET']);
    expect(a.connector.baseUrl).toBe('https://platform.ringcentral.com');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{RINGCENTRAL_CLIENT_ID}}',
      clientSecret: '{{RINGCENTRAL_CLIENT_SECRET}}',
      authorizationUrl: 'https://platform.ringcentral.com/restapi/oauth/authorize',
      tokenUrl: 'https://platform.ringcentral.com/restapi/oauth/token',
      tokenAuthMethod: 'client_secret_basic',
    });
    expect(a.envVarMeta?.RINGCENTRAL_CLIENT_SECRET.secret).toBe(true);
    expect(a.connector.healthcheckPath).toBe(`${ME}`);
    expect(JSON.stringify(a.connector)).not.toMatch(/devtest/);
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/(restapi\/v1\.0|rcvideo\/v[12])\//);
  });

  it('maps account, extensions, directory and numbers', () => {
    expect(tool('ringcentral_get_account').endpointMapping).toEqual({ method: 'GET', path: ACC });
    expect(tool('ringcentral_get_my_extension').endpointMapping).toEqual({ method: 'GET', path: ME });
    expect(tool('ringcentral_list_extensions').endpointMapping).toMatchObject({ path: `${ACC}/extension`, queryParams: { type: '$type', status: '$status', extensionNumber: '$extension_number', email: '$email', page: '$page', perPage: '$per_page' } });
    expect(tool('ringcentral_get_extension').endpointMapping.path).toBe(`${ACC}/extension/{extension_id}`);
    expect(tool('ringcentral_search_directory').endpointMapping).toMatchObject({ method: 'POST', path: `${ACC}/directory/entries/search`, bodyMapping: { searchString: '$search_string' } });
    expect(tool('ringcentral_search_directory').annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool('ringcentral_list_my_phone_numbers').endpointMapping.path).toBe(`${ME}/phone-number`);
  });

  it('maps call log, active calls and RingOut', () => {
    expect(tool('ringcentral_list_call_log').endpointMapping).toMatchObject({
      method: 'GET',
      path: `${ME}/call-log`,
      queryParams: { dateFrom: '$date_from', dateTo: '$date_to', direction: '$direction', type: '$type', phoneNumber: '$phone_number', view: '$view', recordingType: '$recording_type' },
    });
    expect(tool('ringcentral_list_company_call_log').endpointMapping).toMatchObject({ path: `${ACC}/call-log`, queryParams: { extensionNumber: '$extension_number' } });
    expect(tool('ringcentral_get_call_record').endpointMapping.path).toBe(`${ME}/call-log/{call_record_id}`);
    expect(tool('ringcentral_list_active_calls').endpointMapping.path).toBe(`${ME}/active-calls`);
    const ringout = tool('ringcentral_ringout_call');
    expect(ringout.endpointMapping).toEqual({
      method: 'POST',
      path: `${ME}/ring-out`,
      bodyMapping: { from: { phoneNumber: '$from_number' }, to: { phoneNumber: '$to_number' }, callerId: { phoneNumber: '$caller_id' }, playPrompt: '$play_prompt' },
    });
    expect(ringout.description).toMatch(/confirms/);
    expect(tool('ringcentral_get_ringout_status').endpointMapping).toEqual({ method: 'GET', path: `${ME}/ring-out/{ringout_id}` });
    expect(tool('ringcentral_cancel_ringout').endpointMapping).toEqual({ method: 'DELETE', path: `${ME}/ring-out/{ringout_id}` });
  });

  it('sends SMS with from and a to list of phoneNumber objects, and reads the message store', () => {
    const sms = tool('ringcentral_send_sms');
    expect(sms.endpointMapping).toEqual({ method: 'POST', path: `${ME}/sms`, bodyMapping: { from: { phoneNumber: '$from_number' }, to: [{ phoneNumber: '$to_number' }], text: '$text' } });
    expect(sms.parameters?.required).toEqual(['from_number', 'to_number', 'text']);
    expect(sms.enabled).toBeUndefined();
    expect(sms.description).toMatch(/10DLC/);
    expect(tool('ringcentral_list_messages').endpointMapping).toMatchObject({
      path: `${ME}/message-store`,
      queryParams: { messageType: '$message_type', readStatus: '$read_status', conversationId: '$conversation_id', distinctConversations: '$distinct_conversations' },
    });
    expect(tool('ringcentral_list_messages').parameters?.properties?.message_type.enum).toEqual(['SMS', 'VoiceMail', 'Fax', 'Pager', 'Text']);
    expect(tool('ringcentral_get_message').endpointMapping.path).toBe(`${ME}/message-store/{message_id}`);
    expect(tool('ringcentral_get_message_attachment').endpointMapping.path).toBe(`${ME}/message-store/{message_id}/content/{attachment_id}`);
    expect(tool('ringcentral_mark_message').endpointMapping).toEqual({ method: 'PUT', path: `${ME}/message-store/{message_id}`, bodyMapping: { readStatus: '$read_status' } });
  });

  it('maps contacts, presence and RingCentral Video', () => {
    expect(tool('ringcentral_list_contacts').endpointMapping).toMatchObject({ path: `${ME}/address-book/contact`, queryParams: { startsWith: '$starts_with', phoneNumber: '$phone_number' } });
    expect(tool('ringcentral_get_contact').endpointMapping.path).toBe(`${ME}/address-book/contact/{contact_id}`);
    expect(tool('ringcentral_create_contact').endpointMapping).toMatchObject({ method: 'POST', path: `${ME}/address-book/contact`, bodyMapping: { firstName: '$first_name', mobilePhone: '$mobile_phone' } });
    expect(tool('ringcentral_update_contact').endpointMapping).toMatchObject({ method: 'PATCH', path: `${ME}/address-book/contact/{contact_id}` });
    expect(tool('ringcentral_get_presence').endpointMapping.path).toBe(`${ACC}/extension/{extension_id}/presence`);
    expect(tool('ringcentral_list_presence').endpointMapping.path).toBe(`${ACC}/presence`);
    expect(tool('ringcentral_update_presence').endpointMapping).toEqual({ method: 'PUT', path: `${ME}/presence`, bodyMapping: { userStatus: '$user_status', dndStatus: '$dnd_status', message: '$message' } });
    expect(tool('ringcentral_list_video_meetings').endpointMapping).toMatchObject({ path: '/rcvideo/v1/history/meetings', queryParams: { pageToken: '$page_token', startTime: '$start_time' } });
    expect(tool('ringcentral_get_video_meeting').endpointMapping.path).toBe('/rcvideo/v1/history/meetings/{meeting_id}');
    expect(tool('ringcentral_create_video_meeting').endpointMapping).toMatchObject({ method: 'POST', path: '/rcvideo/v2/account/~/extension/~/bridges' });
  });

  it('annotates every write and switches none off', () => {
    const writes = a.tools.filter((t) => t.endpointMapping.method !== 'GET' && t.annotations?.readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual([
      'ringcentral_cancel_ringout',
      'ringcentral_create_contact',
      'ringcentral_create_video_meeting',
      'ringcentral_mark_message',
      'ringcentral_ringout_call',
      'ringcentral_send_sms',
      'ringcentral_update_contact',
      'ringcentral_update_presence',
    ]);
    for (const n of writes) expect(tool(n).annotations?.readOnlyHint).toBe(false);
    expect(tool('ringcentral_cancel_ringout').annotations?.destructiveHint).toBe(true);
    expect(a.tools.filter((t) => t.enabled === false)).toEqual([]);
  });

  it('drops navigation links and record uris from lists', () => {
    const out = applyResponseTransform(
      { uri: 'u', records: [{ uri: 'r', id: '1', direction: 'Inbound' }], paging: { page: 1 }, navigation: { nextPage: { uri: 'n' } } },
      tool('ringcentral_list_call_log').responseMapping as never,
    ).value;
    expect(out).toEqual({ uri: 'u', records: [{ id: '1', direction: 'Inbound' }], paging: { page: 1 } });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('ringcentral_')).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('probes with a read tool, explains the retired sandbox and documents every tool', () => {
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).toMatch(/platform\.devtest\.ringcentral\.com/);
    expect(a.instructions).toMatch(/7 days/);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

// Live reads need an access token of a signed-in user (for example from the Developer Console's API Explorer).
const live = process.env.RUN_RINGCENTRAL_LIVE === '1' && process.env.RINGCENTRAL_ACCESS_TOKEN ? describe : describe.skip;
live('ringcentral adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Bearer ${process.env.RINGCENTRAL_ACCESS_TOKEN}`, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads the extension, account, numbers, call log, messages, contacts and presence', async () => {
    expect(await get(ME)).toHaveProperty('extensionNumber');
    expect(await get(ACC)).toHaveProperty('mainNumber');
    expect(await get(`${ME}/phone-number`)).toHaveProperty('records');
    expect(await get(`${ME}/call-log?perPage=2`)).toHaveProperty('records');
    expect(await get(`${ME}/message-store?perPage=2`)).toHaveProperty('records');
    expect(await get(`${ME}/address-book/contact?perPage=2`)).toHaveProperty('records');
    expect(await get(`${ME}/presence`)).toHaveProperty('presenceStatus');
  }, 60_000);
});
