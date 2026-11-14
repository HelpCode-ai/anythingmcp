import * as adapter from './vapi.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Vapi API (docs.vapi.ai/api-reference, OpenAPI at api.vapi.ai/api-json, checked on 30 Oct 2026):
 * base https://api.vapi.ai, the private key as a Bearer token. Lists of assistants, calls, squads,
 * tools and files are plain arrays paged with createdAtLt; /v2 lists return results + metadata.
 * Live part (reads only: assistants, phone numbers, calls, tools, files):
 *   VAPI_API_KEY=... RUN_VAPI_LIVE=1 npx jest src/adapters/intl/vapi
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: unknown;
    bodyEncoding?: string;
    headers?: Record<string, unknown>;
  };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
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
const DATES = { createdAtGt: '$created_at_gt', createdAtLt: '$created_at_lt', updatedAtGt: '$updated_at_gt', updatedAtLt: '$updated_at_lt' };

describe('vapi adapter: static spec conformance', () => {
  it('sends the private key as a Bearer token to api.vapi.ai', () => {
    expect(a.requiredEnvVars).toEqual(['VAPI_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.vapi.ai');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{VAPI_API_KEY}}' });
    expect(a.envVarMeta?.VAPI_API_KEY.secret).toBe(true);
    expect(new RegExp(a.envVarMeta?.VAPI_API_KEY.pattern ?? '').test('1a2b3c4d-1234-5678-9abc-0123456789ab')).toBe(true);
    expect(new RegExp(a.envVarMeta?.VAPI_API_KEY.pattern ?? '').test('Bearer 1a2b3c4d-1234-5678-9abc-0123456789ab')).toBe(false);
    // A connector-wide JSON Content-Type would break the multipart file upload.
    expect(a.connector.headers?.['Content-Type']).toBeUndefined();
  });

  it('maps assistants, squads and calls to the documented paths and filters', () => {
    expect(tool('vapi_list_assistants').endpointMapping).toEqual({ method: 'GET', path: '/assistant', queryParams: { limit: '$limit', ...DATES } });
    expect(tool('vapi_get_assistant').endpointMapping).toEqual({ method: 'GET', path: '/assistant/{assistant_id}' });
    expect(tool('vapi_create_assistant').endpointMapping).toMatchObject({ method: 'POST', path: '/assistant', bodyMapping: { firstMessage: '$first_message', model: '$model', voice: '$voice', transcriber: '$transcriber' } });
    expect(tool('vapi_update_assistant').endpointMapping).toMatchObject({ method: 'PATCH', path: '/assistant/{assistant_id}' });
    expect(tool('vapi_list_squads').endpointMapping.path).toBe('/squad');
    expect(tool('vapi_get_squad').endpointMapping.path).toBe('/squad/{squad_id}');
    expect(tool('vapi_list_calls').endpointMapping).toEqual({
      method: 'GET',
      path: '/call',
      queryParams: { id: '$call_id', assistantId: '$assistant_id', phoneNumberId: '$phone_number_id', limit: '$limit', ...DATES },
    });
    expect(tool('vapi_get_call').endpointMapping.path).toBe('/call/{call_id}');
    expect(tool('vapi_get_call_logs').endpointMapping.path).toBe('/call/{call_id}/call-logs');
  });

  it('creates an outbound call with phoneNumberId, a customer object and optional schedulePlan', () => {
    const t = tool('vapi_create_call');
    expect(t.endpointMapping).toEqual({
      method: 'POST',
      path: '/call',
      bodyMapping: {
        name: '$name',
        assistantId: '$assistant_id',
        squadId: '$squad_id',
        assistantOverrides: '$assistant_overrides',
        phoneNumberId: '$phone_number_id',
        customer: { number: '$customer_number', name: '$customer_name', extension: '$customer_extension' },
        schedulePlan: '$schedule_plan',
      },
    });
    expect(t.parameters?.required).toEqual(['phone_number_id', 'customer_number']);
    expect(t.description).toMatch(/costs money/);
    expect(t.description).toMatch(/confirms/);
    expect(t.enabled).toBeUndefined();
  });

  it('maps numbers, tools, files, knowledge bases, chats, campaigns and analytics', () => {
    expect(tool('vapi_list_phone_numbers').endpointMapping).toMatchObject({ path: '/v2/phone-number', queryParams: { search: '$search', page: '$page' } });
    expect(tool('vapi_get_phone_number').endpointMapping.path).toBe('/phone-number/{phone_number_id}');
    expect(tool('vapi_update_phone_number').endpointMapping).toMatchObject({ method: 'PATCH', bodyMapping: { assistantId: '$assistant_id', squadId: '$squad_id', fallbackDestination: '$fallback_destination' } });
    expect(tool('vapi_list_tools').endpointMapping.path).toBe('/tool');
    expect(tool('vapi_get_tool').endpointMapping.path).toBe('/tool/{tool_id}');
    expect(tool('vapi_list_files').endpointMapping).toEqual({ method: 'GET', path: '/file', queryParams: { purpose: '$purpose' } });
    expect(tool('vapi_upload_file').endpointMapping).toEqual({ method: 'POST', path: '/file', bodyEncoding: 'form-data', bodyMapping: { file: { __file: '$file_url' }, purpose: '$purpose' } });
    expect(tool('vapi_list_knowledge_bases').endpointMapping.path).toBe('/v2/knowledge-base');
    expect(tool('vapi_get_knowledge_base').endpointMapping.path).toBe('/v2/knowledge-base/{knowledge_base_id}');
    expect(tool('vapi_list_chats').endpointMapping).toMatchObject({ path: '/chat', queryParams: { assistantId: '$assistant_id', sessionId: '$session_id' } });
    expect(tool('vapi_create_chat').endpointMapping).toMatchObject({ method: 'POST', path: '/chat', bodyMapping: { input: '$input', previousChatId: '$previous_chat_id' } });
    expect(tool('vapi_list_campaigns').endpointMapping).toMatchObject({ path: '/campaign', queryParams: { status: '$status' } });
    expect(tool('vapi_get_campaign').endpointMapping.path).toBe('/campaign/{campaign_id}');
    expect(tool('vapi_query_analytics').endpointMapping).toEqual({ method: 'POST', path: '/analytics', bodyMapping: { queries: '$queries' } });
    expect(tool('vapi_query_analytics').annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it('keeps call lists lean and drops duplicated messages from a single call', () => {
    const calls = applyResponseTransform(
      [{ id: 'c1', status: 'ended', cost: 0.42, analysis: { summary: 's' }, messages: [1], artifact: { transcript: 't' }, assistant: { model: {} }, costs: [1] }],
      tool('vapi_list_calls').responseMapping as never,
    ).value;
    expect(calls).toEqual([{ id: 'c1', status: 'ended', cost: 0.42, analysis: { summary: 's' } }]);
    const call = applyResponseTransform(
      { id: 'c1', messages: [1], artifact: { transcript: 't', recordingUrl: 'r', messages: [2], messagesOpenAIFormatted: [3], performanceMetrics: {} } },
      tool('vapi_get_call').responseMapping as never,
    ).value;
    expect(call).toEqual({ id: 'c1', artifact: { transcript: 't', recordingUrl: 'r', messages: [2] } });
    const assistants = applyResponseTransform(
      [{ id: 'a1', name: 'Ava', model: { provider: 'openai', model: 'gpt-4o', messages: [{ role: 'system', content: 'long' }] }, analysisPlan: {} }],
      tool('vapi_list_assistants').responseMapping as never,
    ).value;
    expect(assistants).toEqual([{ id: 'a1', name: 'Ava', model: { provider: 'openai', model: 'gpt-4o' } }]);
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('vapi_')).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('annotates every write and switches none off', () => {
    const writes = a.tools.filter((t) => t.endpointMapping.method !== 'GET' && t.annotations?.readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(['vapi_create_assistant', 'vapi_create_call', 'vapi_create_chat', 'vapi_update_assistant', 'vapi_update_phone_number', 'vapi_upload_file']);
    for (const n of writes) expect(tool(n).annotations?.readOnlyHint).toBe(false);
    expect(a.tools.filter((t) => t.enabled === false)).toEqual([]);
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).toMatch(/costs? money|Calls cost money/);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_VAPI_LIVE === '1' && process.env.VAPI_API_KEY ? describe : describe.skip;
live('vapi adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as unknown;
  };
  it('reads assistants, phone numbers, calls, tools and files', async () => {
    expect(Array.isArray(await get('/assistant?limit=2'))).toBe(true);
    expect(await get('/v2/phone-number?limit=2')).toHaveProperty('results');
    const calls = (await get('/call?limit=2')) as Array<{ id: string }>;
    expect(Array.isArray(calls)).toBe(true);
    if (calls[0]) expect(await get(`/call/${calls[0].id}`)).toHaveProperty('id', calls[0].id);
    expect(Array.isArray(await get('/tool?limit=2'))).toBe(true);
    expect(Array.isArray(await get('/file'))).toBe(true);
  }, 60_000);
});
