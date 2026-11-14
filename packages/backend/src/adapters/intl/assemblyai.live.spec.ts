import * as adapter from './assemblyai.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * AssemblyAI (assemblyai.com/docs, OpenAPI at assemblyai.com/docs/openapi.yaml plus
 * api-reference/specs/llm-gateway.yaml and streaming-token.yaml): the raw API key in the
 * Authorization header, three hosts (api., llm-gateway., streaming.) under assemblyai.com
 * or eu.assemblyai.com. Live part (reads only; the LLM model list needs no key):
 *   RUN_ASSEMBLYAI_LIVE=1 [ASSEMBLYAI_API_KEY=... ASSEMBLYAI_DOMAIN=assemblyai.com] npx jest src/adapters/intl/assemblyai
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; format?: string; type?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
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
const LLM = 'https://llm-gateway.{{ASSEMBLYAI_DOMAIN}}/v1';
const T = '/v2/transcript/{transcript_id}';
const PAID = ['assemblyai_submit_transcript', 'assemblyai_understand_transcript', 'assemblyai_ask_transcript'];

describe('assemblyai adapter: static spec conformance', () => {
  it('sends the raw key in Authorization and picks the US or EU hosts from ASSEMBLYAI_DOMAIN', () => {
    expect(a.requiredEnvVars).toEqual(['ASSEMBLYAI_API_KEY', 'ASSEMBLYAI_DOMAIN']);
    expect(a.connector.baseUrl).toBe('https://api.{{ASSEMBLYAI_DOMAIN}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: '{{ASSEMBLYAI_API_KEY}}' });
    expect(a.envVarMeta.ASSEMBLYAI_API_KEY.secret).toBe(true);
    const region = new RegExp(a.envVarMeta.ASSEMBLYAI_DOMAIN.pattern ?? '');
    expect(['assemblyai.com', 'eu.assemblyai.com'].every((d) => region.test(d))).toBe(true);
    expect(['api.assemblyai.com', 'https://assemblyai.com', 'us.assemblyai.com'].some((d) => region.test(d))).toBe(false);
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^(\/v2\/|https:\/\/(llm-gateway|streaming)\.\{\{ASSEMBLYAI_DOMAIN\}\}\/v[13]\/)/);
  });

  it('maps the transcript endpoints', () => {
    expect(tool('assemblyai_list_transcripts').endpointMapping).toEqual({
      method: 'GET',
      path: '/v2/transcript',
      queryParams: { limit: '$limit', status: '$status', created_on: '$created_on', before_id: '$before_id', after_id: '$after_id', throttled_only: '$throttled_only' },
    });
    expect(tool('assemblyai_get_transcript').endpointMapping).toEqual({ method: 'GET', path: T });
    expect(tool('assemblyai_get_sentences').endpointMapping.path).toBe(`${T}/sentences`);
    expect(tool('assemblyai_get_paragraphs').endpointMapping.path).toBe(`${T}/paragraphs`);
    expect(tool('assemblyai_get_subtitles').endpointMapping).toMatchObject({ path: `${T}/{subtitle_format}`, queryParams: { chars_per_caption: '$chars_per_caption' } });
    expect(tool('assemblyai_get_subtitles').parameters?.properties?.subtitle_format.enum).toEqual(['srt', 'vtt']);
    expect(tool('assemblyai_search_words').endpointMapping).toEqual({ method: 'GET', path: `${T}/word-search`, queryParams: { words: '$words' } });
    expect(tool('assemblyai_get_redacted_audio').endpointMapping.path).toBe(`${T}/redacted-audio`);
    expect(tool('assemblyai_delete_transcript').endpointMapping).toEqual({ method: 'DELETE', path: T });
    expect(tool('assemblyai_delete_transcript').annotations?.destructiveHint).toBe(true);
    const submit = tool('assemblyai_submit_transcript');
    expect(submit.endpointMapping).toMatchObject({ method: 'POST', path: '/v2/transcript' });
    expect(submit.parameters?.required).toEqual(['audio_url']);
    expect(submit.endpointMapping.bodyMapping).toMatchObject({ audio_url: '$audio_url', speech_models: '$speech_models', speaker_labels: '$speaker_labels', redact_pii_policies: '$redact_pii_policies', speech_understanding: '$speech_understanding' });
    expect(Object.keys(submit.endpointMapping.bodyMapping ?? {})).not.toContain('speech_model');
  });

  it('maps the LLM Gateway and the streaming token on their own hosts', () => {
    expect(tool('assemblyai_list_llm_models').endpointMapping).toEqual({ method: 'GET', path: `${LLM}/models` });
    expect(tool('assemblyai_ask_transcript').endpointMapping).toEqual({
      method: 'POST',
      path: `${LLM}/chat/completions`,
      bodyMapping: { model: '$model', prompt: '$prompt', transcript_id: '$transcript_id', max_tokens: '$max_tokens', temperature: '$temperature' },
    });
    expect(tool('assemblyai_understand_transcript').endpointMapping).toEqual({ method: 'POST', path: `${LLM}/understanding`, bodyMapping: { transcript_id: '$transcript_id', speech_understanding: '$speech_understanding' } });
    expect(tool('assemblyai_create_streaming_token').endpointMapping).toEqual({
      method: 'GET',
      path: 'https://streaming.{{ASSEMBLYAI_DOMAIN}}/v3/token',
      queryParams: { expires_in_seconds: '$expires_in_seconds', max_session_duration_seconds: '$max_session_duration_seconds' },
    });
  });

  it('drops word-level timestamps but keeps text, utterances and feature results', () => {
    const raw = {
      id: 't1',
      status: 'completed',
      text: 'Hello there.',
      words: [{ text: 'Hello', start: 0, end: 300 }],
      utterances: [{ speaker: 'A', text: 'Hello there.', start: 0, end: 900, words: [{ text: 'Hello' }] }],
      summary: '- greeting',
    };
    expect(applyResponseTransform(raw, tool('assemblyai_get_transcript').responseMapping as never).value).toEqual({
      id: 't1',
      status: 'completed',
      text: 'Hello there.',
      utterances: [{ speaker: 'A', text: 'Hello there.', start: 0, end: 900 }],
      summary: '- greeting',
    });
    expect(applyResponseTransform({ id: 't1', sentences: [{ text: 'Hi.', start: 0, end: 5, words: [{}] }] }, tool('assemblyai_get_sentences').responseMapping as never).value).toEqual({
      id: 't1',
      sentences: [{ text: 'Hi.', start: 0, end: 5 }],
    });
    expect(applyResponseTransform({ data: [{ id: 'm', name: 'M', context_length: 1, pricing: { us: {} }, available_regions: ['us'], performance: { big: 1 } }] }, tool('assemblyai_list_llm_models').responseMapping as never).value).toEqual({
      models: [{ id: 'm', name: 'M', context_length: 1, pricing: { us: {} }, available_regions: ['us'] }],
    });
  });

  it('marks paid tools as writes that state their price', () => {
    for (const n of PAID) {
      expect(tool(n).annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
      expect(tool(n).description).toMatch(/COSTS MONEY/);
    }
    for (const t of a.tools) if (t.endpointMapping.method === 'GET') expect(`${t.name}:${t.annotations}`).toBe(`${t.name}:undefined`);
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('assemblyai_')).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('probes with a read without required parameters and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_ASSEMBLYAI_LIVE === '1' ? describe : describe.skip;
live('assemblyai adapter: live (read-only)', () => {
  const key = process.env.ASSEMBLYAI_API_KEY;
  const domain = process.env.ASSEMBLYAI_DOMAIN ?? 'assemblyai.com';
  it('lists the LLM Gateway models in the US and EU regions (no key needed)', async () => {
    for (const d of ['assemblyai.com', 'eu.assemblyai.com']) {
      const res = await fetch(`https://llm-gateway.${d}/v1/models`);
      expect(res.status).toBe(200);
      const out = applyResponseTransform(await res.json(), tool('assemblyai_list_llm_models').responseMapping as never).value as { models: Array<{ id: string }> };
      expect(out.models.length).toBeGreaterThan(0);
    }
  }, 30_000);
  (key ? it : it.skip)('lists transcripts with the key', async () => {
    const res = await fetch(`https://api.${domain}/v2/transcript?limit=1`, { headers: { Authorization: String(key) } });
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as { transcripts: unknown[] }).transcripts)).toBe(true);
  }, 30_000);
});
