import axios from 'axios';
import * as adapter from './ollama.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Ollama adapter:
 *
 *   1. Static: always runs. Pins the user-supplied base URL, the optional
 *      Bearer key (sent only when OLLAMA_API_KEY is set), every tool's method,
 *      URL and body through the real RestEngine, checked against the Ollama API
 *      reference (docs.ollama.com/api, checked 25 Oct 2026), and the response
 *      shaping. Every request is non-streaming.
 *
 *   2. Live: skipped unless RUN_OLLAMA_LIVE=1. Calls a real Ollama server at
 *      OLLAMA_URL (default http://localhost:11434) with OLLAMA_LIVE_MODEL
 *      (default gemma3:270m, about 300 MB): version, models, show, chat and
 *      generate. OLLAMA_LIVE_EMBED_MODEL also runs ollama_embed:
 *
 *        ollama pull gemma3:270m
 *        RUN_OLLAMA_LIVE=1 npx jest src/adapters/intl/ollama.live.spec.ts
 */

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

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyMapping?: Record<string, unknown>; headers?: Record<string, string> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, string>; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const BASE = 'http://localhost:11434';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['ok', 'Ab'.repeat(8), '34'.repeat(8)].join('');
const LOCAL: Record<string, string> = { OLLAMA_URL: BASE, OLLAMA_API_KEY: '' };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>, env = LOCAL) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig ?? {}, env),
      headers: config.headers,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any);
const sent = () => mockedAxios.mock.calls[0][0];

describe('ollama adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('calls the user-supplied server without required credentials and checks it on /api/version', () => {
    expect(a.icon).toBe('ollama');
    expect(a.connector.baseUrl).toBe('{{OLLAMA_URL}}');
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.healthcheckPath).toBe('/api/version');
    expect(a.requiredEnvVars).toEqual(['OLLAMA_URL']);
    expect(a.optionalEnvVars).toEqual(['OLLAMA_API_KEY']);
    const meta = describeAdapterEnvVars(a as never);
    expect(meta.find((m: any) => m.name === 'OLLAMA_URL')).toMatchObject({ kind: 'address', required: true });
    expect(meta.find((m: any) => m.name === 'OLLAMA_API_KEY')).toMatchObject({ kind: 'credential', secret: true, required: false });
    expect(a.instructions).toMatch(/SSRF_ALLOWED_HOSTS/);
  });

  it('accepts local, Docker-host, LAN and cloud URLs and refuses /api, trailing slashes and missing schemes', () => {
    const re = new RegExp(a.envVarMeta.OLLAMA_URL.pattern!);
    for (const ok of [BASE, 'http://127.0.0.1:11434', 'http://host.docker.internal:11434', 'http://192.168.1.20:11434', 'https://ollama.com', 'https://gpu.example.com/ollama']) {
      expect(`${ok}:${re.test(ok)}`).toBe(`${ok}:true`);
    }
    for (const bad of ['', `${BASE}/`, `${BASE}/api`, 'localhost:11434', 'https://ollama.com/api']) {
      expect(`${bad}:${re.test(bad)}`).toBe(`${bad}:false`);
    }
  });

  it('probes with the free version endpoint and explains the error codes', () => {
    expect(a.probe).toEqual({ tool: 'ollama_get_version' });
    for (const status of ['401', '403', '404']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('prefixes every tool with ollama_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^ollama_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('is read-only: every tool is read-only and nothing pulls, deletes or changes models', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:true`);
      expect(t.enabled).not.toBe(false);
    }
    const paths = a.tools.map((t) => t.endpointMapping.path);
    for (const path of ['/api/pull', '/api/push', '/api/delete', '/api/copy', '/api/create']) expect(paths).not.toContain(path);
    expect(a.instructions).toMatch(/Out of scope/);
  });

  it('only points the model at tools that exist, documents every tool and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bollama_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bollama_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('carries valid response mappings', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      if (!tr) {
        expect(t.name).toBe('ollama_get_version');
        continue;
      }
      expect(validateTransform(tr)).toBeNull();
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['ollama_get_version', {}, 'GET', `${BASE}/api/version`],
    ['ollama_list_models', {}, 'GET', `${BASE}/api/tags`],
    ['ollama_list_running_models', {}, 'GET', `${BASE}/api/ps`],
    ['ollama_show_model', { model: 'gemma3' }, 'POST', `${BASE}/api/show`],
    ['ollama_chat', { model: 'gemma3', messages: [{ role: 'user', content: 'Hi' }] }, 'POST', `${BASE}/api/chat`],
    ['ollama_generate', { model: 'gemma3', prompt: 'Hi' }, 'POST', `${BASE}/api/generate`],
    ['ollama_embed', { model: 'embeddinggemma', input: 'Hi' }, 'POST', `${BASE}/api/embed`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL, with no Authorization header for a local server', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(Object.keys(req.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it.each(table)('%s sends the optional key as Bearer to Ollama Cloud', async (name, params) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params, { OLLAMA_URL: 'https://ollama.com', OLLAMA_API_KEY: FAKE_KEY });
    expect(sent().url.startsWith('https://ollama.com/api/')).toBe(true);
    expect(sent().headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it('sends chat, generate, show and embed bodies with Ollama field names, never streaming', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const messages = [{ role: 'user', content: 'Hi' }];
    await call('ollama_chat', { model: 'gemma3', messages });
    expect(sent().data).toEqual({ model: 'gemma3', messages, stream: false });
    mockedAxios.mockClear();
    const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }];
    await call('ollama_chat', { model: 'qwen3', messages, tools, format: 'json', options: { temperature: 0 }, think: true, keep_alive: '10m' });
    expect(sent().data).toEqual({ model: 'qwen3', messages, tools, format: 'json', options: { temperature: 0 }, think: true, keep_alive: '10m', stream: false });
    mockedAxios.mockClear();
    await call('ollama_generate', { model: 'qwen2.5-coder', prompt: 'def add(', suffix: 'return a + b', system: 'Code only.' });
    expect(sent().data).toEqual({ model: 'qwen2.5-coder', prompt: 'def add(', suffix: 'return a + b', system: 'Code only.', stream: false });
    mockedAxios.mockClear();
    await call('ollama_show_model', { model: 'gemma3' });
    expect(sent().data).toEqual({ model: 'gemma3' });
    mockedAxios.mockClear();
    await call('ollama_embed', { model: 'embeddinggemma', input: ['a', 'b'], dimensions: 256 });
    expect(sent().data).toEqual({ model: 'embeddinggemma', input: ['a', 'b'], dimensions: 256 });
  });

  it('shapes chat and generate answers, keeping thinking and tool calls and dropping empty fields', () => {
    const chat = shape('ollama_chat', {
      model: 'qwen3', created_at: '2026-10-25T05:00:00Z',
      message: { role: 'assistant', content: '', thinking: 'The user wants weather.', tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Hyderabad' } } }] },
      done: true, done_reason: 'stop', total_duration: 10, load_duration: 2, prompt_eval_count: 5, prompt_eval_duration: 1, eval_count: 3, eval_duration: 4,
    });
    expect(chat.value).toEqual({
      model: 'qwen3', answer: '', thinking: 'The user wants weather.',
      tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Hyderabad' } } }],
      done_reason: 'stop', total_duration: 10, load_duration: 2, prompt_eval_count: 5, eval_count: 3,
    });
    const gen = shape('ollama_generate', { model: 'gemma3', response: 'Hello!', done: true, done_reason: 'stop', context: [1, 2, 3], eval_count: 2 });
    expect(gen.value).toEqual({ model: 'gemma3', response: 'Hello!', done_reason: 'stop', eval_count: 2 });
  });

  it('shapes model lists, details and embeddings', () => {
    const details = { format: 'gguf', family: 'gemma3', families: ['gemma3'], parameter_size: '268.10M', quantization_level: 'Q8_0' };
    const tags = shape('ollama_list_models', { models: [{ name: 'gemma3:270m', model: 'gemma3:270m', modified_at: 't', size: 291554930, digest: 'abc', details }] });
    expect(tags.value).toEqual({ models: [{ name: 'gemma3:270m', size: 291554930, modified_at: 't', format: 'gguf', family: 'gemma3', parameter_size: '268.10M', quantization_level: 'Q8_0' }] });
    const ps = shape('ollama_list_running_models', { models: [{ name: 'gemma3:270m', size: 5, size_vram: 5, context_length: 4096, expires_at: 'e', digest: 'abc', details }] });
    expect(ps.value).toEqual({ models: [{ name: 'gemma3:270m', size: 5, size_vram: 5, context_length: 4096, expires_at: 'e', parameter_size: '268.10M', quantization_level: 'Q8_0' }] });
    const show = shape('ollama_show_model', { modelfile: '# huge', capabilities: ['completion'], details, model_info: { 'gemma3.context_length': 32768 }, template: '{{ .Prompt }}', modified_at: 't' });
    expect(show.value).toEqual({ capabilities: ['completion'], details, model_info: { 'gemma3.context_length': 32768 }, template: '{{ .Prompt }}', modified_at: 't' });
    const embed = shape('ollama_embed', { model: 'embeddinggemma', embeddings: [[0.1, 0.2]], total_duration: 1, load_duration: 0, prompt_eval_count: 1 });
    expect(embed.value).toEqual({ model: 'embeddinggemma', embeddings: [[0.1, 0.2]], total_duration: 1, load_duration: 0, prompt_eval_count: 1 });
  });
});

const live = process.env.RUN_OLLAMA_LIVE === '1' ? describe : describe.skip;
live('ollama adapter: live', () => {
  const env = { OLLAMA_URL: process.env.OLLAMA_URL || BASE, OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || '' };
  const model = process.env.OLLAMA_LIVE_MODEL || 'gemma3:270m';
  const embedModel = process.env.OLLAMA_LIVE_EMBED_MODEL;
  const previousAllowed = process.env.SSRF_ALLOWED_HOSTS;
  jest.setTimeout(120000);
  beforeAll(() => {
    // A local server is private address space: allow it the way an operator would.
    process.env.SSRF_ALLOWED_HOSTS = [previousAllowed, new URL(env.OLLAMA_URL).hostname].filter(Boolean).join(',');
    mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg));
  });
  afterAll(() => {
    process.env.SSRF_ALLOWED_HOSTS = previousAllowed;
    mockedAxios.mockReset();
  });

  it('reads the version and lists the installed model', async () => {
    expect((await call('ollama_get_version', {}, env)).version).toMatch(/^\d+\.\d+/);
    const tags = shape('ollama_list_models', await call('ollama_list_models', {}, env));
    expect((tags.value as any).models.map((m: any) => m.name)).toContain(model);
  });

  it('shows the model capabilities', async () => {
    const show = shape('ollama_show_model', await call('ollama_show_model', { model }, env));
    expect((show.value as any).capabilities).toContain('completion');
  });

  it('chats and generates with the model, then sees it loaded', async () => {
    const chat = shape('ollama_chat', await call('ollama_chat', {
      model, messages: [{ role: 'user', content: 'Reply with the single word: hello' }], options: { num_predict: 8, temperature: 0 },
    }, env));
    expect(typeof (chat.value as any).answer).toBe('string');
    expect((chat.value as any).eval_count).toBeGreaterThan(0);
    const gen = shape('ollama_generate', await call('ollama_generate', { model, prompt: 'The sky is', options: { num_predict: 8 } }, env));
    expect(typeof (gen.value as any).response).toBe('string');
    const ps = shape('ollama_list_running_models', await call('ollama_list_running_models', {}, env));
    expect((ps.value as any).models.map((m: any) => m.name)).toContain(model);
  });

  (embedModel ? it : it.skip)('embeds two texts with OLLAMA_LIVE_EMBED_MODEL', async () => {
    const out = shape('ollama_embed', await call('ollama_embed', { model: embedModel, input: ['a', 'b'] }, env));
    expect((out.value as any).embeddings).toHaveLength(2);
  });

  it('answers 404 for a model that is not installed', async () => {
    await expect(call('ollama_chat', { model: 'no-such-model-xyz', messages: [{ role: 'user', content: 'Hi' }] }, env))
      .rejects.toMatchObject({ response: { status: 404 } });
  });
});
