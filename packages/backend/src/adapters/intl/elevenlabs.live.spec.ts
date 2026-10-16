import axios from 'axios';
import FormData from 'form-data';
import * as adapter from './elevenlabs.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { fetchOutbound } from '../../common/outbound-fetch.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the ElevenLabs adapter:
 *
 *   1. Static: always runs. Pins the xi-api-key header, every tool's method,
 *      URL, query and body through the real RestEngine, checked against the
 *      ElevenLabs OpenAPI document (api.elevenlabs.io/openapi.json) and the
 *      official Python SDK's generated clients, read 14 Oct 2026. Speech goes
 *      through the asynchronous generation endpoint, which answers with a
 *      download link instead of raw audio the engine cannot hand on.
 *      Transcription and dubbing are multipart forms. Also which tools only
 *      read, that every paid call asks for confirmation and states a cost,
 *      and that the delete ships switched off.
 *
 *   2. Live: skipped unless RUN_ELEVENLABS_LIVE=1. Without a key it checks
 *      that ElevenLabs refuses a wrong key with 401 on the real routes. With
 *      ELEVENLABS_API_KEY it reads models, voices, the Voice Library, the
 *      subscription, history, dubs, agents and conversations, shaped by each
 *      tool's response mapping as production does. Nothing that costs
 *      credits runs unless RUN_ELEVENLABS_LIVE_WRITES=1 is set too: then one
 *      short sentence is spoken (about 40 credits) and polled to its link.
 *
 *        RUN_ELEVENLABS_LIVE=1 ELEVENLABS_API_KEY=sk_... \
 *          npx jest src/adapters/intl/elevenlabs.live.spec.ts
 */

jest.mock('../../common/outbound-fetch.util', () => ({
  ...jest.requireActual('../../common/outbound-fetch.util'),
  fetchOutbound: jest.fn(),
}));
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };
const mockedFetchOutbound = fetchOutbound as jest.MockedFunction<typeof fetchOutbound>;

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyEncoding?: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const BASE = 'https://api.elevenlabs.io';
// Built at runtime so no literal looks like a real credential. Real keys are
// exactly 51 characters; ElevenLabs answers a malformed one with 400, and a
// well-formed but unknown one like this with 401.
const FAKE_KEY = 'sk_fake' + '0'.repeat(44);
const ENV: Record<string, string> = { ELEVENLABS_API_KEY: FAKE_KEY };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
// What the model receives: the raw answer shaped by the tool's response mapping.
const shaped = async (name: string, params: Record<string, unknown>, env = ENV) =>
  applyResponseTransform(await call(name, params, env), tool(name).responseMapping as any).value as any;
const sent = () => mockedAxios.mock.calls[0][0];
const formText = (form: FormData) => form.getBuffer().toString('utf8');
const formPart = (form: FormData, name: string) => {
  const m = new RegExp(`name="${name}"(?:; filename="[^"]*")?\\r\\n(?:[^\\r\\n]+\\r\\n)*\\r\\n([\\s\\S]*?)\\r\\n--`).exec(formText(form));
  return m ? m[1] : undefined;
};

const PAID = ['elevenlabs_create_dubbing', 'elevenlabs_create_speech', 'elevenlabs_transcribe'];
const WRITES = [...PAID, 'elevenlabs_add_library_voice', 'elevenlabs_delete_history_item'].sort();

describe('elevenlabs adapter: static spec conformance', () => {
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedFetchOutbound.mockReset();
  });

  it('is listed: checked against the vendor SDK and API spec on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('authenticates with the xi-api-key header on api.elevenlabs.io', () => {
    expect(a.category).toBe('publishing');
    expect(a.icon).toBe('elevenlabs');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'xi-api-key', apiKey: '{{ELEVENLABS_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/v1/models');
    expect(a.requiredEnvVars).toEqual(['ELEVENLABS_API_KEY']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.ELEVENLABS_API_KEY).toMatchObject({ kind: 'credential', secret: true, required: true });
    const key = new RegExp(a.envVarMeta.ELEVENLABS_API_KEY.pattern!);
    expect(key.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', 'Bearer ' + FAKE_KEY, 'sk_ 123', '0'.repeat(48), FAKE_KEY.slice(0, -1), FAKE_KEY + '0']) expect(key.test(bad)).toBe(false);
  });

  it('names the data residency hosts and probes with the model list', () => {
    for (const host of ['api.eu.residency.elevenlabs.io', 'api.in.residency.elevenlabs.io', 'api.sg.residency.elevenlabs.io']) {
      expect(a.instructions).toContain(`https://${host}`);
    }
    expect(a.probe).toEqual({ tool: 'elevenlabs_list_models' });
    for (const status of ['400', '401', '403', '429']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('prefixes every tool with elevenlabs_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^elevenlabs_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks only the documented writes as writes, states costs and ships the delete switched off', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of PAID) {
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(tool(name).description).toMatch(/COSTS (CREDITS|MONEY)/);
      expect(tool(name).description).toMatch(/\$0\.\d\d/);
      expect(tool(name).description).toMatch(/[Cc]onfirm/);
    }
    expect(tool('elevenlabs_add_library_voice').description).toMatch(/Confirm with the user/);
    expect(annotationsOf(tool('elevenlabs_delete_history_item'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['elevenlabs_delete_history_item']);
    expect(tool('elevenlabs_delete_history_item').description).toMatch(/switched off/);
    for (const t of a.tools) if (!writes.includes(t.name)) expect(t.description).toMatch(/Free\.$/);
  });

  it('only points the model at tools that exist, explains audio and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\belevenlabs_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\belevenlabs_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/\*\*Audio files\*\*/);
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('gives every tool that returns data a valid response mapping that does real work', () => {
    const passthrough = ['elevenlabs_get_speech', 'elevenlabs_add_library_voice', 'elevenlabs_create_speech', 'elevenlabs_create_dubbing', 'elevenlabs_delete_history_item'];
    for (const t of a.tools) {
      if (passthrough.includes(t.name)) continue;
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:true`);
      expect(validateTransform(tr)).toBeNull();
      // A transform with nothing but maxBytes is skipped at runtime.
      expect(tr.select ?? tr.exclude ?? tr.include ?? tr.expression).toBeDefined();
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['elevenlabs_list_voices', {}, 'GET', '/v2/voices'],
    ['elevenlabs_get_voice', { voice_id: 'v1' }, 'GET', '/v1/voices/v1'],
    ['elevenlabs_search_voice_library', {}, 'GET', '/v1/shared-voices'],
    ['elevenlabs_add_library_voice', { public_user_id: 'u1', voice_id: 'v1', new_name: 'Narrator' }, 'POST', '/v1/voices/add/u1/v1'],
    ['elevenlabs_list_models', {}, 'GET', '/v1/models'],
    ['elevenlabs_create_speech', { text: 'Hello', voice: 'v1' }, 'POST', '/v1/flows/text-to-speech'],
    ['elevenlabs_get_speech', { generation_id: 'g1' }, 'GET', '/v1/flows/text-to-speech/g1'],
    ['elevenlabs_list_speech_generations', {}, 'GET', '/v1/flows/text-to-speech'],
    ['elevenlabs_transcribe', { source_url: 'https://example.com/a.mp3' }, 'POST', '/v1/speech-to-text'],
    ['elevenlabs_get_transcript', { transcription_id: 't1' }, 'GET', '/v1/speech-to-text/transcripts/t1'],
    ['elevenlabs_list_history', {}, 'GET', '/v1/history'],
    ['elevenlabs_get_history_item', { history_item_id: 'h1' }, 'GET', '/v1/history/h1'],
    ['elevenlabs_delete_history_item', { history_item_id: 'h1' }, 'DELETE', '/v1/history/h1'],
    ['elevenlabs_get_subscription', {}, 'GET', '/v1/user/subscription'],
    ['elevenlabs_create_dubbing', { source_url: 'https://example.com/v.mp4', target_lang: 'de' }, 'POST', '/v1/dubbing'],
    ['elevenlabs_get_dubbing', { dubbing_id: 'd1' }, 'GET', '/v1/dubbing/d1'],
    ['elevenlabs_list_dubbings', {}, 'GET', '/v1/dubbing'],
    ['elevenlabs_get_dubbing_transcript', { dubbing_id: 'd1', language_code: 'de' }, 'GET', '/v1/dubbing/d1/transcripts/de/format/srt'],
    ['elevenlabs_list_agents', {}, 'GET', '/v1/convai/agents'],
    ['elevenlabs_get_agent', { agent_id: 'a1' }, 'GET', '/v1/convai/agents/a1'],
    ['elevenlabs_list_conversations', {}, 'GET', '/v1/convai/conversations'],
    ['elevenlabs_get_conversation', { conversation_id: 'c1' }, 'GET', '/v1/convai/conversations/c1'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the xi-api-key header', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${BASE}${path}`);
    expect(req.headers['xi-api-key']).toBe(FAKE_KEY);
    expect(req.headers.Authorization).toBeUndefined();
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('sends the documented list filters and page sizes', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('elevenlabs_list_voices', { search: 'calm', voice_type: 'personal', next_page_token: 'n1' });
    expect(sent().params).toEqual({ search: 'calm', voice_type: 'personal', page_size: 30, next_page_token: 'n1' });
    mockedAxios.mockClear();
    await call('elevenlabs_search_voice_library', { language: 'de', gender: 'female', use_cases: ['narrative_story'], page: 2 });
    expect(sent().params).toEqual({ language: 'de', gender: 'female', use_cases: ['narrative_story'], page_size: 20, page: 2 });
    // A list goes out as repeated keys, as FastAPI reads it.
    expect(sent().paramsSerializer(sent().params)).toContain('use_cases=narrative_story');
    mockedAxios.mockClear();
    await call('elevenlabs_list_history', { source: 'Flows', start_after_history_item_id: 'h9' });
    expect(sent().params).toEqual({ source: 'Flows', page_size: 30, start_after_history_item_id: 'h9' });
    mockedAxios.mockClear();
    await call('elevenlabs_list_conversations', { agent_id: 'a1', call_successful: 'failure', summary_mode: 'include', cursor: 'c' });
    expect(sent().params).toEqual({ agent_id: 'a1', call_successful: 'failure', summary_mode: 'include', cursor: 'c' });
    mockedAxios.mockClear();
    await call('elevenlabs_list_dubbings', { dubbing_status: 'dubbed' });
    expect(sent().params).toEqual({ dubbing_status: 'dubbed', page_size: 30 });
  });

  it('starts speech with the discriminated request body and no stray fields', async () => {
    mockedAxios.mockResolvedValue({ data: { id: 'g1', status: 'pending' } });
    await call('elevenlabs_create_speech', { text: 'Hello there', voice: 'JBFqnCBsd6RMkjVDRZzb' });
    // The endpoint rejects unknown fields (additionalProperties: false).
    expect(sent().data).toEqual({ model_id: 'eleven_multilingual_v2', text: 'Hello there', voice: 'JBFqnCBsd6RMkjVDRZzb' });
    mockedAxios.mockClear();
    await call('elevenlabs_create_speech', { text: 'Hallo', voice: 'v1', model_id: 'eleven_v3', language_code: 'de', output_format: 'mp3_44100_64', voice_settings: { stability: 0.5 } });
    expect(sent().data).toEqual({ model_id: 'eleven_v3', text: 'Hallo', voice: 'v1', language_code: 'de', output_format: 'mp3_44100_64', voice_settings: { stability: 0.5 } });
    expect(tool('elevenlabs_create_speech').parameters.properties!.model_id.enum).toEqual(['eleven_multilingual_v2', 'eleven_v3', 'eleven_flash_v2_5']);
  });

  it('saves a library voice with the documented body', async () => {
    mockedAxios.mockResolvedValue({ data: { voice_id: 'new' } });
    await call('elevenlabs_add_library_voice', { public_user_id: 'u1', voice_id: 'v1', new_name: 'Narrator' });
    expect(sent().data).toEqual({ new_name: 'Narrator' });
  });

  it('transcribes a link as a multipart form with scribe_v2 by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('elevenlabs_transcribe', { source_url: 'https://www.youtube.com/watch?v=x', diarize: true, num_speakers: 2 });
    const form = sent().data as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(String(sent().headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
    expect(formPart(form, 'model_id')).toBe('scribe_v2');
    expect(formPart(form, 'source_url')).toBe('https://www.youtube.com/watch?v=x');
    expect(formPart(form, 'diarize')).toBe('true');
    expect(formPart(form, 'num_speakers')).toBe('2');
    expect(formPart(form, 'file')).toBeUndefined();
    expect(mockedFetchOutbound).not.toHaveBeenCalled();
  });

  it('uploads a file_url as the file part when ElevenLabs cannot fetch the link itself', async () => {
    mockedFetchOutbound.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
      body: Buffer.from('ID3fake-mp3'),
      finalUrl: 'https://files.example.com/call.mp3',
    } as any);
    mockedAxios.mockResolvedValue({ data: {} });
    await call('elevenlabs_transcribe', { file_url: 'https://files.example.com/call.mp3' });
    expect(mockedFetchOutbound).toHaveBeenCalledWith('https://files.example.com/call.mp3', expect.anything());
    const text = formText(sent().data);
    expect(text).toMatch(/name="file"; filename="call\.mp3"\r\nContent-Type: audio\/mpeg/);
    expect(formPart(sent().data, 'source_url')).toBeUndefined();
  });

  it('starts a dub as a multipart form', async () => {
    mockedAxios.mockResolvedValue({ data: { dubbing_id: 'd1', expected_duration_sec: 120 } });
    await call('elevenlabs_create_dubbing', { source_url: 'https://example.com/v.mp4', target_lang: 'de', watermark: true, end_time: 60 });
    const form = sent().data as FormData;
    expect(formPart(form, 'source_url')).toBe('https://example.com/v.mp4');
    expect(formPart(form, 'target_lang')).toBe('de');
    expect(formPart(form, 'watermark')).toBe('true');
    expect(formPart(form, 'end_time')).toBe('60');
  });

  it('keeps transcripts small: no word list on transcribe, compact words on get', () => {
    const raw = {
      language_code: 'eng', language_probability: 0.98, text: 'Hi there.', audio_duration_secs: 1.2, transcription_id: 't1',
      words: [
        { text: 'Hi', start: 0.1, end: 0.3, type: 'word', speaker_id: 'speaker_0', logprob: -0.1, characters: [{ text: 'H' }] },
        { text: ' ', start: 0.3, end: 0.35, type: 'spacing', speaker_id: 'speaker_0', logprob: 0 },
        { text: 'there.', start: 0.35, end: 0.8, type: 'word', speaker_id: 'speaker_1', logprob: -0.2 },
      ],
    };
    expect(applyResponseTransform(raw, tool('elevenlabs_transcribe').responseMapping as any).value).toEqual({
      transcription_id: 't1', language_code: 'eng', language_probability: 0.98, audio_duration_secs: 1.2, text: 'Hi there.',
    });
    expect(applyResponseTransform(raw, tool('elevenlabs_get_transcript').responseMapping as any).value).toEqual({
      transcription_id: 't1', language_code: 'eng', audio_duration_secs: 1.2, text: 'Hi there.',
      words: [[0.1, 'speaker_0', 'Hi'], [0.35, 'speaker_1', 'there.']],
    });
  });

  it('reads a conversation as a compact transcript with its analysis', () => {
    const raw = {
      agent_id: 'a1', agent_name: 'Support', conversation_id: 'c1', status: 'done', has_audio: true,
      metadata: { start_time_unix_secs: 1, call_duration_secs: 42, termination_reason: 'end_call tool', main_language: 'en', cost: 300 },
      analysis: { call_successful: 'success', transcript_summary: 'Asked about opening hours.', call_summary_title: 'Opening hours', data_collection_results: {} },
      transcript: [
        { role: 'agent', message: 'Hello!', time_in_call_secs: 0, tool_calls: [], llm_usage: { model_usage: {} }, conversation_turn_metrics: { x: 1 } },
        { role: 'user', message: 'When do you open?', time_in_call_secs: 3, tool_calls: [{ tool_name: 'lookup_hours', params_as_json: '{}' }] },
      ],
    };
    const out = applyResponseTransform(raw, tool('elevenlabs_get_conversation').responseMapping as any).value as any;
    expect(out.call_duration_secs).toBe(42);
    expect(out.call_successful).toBe('success');
    expect(out.transcript).toEqual([
      { role: 'agent', message: 'Hello!', time_in_call_secs: 0, tool_calls: [] },
      { role: 'user', message: 'When do you open?', time_in_call_secs: 3, tool_calls: ['lookup_hours'] },
    ]);
    expect(JSON.stringify(out)).not.toContain('llm_usage');
  });

  it('flattens models and voices to what the model needs', () => {
    const models = [{ model_id: 'eleven_v3', name: 'Eleven v3', can_do_text_to_speech: true, token_cost_factor: 1, languages: [{ language_id: 'en', name: 'English' }], model_rates: { x: 1 } }];
    expect(applyResponseTransform(models, tool('elevenlabs_list_models').responseMapping as any).value).toEqual([
      expect.objectContaining({ model_id: 'eleven_v3', can_do_text_to_speech: true, languages: ['en'] }),
    ]);
    const voices = { voices: [{ voice_id: 'v1', name: 'Ada', category: 'premade', labels: { accent: 'british' }, samples: [{ a: 1 }], settings: {} }], has_more: false, total_count: 1, next_page_token: null };
    expect(applyResponseTransform(voices, tool('elevenlabs_list_voices').responseMapping as any).value).toEqual({
      voices: [{ voice_id: 'v1', name: 'Ada', category: 'premade', labels: { accent: 'british' } }], has_more: false, total_count: 1, next_page_token: null,
    });
  });
});

const live = process.env.RUN_ELEVENLABS_LIVE === '1' ? describe : describe.skip;
live('elevenlabs adapter: live', () => {
  const real = !!process.env.ELEVENLABS_API_KEY;
  const env = () => ({ ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY! });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['elevenlabs_list_models', {}],
    ['elevenlabs_list_voices', {}],
    ['elevenlabs_get_subscription', {}],
    ['elevenlabs_list_history', {}],
    ['elevenlabs_list_speech_generations', {}],
    ['elevenlabs_list_dubbings', {}],
    ['elevenlabs_list_agents', {}],
    ['elevenlabs_list_conversations', {}],
    ['elevenlabs_create_speech', { text: 'Hi', voice: 'JBFqnCBsd6RMkjVDRZzb' }],
    ['elevenlabs_transcribe', { source_url: 'https://example.com/a.mp3' }],
  ])('%s reaches ElevenLabs and is refused with a wrong key (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (real ? it : it.skip)('reads models, voices, the library, the plan, history, dubs, agents and conversations', async () => {
    const models = await shaped('elevenlabs_list_models', {}, env());
    expect(models.some((m: any) => m.model_id === 'eleven_multilingual_v2')).toBe(true);
    const voices = await shaped('elevenlabs_list_voices', { page_size: 5 }, env());
    expect(Array.isArray(voices.voices)).toBe(true);
    if (voices.voices[0]) {
      const voice = await shaped('elevenlabs_get_voice', { voice_id: voices.voices[0].voice_id }, env());
      expect(voice.voice_id).toBe(voices.voices[0].voice_id);
    }
    const library = await shaped('elevenlabs_search_voice_library', { page_size: 3 }, env());
    expect(Array.isArray(library.voices)).toBe(true);
    const plan = await shaped('elevenlabs_get_subscription', {}, env());
    expect(typeof plan.character_limit).toBe('number');
    const history = await shaped('elevenlabs_list_history', { page_size: 3 }, env());
    expect(Array.isArray(history.history)).toBe(true);
    const dubs = await shaped('elevenlabs_list_dubbings', { page_size: 3 }, env());
    expect(Array.isArray(dubs.dubs)).toBe(true);
    const agents = await shaped('elevenlabs_list_agents', { page_size: 3 }, env());
    expect(Array.isArray(agents.agents)).toBe(true);
    const conversations = await shaped('elevenlabs_list_conversations', { page_size: 3 }, env());
    expect(Array.isArray(conversations.conversations)).toBe(true);
    if (conversations.conversations[0]) {
      const one = await shaped('elevenlabs_get_conversation', { conversation_id: conversations.conversations[0].conversation_id }, env());
      expect(Array.isArray(one.transcript)).toBe(true);
    }
  }, 90000);

  const writes = real && process.env.RUN_ELEVENLABS_LIVE_WRITES === '1';
  (writes ? it : it.skip)('speaks one short sentence (about 40 credits) and returns a download link', async () => {
    const started = await shaped(
      'elevenlabs_create_speech',
      { text: 'This is a short AnythingMCP connector test.', voice: 'JBFqnCBsd6RMkjVDRZzb', model_id: 'eleven_flash_v2_5' },
      env(),
    );
    expect(started.id).toBeTruthy();
    let result: any = started;
    for (let i = 0; i < 20 && !['completed', 'failed'].includes(result.status); i++) {
      await new Promise((r) => setTimeout(r, 3000));
      result = await shaped('elevenlabs_get_speech', { generation_id: started.id }, env());
    }
    expect(result.status).toBe('completed');
    expect(result.content_url).toMatch(/^https:\/\//);
    expect(result.content_mime_type).toMatch(/^audio\//);
  }, 120000);
});
