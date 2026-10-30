import * as adapter from './deepgram.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Deepgram API (developers.deepgram.com/reference, OpenAPI at
 * github.com/deepgram/deepgram-api-specs openapi.yml): base
 * https://api.deepgram.com/v1, `Authorization: Token <key>`. Pre-recorded
 * transcription from a URL (POST /listen with a JSON {url} body and the
 * options as query parameters), text intelligence (POST /read), text to speech
 * (POST /speak, the audio comes back as a file) and the read side of the
 * management API (projects, models, keys, members, requests, usage, balances,
 * billing, purchases).
 * Live part (free management reads only, no transcription or speech):
 *   DEEPGRAM_API_KEY=... RUN_DEEPGRAM_LIVE=1 npx jest src/adapters/intl/deepgram
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; type?: string; maxLength?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: { transform?: unknown; binary?: { maxBytes?: number } };
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
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
const PREFIX = 'deepgram_';
const P = '/projects/{project_id}';

describe('deepgram adapter: static spec conformance', () => {
  it('authenticates with the key in an Authorization: Token header on api.deepgram.com/v1', () => {
    expect(a.slug).toBe('deepgram');
    expect(a.category).toBe('data');
    expect(a.requiredEnvVars).toEqual(['DEEPGRAM_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.deepgram.com/v1');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'Token {{DEEPGRAM_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/projects');
    expect(a.envVarMeta?.DEEPGRAM_API_KEY.secret).toBe(true);
    expect(new RegExp(a.envVarMeta!.DEEPGRAM_API_KEY.pattern!).test('0123456789abcdef0123456789abcdef01234567')).toBe(true);
    expect(new RegExp(a.envVarMeta!.DEEPGRAM_API_KEY.pattern!).test('Token 0123456789abcdef0123456789abcdef01234567')).toBe(false);
  });

  it('transcribes a URL: JSON {url} body, every option as a documented query parameter', () => {
    const m = tool('deepgram_transcribe_url').endpointMapping;
    expect(m.method).toBe('POST');
    expect(m.path).toBe('/listen');
    expect(m.bodyMapping).toEqual({ url: '$url' });
    for (const k of ['model', 'language', 'detect_language', 'smart_format', 'punctuate', 'diarize', 'utterances', 'utt_split', 'paragraphs', 'summarize', 'topics', 'intents', 'sentiment', 'keyterm', 'keywords', 'search', 'redact', 'tag']) {
      expect(m.queryParams?.[k]).toBe(`$${k}`);
    }
    expect(tool('deepgram_transcribe_url').parameters?.required).toEqual(['url']);
    expect(tool('deepgram_transcribe_url').parameters?.properties?.summarize.enum).toEqual(['v2']);
    expect(tool('deepgram_transcribe_url').parameters?.properties?.keyterm.type).toBe('array');
  });

  it('drops the per-word arrays from a transcription and keeps transcript, paragraphs, utterances and summary', () => {
    const word = { word: 'hi', start: 0, end: 0.2, confidence: 0.9, speaker: 0 };
    const raw = {
      metadata: { request_id: 'r1', duration: 3.2, transaction_key: 'deprecated' },
      results: {
        channels: [{ alternatives: [{ transcript: 'Hi there.', confidence: 0.98, words: [word], paragraphs: { transcript: '\nSpeaker 0: Hi there.', paragraphs: [{ sentences: [{ text: 'Hi there.', start: 0, end: 1 }], speaker: 0 }] } }] }],
        utterances: [{ start: 0, end: 1, transcript: 'Hi there.', speaker: 0, words: [word] }],
        summary: { result: 'success', short: 'A greeting.' },
      },
    };
    const out = applyResponseTransform(raw, tool('deepgram_transcribe_url').responseMapping as never).value;
    expect(out).toEqual({
      metadata: { request_id: 'r1', duration: 3.2 },
      results: {
        channels: [{ alternatives: [{ transcript: 'Hi there.', confidence: 0.98, paragraphs: { transcript: '\nSpeaker 0: Hi there.', paragraphs: [{ sentences: [{ text: 'Hi there.', start: 0, end: 1 }], speaker: 0 }] } }] }],
        utterances: [{ start: 0, end: 1, transcript: 'Hi there.', speaker: 0 }],
        summary: { result: 'success', short: 'A greeting.' },
      },
    });
  });

  it('maps text intelligence and text to speech; speech returns the audio file', () => {
    expect(tool('deepgram_analyze_text').endpointMapping).toEqual({
      method: 'POST',
      path: '/read',
      queryParams: { language: '$language', summarize: '$summarize', topics: '$topics', intents: '$intents', sentiment: '$sentiment', custom_topic: '$custom_topic', custom_intent: '$custom_intent' },
      bodyMapping: { text: '$text' },
    });
    const speak = tool('deepgram_text_to_speech');
    expect(speak.endpointMapping).toEqual({
      method: 'POST',
      path: '/speak',
      headers: { Accept: '*/*' },
      queryParams: { model: '$model', encoding: '$encoding', container: '$container', sample_rate: '$sample_rate', bit_rate: '$bit_rate', speed: '$speed' },
      bodyMapping: { text: '$text' },
    });
    expect(speak.parameters?.properties?.text.maxLength).toBe(2000);
    expect(speak.parameters?.properties?.encoding.enum).toEqual(['mp3', 'linear16', 'flac', 'opus', 'aac', 'mulaw', 'alaw']);
    expect(speak.responseMapping?.binary?.maxBytes).toBeLessThanOrEqual(10 * 1024 * 1024);
    // Compute calls change nothing at Deepgram: read-only, like a model call elsewhere in the catalog.
    for (const n of ['deepgram_transcribe_url', 'deepgram_analyze_text', 'deepgram_text_to_speech']) expect(tool(n).annotations).toEqual({ readOnlyHint: true });
  });

  it('maps the management reads to the documented paths and query names', () => {
    expect(tool('deepgram_list_projects').endpointMapping).toEqual({ method: 'GET', path: '/projects' });
    expect(tool('deepgram_get_project').endpointMapping.path).toBe(P);
    expect(tool('deepgram_list_models').endpointMapping).toEqual({ method: 'GET', path: '/models', queryParams: { include_outdated: '$include_outdated' } });
    expect(tool('deepgram_get_model').endpointMapping.path).toBe('/models/{model_id}');
    expect(tool('deepgram_list_project_models').endpointMapping.path).toBe(`${P}/models`);
    expect(tool('deepgram_list_keys').endpointMapping).toEqual({ method: 'GET', path: `${P}/keys`, queryParams: { status: '$status' } });
    expect(tool('deepgram_list_members').endpointMapping.path).toBe(`${P}/members`);
    expect(tool('deepgram_list_requests').endpointMapping).toMatchObject({
      path: `${P}/requests`,
      queryParams: { start: '$start', end: '$end', limit: '$limit', page: '$page', accessor: '$accessor', request_id: '$request_id', deployment: '$deployment', endpoint: '$endpoint', method: '$method', status: '$status' },
    });
    expect(tool('deepgram_get_request').endpointMapping.path).toBe(`${P}/requests/{request_id}`);
    expect(tool('deepgram_get_usage_breakdown').endpointMapping).toMatchObject({ path: `${P}/usage/breakdown`, queryParams: { start: '$start', end: '$end', grouping: '$grouping' } });
    expect(tool('deepgram_get_usage_breakdown').parameters?.properties?.grouping.enum).toEqual(['accessor', 'endpoint', 'feature_set', 'models', 'method', 'tags', 'deployment']);
    expect(tool('deepgram_list_usage_fields').endpointMapping.path).toBe(`${P}/usage/fields`);
    expect(tool('deepgram_list_balances').endpointMapping.path).toBe(`${P}/balances`);
    expect(tool('deepgram_get_balance').endpointMapping.path).toBe(`${P}/balances/{balance_id}`);
    expect(tool('deepgram_get_billing_breakdown').endpointMapping).toMatchObject({ path: `${P}/billing/breakdown`, queryParams: { grouping: '$grouping', line_item: '$line_item' } });
    expect(tool('deepgram_list_purchases').endpointMapping).toEqual({ method: 'GET', path: `${P}/purchases`, queryParams: { limit: '$limit' } });
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

  it('never manages keys, members or projects: only GET apart from the three compute calls', () => {
    const compute = new Set(['/listen', '/read', '/speak']);
    for (const t of a.tools) {
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      if (compute.has(t.endpointMapping.path)) expect(t.endpointMapping.method).toBe('POST');
      else expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe.tool).toBe('deepgram_list_projects');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_DEEPGRAM_LIVE === '1' && process.env.DEEPGRAM_API_KEY ? describe : describe.skip;
live('deepgram adapter: live (read-only, free)', () => {
  const get = async (path: string, allowForbidden = false) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, Accept: 'application/json' } });
    // Members, balances and billing need an Admin or Owner key.
    if (allowForbidden && res.status === 403) return undefined;
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads models, projects and the account side of the first project', async () => {
    const models = (await get('/models'))!;
    expect(Array.isArray(models.stt)).toBe(true);
    expect(Array.isArray(models.tts)).toBe(true);
    const projects = ((await get('/projects'))!.projects ?? []) as Array<{ project_id: string }>;
    expect(projects.length).toBeGreaterThan(0);
    const p = `/projects/${projects[0].project_id}`;
    expect((await get(p))!.project_id).toBe(projects[0].project_id);
    expect(Array.isArray((await get(`${p}/keys`))!.api_keys)).toBe(true);
    expect(Array.isArray((await get(`${p}/requests?limit=5`))!.requests)).toBe(true);
    expect((await get(`${p}/usage/breakdown`))!).toHaveProperty('results');
    await get(`${p}/usage/fields`);
    await get(`${p}/models`);
    await get(`${p}/members`, true);
    await get(`${p}/balances`, true);
  }, 60_000);
});
