import axios from 'axios';
import * as adapter from './groq.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

/**
 * GroqCloud API (reference https://console.groq.com/docs/api-reference, the
 * Stainless-generated groq-python SDK for field names), checked on 30 Oct 2026:
 * base https://api.groq.com/openai/v1, `Authorization: Bearer gsk_...`.
 * Transcriptions and translations are multipart forms; Groq accepts a `url`
 * field and downloads the audio itself, so no file is fetched by the connector.
 *
 * Static part: always runs, through the real RestEngine with axios mocked.
 * Live part (free reads only: models, one model, batches, files):
 *   RUN_GROQ_LIVE=1 GROQ_API_KEY=gsk_... npx jest src/adapters/intl/groq
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
    AxiosHeaders: actual.AxiosHeaders,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { description?: string; default?: unknown; enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyEncoding?: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; headers?: Record<string, string>; exposeHeaders?: string[] };
  annotations?: Record<string, boolean>;
};
const a = adapter as unknown as {
  slug: string;
  icon: string;
  docsUrl: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath: string };
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
const annotationsOf = (t: Tool) => deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations } as never);

const BASE = 'https://api.groq.com/openai/v1';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['gsk', '_', 'Ab12'.repeat(13)].join('');
const ENV: Record<string, string> = { GROQ_API_KEY: FAKE_KEY };

const call = (name: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, tool(name).endpointMapping, ENV);
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, ENV), headers: config.headers } as never,
    endpointMapping as never,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  ) as Promise<unknown>;
};
const sent = () => mockedAxios.mock.calls[0][0];
const formText = (req: { data: { getBuffer: () => Buffer } }) => req.data.getBuffer().toString('utf8');

const PAID = ['groq_chat_completion', 'groq_transcribe_audio', 'groq_translate_audio'];

describe('groq adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the key as a Bearer token to api.groq.com/openai/v1 and checks it on /models', async () => {
    expect(a.requiredEnvVars).toEqual(['GROQ_API_KEY']);
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{GROQ_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/models');
    expect(a.envVarMeta.GROQ_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    const re = new RegExp(a.envVarMeta.GROQ_API_KEY.pattern!);
    expect(re.test(FAKE_KEY)).toBe(true);
    expect(re.test(`Bearer ${FAKE_KEY}`)).toBe(false);
    expect(re.test(`${FAKE_KEY} `)).toBe(false);
    mockedAxios.mockResolvedValue({ data: { data: [] }, status: 200, headers: {} });
    await call('groq_list_models', {});
    expect(sent().url).toBe(`${BASE}/models`);
    expect(sent().headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it('maps every tool to the documented method and path', () => {
    const table = Object.fromEntries(a.tools.map((t) => [t.name, `${t.endpointMapping.method} ${t.endpointMapping.path}`]));
    expect(table).toEqual({
      groq_list_models: 'GET /models',
      groq_get_model: 'GET /models/{model}',
      groq_chat_completion: 'POST /chat/completions',
      groq_transcribe_audio: 'POST /audio/transcriptions',
      groq_translate_audio: 'POST /audio/translations',
      groq_list_batches: 'GET /batches',
      groq_get_batch: 'GET /batches/{batch_id}',
      groq_list_files: 'GET /files',
      groq_get_file: 'GET /files/{file_id}',
    });
  });

  it('sends a non-streaming chat completion with only the fields the caller set, and exposes the rate-limit headers', async () => {
    mockedAxios.mockResolvedValue({ data: { choices: [] }, status: 200, headers: {} });
    const messages = [{ role: 'user', content: 'Hi' }];
    await call('groq_chat_completion', { model: 'openai/gpt-oss-20b', messages, max_completion_tokens: 64, reasoning_effort: 'low', response_format: { type: 'json_object' } });
    expect(sent().url).toBe(`${BASE}/chat/completions`);
    expect(sent().data).toEqual({ model: 'openai/gpt-oss-20b', messages, max_completion_tokens: 64, reasoning_effort: 'low', response_format: { type: 'json_object' }, stream: false });
    expect(tool('groq_chat_completion').endpointMapping.exposeHeaders).toEqual(['x-ratelimit-remaining-requests', 'x-ratelimit-remaining-tokens', 'retry-after']);
  });

  it('transcribes and translates audio as multipart forms with the url field, never fetching a file itself', async () => {
    for (const name of ['groq_transcribe_audio', 'groq_translate_audio']) {
      const m = tool(name).endpointMapping;
      expect(m.bodyEncoding).toBe('form-data');
      expect(JSON.stringify(m.bodyMapping)).not.toContain('__file');
    }
    mockedAxios.mockResolvedValue({ data: { text: 'hello' }, status: 200, headers: {} });
    await call('groq_transcribe_audio', { url: 'https://example.com/a.mp3', language: 'de', response_format: 'verbose_json', timestamp_granularities: 'word' });
    const body = formText(sent());
    expect(String(sent().headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
    expect(body).toMatch(/name="url"\r\n\r\nhttps:\/\/example\.com\/a\.mp3\r\n/);
    expect(body).toMatch(/name="model"\r\n\r\nwhisper-large-v3-turbo\r\n/);
    expect(body).toMatch(/name="language"\r\n\r\nde\r\n/);
    expect(body).toMatch(/name="response_format"\r\n\r\nverbose_json\r\n/);
    expect(body).toMatch(/name="timestamp_granularities\[\]"\r\n\r\nword\r\n/);
    expect(body).not.toContain('name="prompt"');
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { text: 'hello' }, status: 200, headers: {} });
    await call('groq_translate_audio', { url: 'https://example.com/b.ogg' });
    expect(sent().url).toBe(`${BASE}/audio/translations`);
    expect(formText(sent())).toMatch(/name="model"\r\n\r\nwhisper-large-v3\r\n/);
  });

  it('marks the model calls read-only like the OpenAI adapter and labels them as paid; everything else is a free GET', () => {
    for (const t of a.tools) {
      const ann = annotationsOf(t);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      expect(ann.readOnlyHint).toBe(true);
      if (PAID.includes(t.name)) {
        expect(t.endpointMapping.method).toBe('POST');
        expect(ann.openWorldHint).toBe(true);
        expect(t.description).toMatch(/COSTS MONEY/);
        expect(t.description).toMatch(/[Cc]onfirm/);
      } else {
        expect(t.endpointMapping.method).toBe('GET');
        expect(t.description).toMatch(/Free\./);
      }
    }
    for (const name of PAID) expect(a.instructions).toContain(`\`${name}\``);
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name).toMatch(/^groq_[a-z_]+$/);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [p, schema] of Object.entries(t.parameters?.properties ?? {})) expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('probes with a read tool and documents every tool in the instructions, without em dashes', () => {
    expect(a.probe).toEqual({ tool: 'groq_list_models' });
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [...a.instructions.matchAll(/\bgroq_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgroq_[a-z_]+/g)])].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const live = process.env.RUN_GROQ_LIVE === '1' && process.env.GROQ_API_KEY ? describe : describe.skip;
live('groq adapter: live (free reads only)', () => {
  const real = mockedAxios.__actual;
  const get = async (path: string) => {
    const res = await real.get(`${BASE}${path}`, { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, ...a.connector.headers }, validateStatus: () => true });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return res.data as { data: Array<{ id: string }> };
  };
  it('reads the models, one model, the batches and the files', async () => {
    const models = (await get('/models')).data;
    expect(models.length).toBeGreaterThan(0);
    expect((await get(`/models/${models[0].id}`)) as unknown).toMatchObject({ id: models[0].id });
    expect(Array.isArray((await get('/batches')).data)).toBe(true);
    expect(Array.isArray((await get('/files')).data)).toBe(true);
  }, 60_000);
});
