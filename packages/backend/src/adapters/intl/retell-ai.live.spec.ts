import * as adapter from './retell-ai.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Retell AI API (docs.retellai.com/api-references, OpenAPI at docs.retellai.com/openapi.yaml,
 * spec revision 2026-10-30, checked on 30 Oct 2026): base https://api.retellai.com, the API key
 * as a Bearer token. Several list endpoints are POST with a filter body (v2/list-agents, v3/list-calls,
 * v3/list-chats, list-contacts); lists page with pagination_key while has_more is true.
 * Live part (reads only: concurrency, key info, agents, LLMs, numbers, voices, knowledge bases, calls):
 *   RETELL_API_KEY=... RUN_RETELL_AI_LIVE=1 npx jest src/adapters/intl/retell-ai
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
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown> };
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
const PAGE = { limit: '$limit', sort_order: '$sort_order', pagination_key: '$pagination_key' };

describe('retell-ai adapter: static spec conformance', () => {
  it('sends the API key as a Bearer token to api.retellai.com', () => {
    expect(a.requiredEnvVars).toEqual(['RETELL_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.retellai.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{RETELL_API_KEY}}' });
    expect(a.envVarMeta?.RETELL_API_KEY.secret).toBe(true);
    const re = new RegExp(a.envVarMeta?.RETELL_API_KEY.pattern ?? '');
    expect(re.test('key_1a2b3c4d5e6f7a8b9c0d')).toBe(true);
    expect(re.test('Bearer key_1a2b3c4d5e6f7a8b9c0d')).toBe(false);
  });

  it('maps agents, versions, response engines and flows to the documented paths', () => {
    expect(tool('retell_ai_list_agents').endpointMapping).toEqual({ method: 'POST', path: '/v2/list-agents', queryParams: PAGE });
    expect(tool('retell_ai_get_agent').endpointMapping).toEqual({ method: 'GET', path: '/get-agent/{agent_id}', queryParams: { version: '$version' } });
    expect(tool('retell_ai_list_agent_versions').endpointMapping.path).toBe('/list-agent-versions/{agent_id}');
    expect(tool('retell_ai_update_agent').endpointMapping).toMatchObject({ method: 'PATCH', path: '/update-agent/{agent_id}', bodyMapping: { voice_id: '$voice_id', response_engine: '$response_engine' } });
    expect(tool('retell_ai_publish_agent_version').endpointMapping).toEqual({
      method: 'POST',
      path: '/publish-agent-version/{agent_id}',
      bodyMapping: { version: '$version', version_title: '$version_title', version_description: '$version_description' },
    });
    expect(tool('retell_ai_list_retell_llms').endpointMapping).toEqual({ method: 'GET', path: '/v2/list-retell-llms', queryParams: PAGE });
    expect(tool('retell_ai_get_retell_llm').endpointMapping.path).toBe('/get-retell-llm/{llm_id}');
    expect(tool('retell_ai_update_retell_llm').endpointMapping).toMatchObject({ method: 'PATCH', path: '/update-retell-llm/{llm_id}', bodyMapping: { general_prompt: '$general_prompt', begin_message: '$begin_message' } });
    expect(tool('retell_ai_list_conversation_flows').endpointMapping.path).toBe('/v2/list-conversation-flows');
    expect(tool('retell_ai_get_conversation_flow').endpointMapping.path).toBe('/get-conversation-flow/{conversation_flow_id}');
  });

  it('maps calls: v3 list with filter body, v2 get, create and stop, batch calls switched off', () => {
    expect(tool('retell_ai_list_calls').endpointMapping).toEqual({
      method: 'POST',
      path: '/v3/list-calls',
      bodyMapping: { filter_criteria: '$filter_criteria', sort_order: '$sort_order', limit: '$limit', pagination_key: '$pagination_key', include_total: '$include_total' },
    });
    expect(tool('retell_ai_get_call').endpointMapping).toEqual({ method: 'GET', path: '/v2/get-call/{call_id}' });
    const create = tool('retell_ai_create_phone_call');
    expect(create.endpointMapping).toMatchObject({ method: 'POST', path: '/v2/create-phone-call', bodyMapping: { from_number: '$from_number', to_number: '$to_number', override_agent_id: '$override_agent_id', retell_llm_dynamic_variables: '$retell_llm_dynamic_variables' } });
    expect(create.parameters?.required).toEqual(['from_number', 'to_number']);
    expect(create.description).toMatch(/costs money/);
    expect(create.enabled).toBeUndefined();
    expect(tool('retell_ai_stop_call').endpointMapping).toEqual({ method: 'POST', path: '/v2/stop-call/{call_id}' });
    expect(tool('retell_ai_stop_call').annotations?.destructiveHint).toBe(true);
    const batch = tool('retell_ai_create_batch_call');
    expect(batch.endpointMapping).toMatchObject({ method: 'POST', path: '/create-batch-call', bodyMapping: { from_number: '$from_number', tasks: '$tasks' } });
    expect(batch.enabled).toBe(false);
  });

  it('maps numbers, voices, knowledge bases, chats, contacts and account reads', () => {
    expect(tool('retell_ai_list_phone_numbers').endpointMapping).toEqual({ method: 'GET', path: '/v2/list-phone-numbers', queryParams: PAGE });
    expect(tool('retell_ai_get_phone_number').endpointMapping.path).toBe('/get-phone-number/{phone_number}');
    expect(tool('retell_ai_update_phone_number').endpointMapping).toMatchObject({ method: 'PATCH', path: '/update-phone-number/{phone_number}', bodyMapping: { inbound_agents: '$inbound_agents', outbound_agents: '$outbound_agents' } });
    expect(tool('retell_ai_list_voices').endpointMapping).toEqual({ method: 'GET', path: '/list-voices' });
    expect(tool('retell_ai_get_voice').endpointMapping.path).toBe('/get-voice/{voice_id}');
    expect(tool('retell_ai_list_knowledge_bases').endpointMapping.path).toBe('/list-knowledge-bases');
    expect(tool('retell_ai_get_knowledge_base').endpointMapping.path).toBe('/get-knowledge-base/{knowledge_base_id}');
    expect(tool('retell_ai_list_chats').endpointMapping).toMatchObject({ method: 'POST', path: '/v3/list-chats' });
    expect(tool('retell_ai_get_chat').endpointMapping.path).toBe('/get-chat/{chat_id}');
    expect(tool('retell_ai_create_sms_chat').endpointMapping).toMatchObject({ method: 'POST', path: '/create-sms-chat', bodyMapping: { from_number: '$from_number', to_number: '$to_number' } });
    expect(tool('retell_ai_list_contacts').endpointMapping).toMatchObject({ method: 'POST', path: '/list-contacts', bodyMapping: { search_query: '$search_query' } });
    expect(tool('retell_ai_get_contact_by_phone').endpointMapping.path).toBe('/get-contact-by-phone/{phone_number}');
    expect(tool('retell_ai_get_concurrency').endpointMapping).toEqual({ method: 'GET', path: '/get-concurrency' });
    expect(tool('retell_ai_get_api_key_info').endpointMapping).toEqual({ method: 'GET', path: '/get-api-key-info' });
  });

  it('marks the POST lists read-only and annotates every write', () => {
    for (const n of ['retell_ai_list_agents', 'retell_ai_list_calls', 'retell_ai_list_chats', 'retell_ai_list_contacts']) {
      expect(tool(n).annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    }
    const writes = a.tools.filter((t) => t.endpointMapping.method !== 'GET' && t.annotations?.readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual([
      'retell_ai_create_batch_call',
      'retell_ai_create_phone_call',
      'retell_ai_create_sms_chat',
      'retell_ai_publish_agent_version',
      'retell_ai_stop_call',
      'retell_ai_update_agent',
      'retell_ai_update_phone_number',
      'retell_ai_update_retell_llm',
    ]);
    for (const n of writes) expect(tool(n).annotations?.readOnlyHint).toBe(false);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['retell_ai_create_batch_call']);
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
  });

  it('drops word timestamps, scrubbed copies and the access token from a call', () => {
    const call = applyResponseTransform(
      {
        call_id: 'c1',
        access_token: 'secret',
        transcript: 'Agent: Hi',
        transcript_object: [{ role: 'agent', words: [{ word: 'Hi' }] }],
        transcript_with_tool_calls: [{ role: 'agent', content: 'Hi', words: [{ word: 'Hi' }] }],
        scrubbed_transcript_with_tool_calls: [{ role: 'agent' }],
        call_cost: { combined_cost: 12 },
      },
      tool('retell_ai_get_call').responseMapping as never,
    ).value;
    expect(call).toEqual({ call_id: 'c1', transcript: 'Agent: Hi', transcript_with_tool_calls: [{ role: 'agent', content: 'Hi' }], call_cost: { combined_cost: 12 } });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('retell_ai_')).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).toMatch(/cents/);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_RETELL_AI_LIVE === '1' && process.env.RETELL_API_KEY ? describe : describe.skip;
live('retell-ai adapter: live (read-only)', () => {
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${process.env.RETELL_API_KEY}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads concurrency, key info, agents, LLMs, numbers, voices, knowledge bases and calls', async () => {
    expect(await call('GET', '/get-concurrency')).toHaveProperty('concurrency_limit');
    expect(await call('GET', '/get-api-key-info')).toHaveProperty('org_id');
    expect(await call('POST', '/v2/list-agents?limit=2', {})).toHaveProperty('has_more');
    expect(await call('GET', '/v2/list-retell-llms?limit=2')).toHaveProperty('has_more');
    expect(await call('GET', '/v2/list-phone-numbers?limit=2')).toHaveProperty('has_more');
    expect(Array.isArray(await call('GET', '/list-voices'))).toBe(true);
    expect(Array.isArray(await call('GET', '/list-knowledge-bases'))).toBe(true);
    const calls = (await call('POST', '/v3/list-calls', { limit: 2 })) as { items: Array<{ call_id: string }> };
    if (calls.items[0]) expect(await call('GET', `/v2/get-call/${calls.items[0].call_id}`)).toHaveProperty('call_id');
  }, 60_000);
});
