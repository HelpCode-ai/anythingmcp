import axios from 'axios';
import * as adapter from './huggingface.json';
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
 * Two layers of verification for the Hugging Face adapter:
 *
 *   1. Static: always runs. Pins Bearer auth on huggingface.co and every
 *      tool's method, URL, headers and body through the real RestEngine,
 *      checked on 15 Oct 2026 against huggingface_hub (hf_api.py: whoami-v2,
 *      list_models / list_datasets / list_spaces / search_spaces,
 *      list_daily_papers, list_papers, paper_info, read_paper,
 *      list_repo_tree, list_collections, get_collection), huggingface.js
 *      (hub list-models, who-am-i; inference config.ts and providers
 *      hf-inference.ts / providerHelper.ts for the router routes), the
 *      dataset viewer OpenAPI (datasets-server.huggingface.co/openapi.json)
 *      and the Inference Providers docs (policy suffixes, X-HF-Bill-To).
 *      The response shaping runs on fixtures cut from real responses.
 *
 *   2. Live: skipped unless RUN_HUGGINGFACE_LIVE=1. Without a token it calls
 *      the free public routes for real (the Hub ignores an invalid token on
 *      public reads) and checks the shaped output, and checks that whoami and
 *      chat refuse a wrong token with 401. With HF_TOKEN it also reads the
 *      account. HUGGINGFACE_LIVE_PAID=1 sends one tiny chat request
 *      (a fraction of a cent, billed to the token's account):
 *
 *        RUN_HUGGINGFACE_LIVE=1 HF_TOKEN=hf_... npx jest src/adapters/intl/huggingface.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[]; minimum?: number; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; headers?: Record<string, string>; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; exposeHeaders?: string[] };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  unlisted?: boolean;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
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

const HUB = 'https://huggingface.co';
const VIEWER = 'https://datasets-server.huggingface.co';
const ROUTER = 'https://router.huggingface.co';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = ['hf', '_', 'A'.repeat(17), 'b'.repeat(17)].join('');
const ENV: Record<string, string> = { HF_TOKEN: FAKE_TOKEN };

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
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any);
const sent = () => mockedAxios.mock.calls[0][0];

const PAID = ['huggingface_chat_completion', 'huggingface_run_inference_task'];

describe('huggingface adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.name).toBe('Hugging Face');
  });

  it('sends the token as Bearer on huggingface.co and checks it on whoami-v2', () => {
    expect(a.icon).toBe('hugging-face');
    expect(a.connector.baseUrl).toBe(HUB);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{HF_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/api/whoami-v2');
    expect(a.requiredEnvVars).toEqual(['HF_TOKEN']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'HF_TOKEN', kind: 'credential', secret: true, required: true });
  });

  it('accepts an hf_ token and refuses pasted headers or spaces', () => {
    const re = new RegExp(a.envVarMeta.HF_TOKEN.pattern!);
    expect(re.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_TOKEN}`, `${FAKE_TOKEN} `, 'hf_short', 'r8_abcdefghijklmnopqrstuvwxyz0123456789']) expect(re.test(bad)).toBe(false);
  });

  it('probes with the free whoami read and explains the error codes', () => {
    expect(a.probe).toEqual({ tool: 'huggingface_whoami' });
    for (const status of ['401', '403', '429']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('prefixes every tool with huggingface_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^huggingface_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks every Hub and viewer read read-only and the two paid calls as writes', () => {
    for (const t of a.tools) {
      const ro = annotationsOf(t).readOnlyHint;
      expect(`${t.name}:${ro}`).toBe(`${t.name}:${!PAID.includes(t.name)}`);
    }
  });

  it('asks the model to confirm before every paid call and names who pays', () => {
    for (const name of PAID) {
      expect(tool(name).description).toMatch(/COSTS MONEY/);
      expect(tool(name).description).toMatch(/[Cc]onfirm/);
      expect(tool(name).description).toMatch(/credits/);
    }
    expect(a.instructions).toMatch(/billed to the user's Hugging Face credits/);
    expect(a.instructions).toMatch(/Make calls to Inference Providers/);
  });

  it('only points the model at tools that exist, documents every tool and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bhuggingface_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bhuggingface_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('https://huggingface.co/settings/tokens');
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('carries valid response mappings that do real work (never maxBytes alone)', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(tr).toBeDefined();
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.expression ?? tr.exclude ?? tr.include).toBeDefined();
      expect(tr.maxBytes).toBeGreaterThan(0);
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['huggingface_whoami', {}, 'GET', `${HUB}/api/whoami-v2`],
    ['huggingface_search_models', { search: 'llama' }, 'GET', `${HUB}/api/models`],
    ['huggingface_get_model', { repo_id: 'openai-community/gpt2' }, 'GET', `${HUB}/api/models/openai-community/gpt2`],
    ['huggingface_get_model_providers', { repo_id: 'meta-llama/Llama-3.1-8B-Instruct' }, 'GET', `${HUB}/api/models/meta-llama/Llama-3.1-8B-Instruct`],
    ['huggingface_list_chat_models', {}, 'GET', `${ROUTER}/v1/models`],
    ['huggingface_search_datasets', { search: 'squad' }, 'GET', `${HUB}/api/datasets`],
    ['huggingface_get_dataset', { repo_id: 'rajpurkar/squad' }, 'GET', `${HUB}/api/datasets/rajpurkar/squad`],
    ['huggingface_dataset_splits', { dataset: 'rajpurkar/squad' }, 'GET', `${VIEWER}/splits`],
    ['huggingface_dataset_first_rows', { dataset: 'd/x', config: 'default', split: 'train' }, 'GET', `${VIEWER}/first-rows`],
    ['huggingface_dataset_rows', { dataset: 'd/x', config: 'default', split: 'train' }, 'GET', `${VIEWER}/rows`],
    ['huggingface_dataset_search', { dataset: 'd/x', config: 'default', split: 'train', query: 'q' }, 'GET', `${VIEWER}/search`],
    ['huggingface_dataset_filter', { dataset: 'd/x', config: 'default', split: 'train', where: '"a"=1' }, 'GET', `${VIEWER}/filter`],
    ['huggingface_dataset_size', { dataset: 'd/x' }, 'GET', `${VIEWER}/size`],
    ['huggingface_dataset_statistics', { dataset: 'd/x', config: 'default', split: 'train' }, 'GET', `${VIEWER}/statistics`],
    ['huggingface_search_spaces', {}, 'GET', `${HUB}/api/spaces`],
    ['huggingface_semantic_search_spaces', { query: 'remove background' }, 'GET', `${HUB}/api/spaces/semantic-search`],
    ['huggingface_get_space', { repo_id: 'black-forest-labs/FLUX.1-dev' }, 'GET', `${HUB}/api/spaces/black-forest-labs/FLUX.1-dev`],
    ['huggingface_daily_papers', {}, 'GET', `${HUB}/api/daily_papers`],
    ['huggingface_search_papers', { query: 'attention' }, 'GET', `${HUB}/api/papers/search`],
    ['huggingface_get_paper', { paper_id: '1706.03762' }, 'GET', `${HUB}/api/papers/1706.03762`],
    ['huggingface_read_paper', { paper_id: '1706.03762' }, 'GET', `${HUB}/papers/1706.03762.md`],
    ['huggingface_list_repo_files', { repo_id: 'openai-community/gpt2', path: 'onnx' }, 'GET', `${HUB}/api/models/openai-community/gpt2/tree/main/onnx`],
    ['huggingface_read_file', { repo_path: 'openai-community/gpt2', file_path: 'config.json' }, 'GET', `${HUB}/openai-community/gpt2/resolve/main/config.json`],
    ['huggingface_list_collections', {}, 'GET', `${HUB}/api/collections`],
    ['huggingface_get_collection', { slug: 'meta-llama/llama-32-66f448ffc8c32f949b04c8cf' }, 'GET', `${HUB}/api/collections/meta-llama/llama-32-66f448ffc8c32f949b04c8cf`],
    ['huggingface_chat_completion', { model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] }, 'POST', `${ROUTER}/v1/chat/completions`],
    ['huggingface_run_inference_task', { model: 'distilbert/distilbert-base-uncased-finetuned-sst-2-english', inputs: 'I love it' }, 'POST', `${ROUTER}/hf-inference/models/distilbert/distilbert-base-uncased-finetuned-sst-2-english`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Bearer token', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('searches models with the hf_api query names and a default limit of 20', async () => {
    mockedAxios.mockResolvedValue({ data: [] });
    await call('huggingface_search_models', {
      search: 'llama',
      pipeline_tag: 'text-generation',
      author: 'meta-llama',
      filter: 'gguf',
      inference_provider: 'all',
      sort: 'downloads',
    });
    expect(sent().params).toEqual({
      search: 'llama',
      pipeline_tag: 'text-generation',
      author: 'meta-llama',
      filter: 'gguf',
      inference_provider: 'all',
      sort: 'downloads',
      limit: 20,
    });
  });

  it('expands the provider mapping as repeated expand parameters', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('huggingface_get_model_providers', { repo_id: 'meta-llama/Llama-3.1-8B-Instruct' });
    expect(sent().params).toEqual({ expand: ['inferenceProviderMapping', 'inference', 'pipeline_tag'] });
    expect(sent().paramsSerializer).toBeDefined();
  });

  it('pages dataset rows with offset and length, and passes where and orderby to filter', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('huggingface_dataset_rows', { dataset: 'rajpurkar/squad', config: 'plain_text', split: 'train', offset: 100 });
    expect(sent().params).toEqual({ dataset: 'rajpurkar/squad', config: 'plain_text', split: 'train', offset: 100, length: 20 });
    mockedAxios.mockClear();
    await call('huggingface_dataset_filter', { dataset: 'd/x', config: 'c', split: 's', where: '"age">30', orderby: '"age" DESC' });
    expect(sent().params).toEqual({ dataset: 'd/x', config: 'c', split: 's', where: '"age">30', orderby: '"age" DESC', offset: 0, length: 20 });
  });

  it('searches papers and Spaces with q, and pages daily papers with p', async () => {
    mockedAxios.mockResolvedValue({ data: [] });
    await call('huggingface_search_papers', { query: 'speculative decoding', limit: 5 });
    expect(sent().params).toEqual({ q: 'speculative decoding', limit: 5 });
    mockedAxios.mockClear();
    await call('huggingface_semantic_search_spaces', { query: 'transcribe audio', sdk: 'gradio', include_non_running: true });
    expect(sent().params).toEqual({ q: 'transcribe audio', sdk: 'gradio', includeNonRunning: true });
    mockedAxios.mockClear();
    await call('huggingface_daily_papers', { week: '2026-W41', sort: 'trending', page: 1 });
    expect(sent().params).toEqual({ week: '2026-W41', sort: 'trending', limit: 20, p: 1 });
  });

  it('lists the top folder of a repository by default and asks for the Link header', async () => {
    mockedAxios.mockResolvedValue({ data: [] });
    await call('huggingface_list_repo_files', { repo_type: 'datasets', repo_id: 'rajpurkar/squad', recursive: true });
    expect(sent().url).toBe(`${HUB}/api/datasets/rajpurkar/squad/tree/main/`);
    expect(sent().params).toEqual({ recursive: true });
    expect(tool('huggingface_list_repo_files').endpointMapping.exposeHeaders).toEqual(['link']);
  });

  it('reads only the first max_bytes of a file with a Range header', async () => {
    mockedAxios.mockResolvedValue({ data: 'x' });
    await call('huggingface_read_file', { repo_path: 'datasets/rajpurkar/squad', file_path: 'README.md' });
    expect(sent().url).toBe(`${HUB}/datasets/rajpurkar/squad/resolve/main/README.md`);
    expect(sent().headers.Range).toBe('bytes=0-50000');
    mockedAxios.mockClear();
    await call('huggingface_read_file', { repo_path: 'spaces/a/b', file_path: 'app.py', revision: 'v1', max_bytes: 2000 });
    expect(sent().url).toBe(`${HUB}/spaces/a/b/resolve/v1/app.py`);
    expect(sent().headers.Range).toBe('bytes=0-2000');
  });

  it('chats through the OpenAI-compatible router with only the documented body fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const messages = [{ role: 'user', content: 'Say hi' }];
    await call('huggingface_chat_completion', { model: 'openai/gpt-oss-120b:cheapest', messages });
    expect(sent().data).toEqual({ model: 'openai/gpt-oss-120b:cheapest', messages, max_tokens: 1024 });
    expect(sent().headers['X-HF-Bill-To']).toBeUndefined();
    mockedAxios.mockClear();
    await call('huggingface_chat_completion', { model: 'm', messages, temperature: 0.2, stop: ['END'], bill_to: 'acme' });
    expect(sent().data).toEqual({ model: 'm', messages, max_tokens: 1024, temperature: 0.2, stop: ['END'] });
    expect(sent().headers['X-HF-Bill-To']).toBe('acme');
  });

  it('runs an hf-inference task with inputs and parameters', async () => {
    mockedAxios.mockResolvedValue({ data: [] });
    await call('huggingface_run_inference_task', { model: 'facebook/bart-large-mnli', inputs: 'Great match', parameters: { candidate_labels: ['sport', 'politics'] } });
    expect(sent().data).toEqual({ inputs: 'Great match', parameters: { candidate_labels: ['sport', 'politics'] } });
  });

  it('shapes whoami without the e-mail address', () => {
    const out = shape('huggingface_whoami', {
      type: 'user',
      id: '1',
      name: 'jdoe',
      fullname: 'Jane Doe',
      email: 'jane@example.com',
      emailVerified: true,
      isPro: false,
      canPay: true,
      billingMode: 'prepaid',
      avatarUrl: 'x',
      orgs: [{ type: 'org', id: '2', name: 'acme', fullname: 'Acme', email: 'billing@acme.example', canPay: true, avatarUrl: 'y' }],
      auth: { type: 'access_token', accessToken: { displayName: 'amcp', role: 'fineGrained', createdAt: '2026-10-01T00:00:00Z', fineGrained: { scoped: [] } } },
    });
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual({
      name: 'jdoe',
      fullname: 'Jane Doe',
      type: 'user',
      isPro: false,
      canPay: true,
      billingMode: 'prepaid',
      orgs: [{ name: 'acme', fullname: 'Acme', canPay: true }],
      token: { name: 'amcp', role: 'fineGrained', createdAt: '2026-10-01T00:00:00Z', fineGrained: { scoped: [] } },
    });
    expect(JSON.stringify(out.value)).not.toMatch(/@/);
  });

  it('shapes a model list (a bare array) and a model', () => {
    const list = shape('huggingface_search_models', [
      { _id: 'x', id: 'meta-llama/Llama-3.2-1B-Instruct', likes: 1838, private: false, downloads: 6380305, tags: ['a'], pipeline_tag: 'text-generation', library_name: 'transformers', createdAt: '2024-09-18T15:12:47.000Z', modelId: 'meta-llama/Llama-3.2-1B-Instruct' },
    ]);
    expect(list.value).toEqual({
      models: [{ id: 'meta-llama/Llama-3.2-1B-Instruct', pipeline_tag: 'text-generation', library: 'transformers', downloads: 6380305, likes: 1838, trendingScore: null, createdAt: '2024-09-18T15:12:47.000Z', private: false }],
    });
    const model = shape('huggingface_get_model', {
      id: 'openai-community/gpt2',
      author: 'openai-community',
      pipeline_tag: 'text-generation',
      library_name: 'transformers',
      cardData: { license: 'mit', language: 'en' },
      config: { model_type: 'gpt2', architectures: ['GPT2LMHeadModel'] },
      safetensors: { parameters: { F32: 137022720 }, total: 137022720 },
      siblings: [{ rfilename: 'config.json' }, { rfilename: 'model.safetensors' }],
      spaces: Array.from({ length: 30 }, (_, i) => `s/${i}`),
      widgetData: [{ text: 'big' }],
      transformersInfo: {},
    }).value as any;
    expect(model.license).toBe('mit');
    expect(model.parameters).toBe(137022720);
    expect(model.files).toEqual(['config.json', 'model.safetensors']);
    expect(model.spaces).toHaveLength(10);
    expect(model.widgetData).toBeUndefined();
  });

  it('shapes dataset viewer rows and the router model list', () => {
    const rows = shape('huggingface_dataset_rows', {
      features: [{ feature_idx: 0, name: 'title', type: { dtype: 'string', _type: 'Value' } }],
      rows: [{ row_idx: 7, row: { title: 'Normans' }, truncated_cells: [] }],
      num_rows_total: 87599,
      num_rows_per_page: 100,
      partial: false,
    }).value;
    expect(rows).toEqual({ features: [{ name: 'title', type: { dtype: 'string', _type: 'Value' } }], rows: [{ row_idx: 7, row: { title: 'Normans' } }], num_rows_total: 87599, partial: false });
    const chat = shape('huggingface_list_chat_models', {
      object: 'list',
      data: [{ id: 'Qwen/Qwen3.8-27B', object: 'model', created: 1, owned_by: 'Qwen', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, providers: [{ provider: 'novita', status: 'live', context_length: 1000000, pricing: { input: 0.42, output: 3 }, is_free: false, supports_tools: true, throughput: 35 }] }],
    }).value;
    expect(chat).toEqual({ models: [{ id: 'Qwen/Qwen3.8-27B', owned_by: 'Qwen', input: ['text', 'image'], providers: [{ provider: 'novita', status: 'live', context_length: 1000000, price_in: 0.42, price_out: 3, tools: true }] }] });
  });

  it('passes a markdown paper through as text, capped', () => {
    const md = `# Attention Is All You Need\n\n${'x'.repeat(70000)}`;
    const out = shape('huggingface_read_paper', md);
    expect(out.error).toBeUndefined();
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(out.value).length).toBeLessThan(70000);
    expect(shape('huggingface_read_paper', '# Short').value).toBe('# Short');
  });

  it('keeps the chat answer and usage, and drops provider noise', () => {
    const out = shape('huggingface_chat_completion', {
      id: 'c1',
      object: 'chat.completion',
      created: 1,
      model: 'openai/gpt-oss-120b',
      system_fingerprint: 'fp',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hi!' }, logprobs: null, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }).value;
    expect(out).toEqual({ id: 'c1', model: 'openai/gpt-oss-120b', choices: [{ message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } });
  });
});

const live = process.env.RUN_HUGGINGFACE_LIVE === '1' ? describe : describe.skip;
live('huggingface adapter: live', () => {
  const realToken = process.env.HF_TOKEN;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  const run = async (name: string, params: Record<string, unknown> = {}, env = ENV) => {
    const out = shape(name, await call(name, params, env));
    expect(out.error).toBeUndefined();
    return out.value as any;
  };

  it.each([
    ['huggingface_whoami', {}],
    ['huggingface_chat_completion', { model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }],
    ['huggingface_run_inference_task', { model: 'distilbert/distilbert-base-uncased-finetuned-sst-2-english', inputs: 'I love it' }],
  ])('%s reaches Hugging Face and a wrong token is refused (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('reads models, providers and the router price list for real (free)', async () => {
    const models = await run('huggingface_search_models', { search: 'llama', pipeline_tag: 'text-generation', sort: 'downloads', limit: 3 });
    expect(models.models.length).toBeGreaterThan(0);
    expect(models.models[0].id).toMatch(/\//);
    const gpt2 = await run('huggingface_get_model', { repo_id: 'openai-community/gpt2' });
    expect(gpt2.pipeline_tag).toBe('text-generation');
    expect(gpt2.files).toContain('config.json');
    const providers = await run('huggingface_get_model_providers', { repo_id: 'meta-llama/Llama-3.1-8B-Instruct' });
    expect(Object.keys(providers.providers).length).toBeGreaterThan(0);
    const chat = await run('huggingface_list_chat_models');
    expect(chat.models.length).toBeGreaterThan(10);
    expect(chat.models[0].providers[0].provider).toBeTruthy();
  }, 60000);

  it('reads datasets and the dataset viewer for real (free)', async () => {
    const ds = await run('huggingface_search_datasets', { search: 'squad', sort: 'downloads', limit: 2 });
    expect(ds.datasets.length).toBeGreaterThan(0);
    expect((await run('huggingface_get_dataset', { repo_id: 'rajpurkar/squad' })).license).toBe('cc-by-sa-4.0');
    const splits = await run('huggingface_dataset_splits', { dataset: 'rajpurkar/squad' });
    expect(splits.splits).toEqual(expect.arrayContaining([{ config: 'plain_text', split: 'train' }]));
    const first = await run('huggingface_dataset_first_rows', { dataset: 'rajpurkar/squad', config: 'plain_text', split: 'validation' });
    expect(first.features.map((f: any) => f.name)).toContain('question');
    expect(first.rows[0].question).toBeTruthy();
    const rows = await run('huggingface_dataset_rows', { dataset: 'rajpurkar/squad', config: 'plain_text', split: 'validation', offset: 10, length: 2 });
    expect(rows.rows.map((r: any) => r.row_idx)).toEqual([10, 11]);
    expect(rows.num_rows_total).toBeGreaterThan(1000);
    const size = await run('huggingface_dataset_size', { dataset: 'rajpurkar/squad' });
    expect(size.dataset.num_rows).toBeGreaterThan(1000);
  }, 90000);

  it('searches, filters and describes an indexed dataset for real (free)', async () => {
    const d = { dataset: 'cornell-movie-review-data/rotten_tomatoes', config: 'default', split: 'train' };
    // The viewer answers 500 "the dataset index is loading" while it reloads a
    // search index (minutes at a time, on its side); the instructions tell the
    // model to retry. Treat that one answer as "not checked this run".
    const indexed = async (name: string, params: Record<string, unknown>) => {
      try {
        return await run(name, params);
      } catch (e: any) {
        if (e?.response?.status === 500 && /index is loading/.test(JSON.stringify(e.response.data))) return null;
        throw e;
      }
    };
    const found = await indexed('huggingface_dataset_search', { ...d, query: 'boring', length: 2 });
    if (found) {
      expect(found.rows[0].row.text).toMatch(/boring/i);
      expect(found.num_rows_total).toBeGreaterThan(2);
    }
    const pos = await indexed('huggingface_dataset_filter', { ...d, where: '"label"=1', orderby: '"text" DESC', length: 2 });
    if (pos) expect(pos.rows.every((r: any) => r.row.label === 1)).toBe(true);
    const stats = await run('huggingface_dataset_statistics', d);
    expect(stats.statistics.map((s: any) => s.column)).toEqual(expect.arrayContaining(['label', 'text']));
    const spaces = await run('huggingface_semantic_search_spaces', { query: 'remove image background' });
    expect(Array.isArray(spaces.spaces)).toBe(true);
  }, 240000);

  it('reads Spaces, papers, files and collections for real (free)', async () => {
    expect((await run('huggingface_search_spaces', { search: 'flux', sort: 'likes', limit: 2 })).spaces.length).toBeGreaterThan(0);
    const space = await run('huggingface_get_space', { repo_id: 'black-forest-labs/FLUX.1-dev' });
    expect(space.sdk).toBe('gradio');
    expect(space.stage).toBeTruthy();
    expect((await run('huggingface_daily_papers', { limit: 2 })).papers[0].id).toBeTruthy();
    expect((await run('huggingface_search_papers', { query: 'attention', limit: 2 })).papers.length).toBeGreaterThan(0);
    const paper = await run('huggingface_get_paper', { paper_id: '1706.03762' });
    expect(paper.title).toMatch(/Attention/);
    expect(String(await run('huggingface_read_paper', { paper_id: '1706.03762' }))).toMatch(/Attention/);
    const tree = await run('huggingface_list_repo_files', { repo_id: 'openai-community/gpt2' });
    expect(tree.files.map((f: any) => f.path)).toContain('config.json');
    const sub = await run('huggingface_list_repo_files', { repo_id: 'openai-community/gpt2', path: 'onnx' });
    expect(sub.files[0].path).toMatch(/^onnx\//);
    const config = await run('huggingface_read_file', { repo_path: 'openai-community/gpt2', file_path: 'config.json' });
    expect(config.model_type).toBe('gpt2');
    const readme = await run('huggingface_read_file', { repo_path: 'datasets/rajpurkar/squad', file_path: 'README.md', max_bytes: 1000 });
    expect(typeof readme).toBe('string');
    expect(readme.length).toBeLessThanOrEqual(1001);
    const cols = await run('huggingface_list_collections', { owner: 'meta-llama', limit: 2 });
    expect(cols.collections.length).toBeGreaterThan(0);
    expect((await run('huggingface_get_collection', { slug: cols.collections[0].slug })).items.length).toBeGreaterThan(0);
  }, 120000);

  (realToken ? it : it.skip)('reads the account behind HF_TOKEN (free)', async () => {
    const me = await run('huggingface_whoami', {}, { HF_TOKEN: realToken! });
    expect(me.name).toBeTruthy();
  }, 30000);

  (realToken && process.env.HUGGINGFACE_LIVE_PAID === '1' ? it : it.skip)('sends one tiny chat request (a fraction of a cent)', async () => {
    const out = await run(
      'huggingface_chat_completion',
      { model: 'openai/gpt-oss-20b:cheapest', messages: [{ role: 'user', content: 'Reply with the word ok.' }], max_tokens: 20 },
      { HF_TOKEN: realToken! },
    );
    expect(out.choices[0].message).toBeDefined();
    expect(out.usage.total_tokens).toBeGreaterThan(0);
  }, 60000);
});
