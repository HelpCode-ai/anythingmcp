import * as adapter from './fish-audio.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Fish Audio developer API (docs.fish.audio/api-reference, OpenAPI at api.fish.audio/openapi.json):
 * base https://api.fish.audio, Bearer key, the TTS and ASR model chosen by a `model` header,
 * /v1/tts returns raw audio, /v1/asr and /model take multipart/form-data.
 * Live part (reads only). The public voice library needs no key; the credit read does:
 *   RUN_FISH_AUDIO_LIVE=1 [FISH_AUDIO_API_KEY=...] npx jest src/adapters/intl/fish-audio
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; format?: string; type?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyEncoding?: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  responseMapping?: { binary?: unknown; transform?: unknown };
};
const a = adapter as unknown as {
  requiredEnvVars: string[];
  envVarMeta: Record<string, { secret?: boolean }>;
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
const READS = ['fish_audio_get_api_credit', 'fish_audio_get_package', 'fish_audio_list_voices', 'fish_audio_get_voice'];

describe('fish-audio adapter: static spec conformance', () => {
  it('authenticates with the API key as a Bearer token on api.fish.audio', () => {
    expect(a.requiredEnvVars).toEqual(['FISH_AUDIO_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.fish.audio');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{FISH_AUDIO_API_KEY}}' });
    expect(a.envVarMeta.FISH_AUDIO_API_KEY.secret).toBe(true);
  });

  it('maps the wallet and voice model endpoints', () => {
    expect(tool('fish_audio_get_api_credit').endpointMapping).toEqual({ method: 'GET', path: '/wallet/self/api-credit' });
    expect(tool('fish_audio_get_package').endpointMapping).toEqual({ method: 'GET', path: '/wallet/self/package' });
    expect(tool('fish_audio_list_voices').endpointMapping).toEqual({
      method: 'GET',
      path: '/model',
      queryParams: { title: '$title', tag: '$tag', language: '$language', self: '$self', visibility: '$visibility', author_id: '$author_id', licensed: '$licensed', sort_by: '$sort_by', page_size: '$page_size', page_number: '$page_number' },
    });
    expect(tool('fish_audio_list_voices').parameters?.properties?.sort_by.enum).toEqual(['score', 'task_count', 'created_at']);
    expect(tool('fish_audio_get_voice').endpointMapping).toEqual({ method: 'GET', path: '/model/{id}' });
    expect(tool('fish_audio_create_voice').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/model',
      bodyEncoding: 'form-data',
      bodyMapping: { type: 'tts', train_mode: 'fast', title: '$title', voices: { __file: '$voice_url' }, texts: '$text' },
    });
    expect(tool('fish_audio_update_voice').endpointMapping).toMatchObject({ method: 'PATCH', path: '/model/{id}', bodyEncoding: 'form-data' });
    expect(tool('fish_audio_delete_voice').endpointMapping).toEqual({ method: 'DELETE', path: '/model/{id}' });
    expect(tool('fish_audio_delete_voice').annotations?.destructiveHint).toBe(true);
  });

  it('sends TTS as JSON with the model header and returns the audio bytes as a file', () => {
    const t = tool('fish_audio_text_to_speech');
    expect(t.endpointMapping).toMatchObject({ method: 'POST', path: '/v1/tts', headers: { model: '$model', Accept: '*/*' } });
    expect(t.endpointMapping.bodyEncoding).toBeUndefined();
    expect(t.endpointMapping.bodyMapping).toMatchObject({ text: '$text', reference_id: '$reference_id', format: '$format', prosody: { speed: '$speed', volume: '$volume' } });
    expect(t.parameters?.properties?.model.enum).toEqual(['s2.1-pro', 's2.1-pro-free', 's2-pro', 'drama-3', 's1']);
    expect(t.responseMapping?.binary).toBeDefined();
  });

  it('uploads the ASR audio from a URL as multipart with the model header', () => {
    const t = tool('fish_audio_transcribe');
    expect(t.endpointMapping).toMatchObject({ method: 'POST', path: '/v1/asr', bodyEncoding: 'form-data', headers: { model: '$model' } });
    expect(t.endpointMapping.bodyMapping?.audio).toEqual({ __file: '$audio_url' });
    expect(t.parameters?.properties?.audio_url.format).toBe('uri');
    expect(t.parameters?.properties?.model.enum).toEqual(['transcribe-1-pro', 'transcribe-1']);
  });

  it('keeps ids, tags, languages and a sample link per voice', () => {
    const out = applyResponseTransform(
      { total: 1000, has_more: true, items: [{ _id: 'v1', title: 'Narrator', tags: ['male'], languages: ['en'], samples: [{ text: 'Hi', audio: 'https://x/1.mp3' }], author: { nickname: 'A', avatar: 'x' }, cover_image: 'c', liked: false }] },
      tool('fish_audio_list_voices').responseMapping as never,
    ).value;
    expect(out).toEqual({ total: 1000, has_more: true, items: [{ id: 'v1', title: 'Narrator', tags: ['male'], languages: ['en'], author: 'A', sample_text: 'Hi', sample_audio: 'https://x/1.mp3' }] });
  });

  it('marks paid tools as writes that state their price', () => {
    for (const n of ['fish_audio_text_to_speech', 'fish_audio_transcribe']) {
      expect(tool(n).annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
      expect(tool(n).description).toMatch(/COSTS MONEY/);
    }
    for (const n of READS) {
      expect(tool(n).endpointMapping.method).toBe('GET');
      expect(tool(n).description).toMatch(/Free\.$/);
    }
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('fish_audio_')).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
      // Form arrays would go out as name[0]=...; Fish Audio expects repeated fields, so none are mapped.
      if (t.endpointMapping.bodyEncoding === 'form-data') for (const p of props) expect(`${t.name}:${p}:${t.parameters?.properties?.[p].type}`).not.toBe(`${t.name}:${p}:array`);
    }
  });

  it('probes with a free read and documents every tool in the instructions', () => {
    expect(READS).toContain(a.probe.tool);
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_FISH_AUDIO_LIVE === '1' ? describe : describe.skip;
live('fish-audio adapter: live (read-only)', () => {
  const key = process.env.FISH_AUDIO_API_KEY;
  const get = async (path: string, auth = false) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Accept: 'application/json', ...(auth ? { Authorization: `Bearer ${key}` } : {}) } });
    expect(`${res.status} ${path}`).toBe(`200 ${path}`);
    return res.json();
  };
  it('searches the public voice library and reads one voice', async () => {
    const list = applyResponseTransform(await get('/model?language=en&tag=male&sort_by=task_count&page_size=3'), tool('fish_audio_list_voices').responseMapping as never).value as {
      items: Array<{ id: string; languages: string[] }>;
    };
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items[0].id).toMatch(/^[0-9a-f]{32}$/);
    const voice = (await get(`/model/${list.items[0].id}`)) as { _id: string; state: string };
    expect(voice._id).toBe(list.items[0].id);
  }, 30_000);
  (key ? it : it.skip)('reads the API credit', async () => {
    expect(typeof ((await get('/wallet/self/api-credit', true)) as { credit: string }).credit).toBe('string');
  }, 30_000);
});
