import axios from 'axios';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import * as adapter from './openrouter.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { assertNoResponseBodyError, describeErrorWhenProblems } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { validateImages } from '../../connectors/response-images.util';

/**
 * OpenRouter API (OpenAPI at https://openrouter.ai/openapi.json, reference at
 * https://openrouter.ai/docs/api_reference/overview), checked on 30 Oct 2026:
 * base https://openrouter.ai/api/v1, `Authorization: Bearer <key>`, optional
 * HTTP-Referer / X-OpenRouter-Title app attribution headers. Endpoints that the
 * reference marks "Management key required" (/credits, /activity, /keys,
 * /analytics, ...) are left out: they need a second key that BEARER_TOKEN auth
 * cannot send per tool.
 *
 * Static part: always runs, through the real RestEngine with axios mocked.
 * Live part (free reads only: key, catalog, one model, its endpoints, providers):
 *   RUN_OPENROUTER_LIVE=1 OPENROUTER_API_KEY=sk-or-v1-... npx jest src/adapters/intl/openrouter
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
  parameters?: { properties?: Record<string, { description?: string; default?: unknown; enum?: unknown[]; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; headers?: Record<string, string> };
  annotations?: Record<string, boolean>;
  responseMapping?: Record<string, any>;
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  icon: string;
  docsUrl: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath: string; config: { errorWhen: unknown } };
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

const BASE = 'https://openrouter.ai/api/v1';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['sk', '-or-v1-', 'a1'.repeat(32)].join('');
const ENV: Record<string, string> = { OPENROUTER_API_KEY: FAKE_KEY };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, tool(name).endpointMapping, ENV);
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, ENV), headers: config.headers } as never,
    endpointMapping as never,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  ) as Promise<unknown>;
};
const sent = () => mockedAxios.mock.calls[0][0];

const SPENDING = ['openrouter_chat_completion', 'openrouter_create_embeddings', 'openrouter_generate_image'];

describe('openrouter adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the key as a Bearer token on openrouter.ai/api/v1 and checks it on /key', () => {
    expect(a.slug).toBe('openrouter');
    expect(a.category).toBe('data');
    expect(a.icon).toBe('openrouter');
    expect(a.docsUrl).toMatch(/^https:\/\/openrouter\.ai\/docs\//);
    expect(a.requiredEnvVars).toEqual(['OPENROUTER_API_KEY']);
    expect(a.optionalEnvVars).toBeUndefined();
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{OPENROUTER_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/key');
    expect(a.connector.headers).toMatchObject({ 'HTTP-Referer': 'https://anythingmcp.com', 'X-OpenRouter-Title': 'AnythingMCP' });
    expect(a.envVarMeta.OPENROUTER_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    for (const status of ['401', '403', 'rate_limited']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('accepts an sk-or- key and refuses pasted headers or spaces', () => {
    const re = new RegExp(a.envVarMeta.OPENROUTER_API_KEY.pattern!);
    expect(re.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_KEY}`, `${FAKE_KEY} `, 'sk-or-v1-', 'sk-proj-abcdefghijklmnopqrstuvwxyz']) expect(re.test(bad)).toBe(false);
  });

  const G = 'gen-1761820000-AbCdEf123456';
  const table: Array<[string, Record<string, unknown>, string, string, Record<string, unknown>]> = [
    ['openrouter_list_models', {}, 'GET', `${BASE}/models`, { limit: 50 }],
    ['openrouter_list_user_models', {}, 'GET', `${BASE}/models/user`, { limit: 50 }],
    ['openrouter_get_model', { author: 'openai', slug: 'gpt-4o' }, 'GET', `${BASE}/model/openai/gpt-4o`, {}],
    ['openrouter_list_model_endpoints', { author: 'anthropic', slug: 'claude-sonnet-4.5' }, 'GET', `${BASE}/models/anthropic/claude-sonnet-4.5/endpoints`, {}],
    ['openrouter_list_providers', {}, 'GET', `${BASE}/providers`, {}],
    ['openrouter_list_benchmarks', {}, 'GET', `${BASE}/benchmarks`, { max_results: 50 }],
    ['openrouter_get_model_rankings', {}, 'GET', `${BASE}/datasets/rankings-daily`, {}],
    ['openrouter_get_current_key', {}, 'GET', `${BASE}/key`, {}],
    ['openrouter_get_generation', { id: G }, 'GET', `${BASE}/generation`, { id: G }],
    ['openrouter_get_generation_content', { id: G }, 'GET', `${BASE}/generation/content`, { id: G }],
    ['openrouter_chat_completion', { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }] }, 'POST', `${BASE}/chat/completions`, {}],
    ['openrouter_create_embeddings', { model: 'openai/text-embedding-3-small', input: ['a'] }, 'POST', `${BASE}/embeddings`, {}],
    ['openrouter_generate_image', { model: 'openai/gpt-image-1', prompt: 'a red fox' }, 'POST', `${BASE}/images`, {}],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Bearer key and app headers', async (name, params, method, url, query) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(req.headers['X-OpenRouter-Title']).toBe('AnythingMCP');
    expect(req.params ?? {}).toEqual(query);
  });

  it('maps the catalog filters to the documented query names', async () => {
    mockedAxios.mockResolvedValue({ data: { data: [] } });
    await call('openrouter_list_models', {
      q: 'claude', category: 'programming', supported_parameters: 'tools,response_format', input_modalities: 'text,image', output_modalities: 'text',
      context: 128000, max_price: 3, max_output_price: 15, model_authors: 'anthropic', providers: 'Anthropic', zdr: 'true', region: 'eu', sort: 'pricing-low-to-high', offset: 50, limit: 25,
    });
    expect(sent().params).toEqual({
      q: 'claude', category: 'programming', supported_parameters: 'tools,response_format', input_modalities: 'text,image', output_modalities: 'text',
      context: 128000, max_price: 3, max_output_price: 15, model_authors: 'anthropic', providers: 'Anthropic', zdr: 'true', region: 'eu', sort: 'pricing-low-to-high', offset: 50, limit: 25,
    });
    expect(tool('openrouter_list_models').parameters?.properties?.limit.maximum).toBe(1000);
  });

  it('sends a non-streaming chat completion with only the fields the caller set', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const messages = [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Capital of France?' }];
    await call('openrouter_chat_completion', { model: 'openai/gpt-4o-mini', messages });
    expect(sent().data).toEqual({ model: 'openai/gpt-4o-mini', messages, stream: false });
    mockedAxios.mockClear();
    const extra = {
      models: ['anthropic/claude-sonnet-4.5'], max_completion_tokens: 200, temperature: 0.2, top_p: 0.9, stop: ['\n\n'], seed: 7,
      response_format: { type: 'json_object' }, reasoning: { effort: 'low' }, tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
      provider: { sort: 'price', data_collection: 'deny' }, plugins: [{ id: 'web', max_results: 3 }],
    };
    await call('openrouter_chat_completion', { model: 'openrouter/auto', messages, ...extra });
    expect(sent().data).toEqual({ model: 'openrouter/auto', messages, ...extra, stream: false });
  });

  it('asks for float embeddings and image generation with the documented body fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('openrouter_create_embeddings', { model: 'openai/text-embedding-3-small', input: ['a', 'b'], dimensions: 256, input_type: 'search_query' });
    expect(sent().data).toEqual({ model: 'openai/text-embedding-3-small', input: ['a', 'b'], dimensions: 256, input_type: 'search_query', encoding_format: 'float' });
    mockedAxios.mockClear();
    await call('openrouter_generate_image', { model: 'openai/gpt-image-1', prompt: 'a red fox', n: 2, aspect_ratio: '16:9', resolution: '1K', quality: 'high', output_format: 'webp' });
    expect(sent().data).toEqual({ model: 'openai/gpt-image-1', prompt: 'a red fox', n: 2, aspect_ratio: '16:9', resolution: '1K', quality: 'high', output_format: 'webp' });
  });

  it('trims the model list to the fields needed to choose a model', () => {
    const raw = {
      data: [{
        id: 'openai/gpt-4o', canonical_slug: 'openai/gpt-4o-2024-05-13', name: 'OpenAI: GPT-4o', created: 1715558400, description: 'long text', context_length: 128000,
        architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'GPT' },
        pricing: { prompt: '0.0000025', completion: '0.00001' }, top_provider: { context_length: 128000, max_completion_tokens: 16384, is_moderated: true },
        supported_parameters: ['tools', 'temperature'], default_parameters: { temperature: 1 }, benchmarks: { x: 1 }, links: { details: '/api/v1/models/openai/gpt-4o/endpoints' },
      }],
    };
    for (const name of ['openrouter_list_models', 'openrouter_list_user_models']) {
      const tr = tool(name).responseMapping!.transform;
      expect(validateTransform(tr)).toBeNull();
      expect(applyResponseTransform(raw, tool(name).responseMapping as never).value).toEqual({
        data: [{
          id: 'openai/gpt-4o', name: 'OpenAI: GPT-4o', created: 1715558400, context_length: 128000, pricing: { prompt: '0.0000025', completion: '0.00001' },
          input_modalities: ['text', 'image'], output_modalities: ['text'], supported_parameters: ['tools', 'temperature'], max_completion_tokens: 16384,
        }],
      });
    }
  });

  it('keeps vectors and usage of embeddings and returns generated images as image content', () => {
    expect(validateTransform(tool('openrouter_create_embeddings').responseMapping!.transform)).toBeNull();
    const out = applyResponseTransform(
      { object: 'list', model: 'openai/text-embedding-3-small', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 2, total_tokens: 2 } },
      tool('openrouter_create_embeddings').responseMapping as never,
    ).value;
    expect(out).toEqual({ model: 'openai/text-embedding-3-small', embeddings: [{ index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 2, total_tokens: 2 } });
    expect(validateImages(tool('openrouter_generate_image').responseMapping!.images)).toBeNull();
    expect(tool('openrouter_generate_image').responseMapping!.images.paths).toEqual(['data[*].b64_json']);
  });

  it('turns a provider error inside a 200 completion into a failed call, and lets a normal answer through', () => {
    expect(describeErrorWhenProblems(a.connector.config.errorWhen)).toEqual([]);
    expect(() => assertNoResponseBodyError({ id: 'gen-1', choices: [{ message: { content: 'Paris' } }] }, a.connector.config.errorWhen)).not.toThrow();
    expect(() => assertNoResponseBodyError({ error: { code: 502, message: 'Provider returned error' } }, a.connector.config.errorWhen)).toThrow(/Provider returned error/);
  });

  it('marks text generation read-only like the OpenAI adapter, image generation as an additive write, and flags all three paid calls', () => {
    for (const t of a.tools) {
      const ann = annotationsOf(t);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      if (SPENDING.includes(t.name)) {
        expect(t.endpointMapping.method).toBe('POST');
        if (t.name === 'openrouter_generate_image') expect(ann).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
        else expect(ann).toMatchObject({ readOnlyHint: true, openWorldHint: true });
        expect(t.description).toMatch(/COSTS MONEY/);
      } else {
        expect(t.endpointMapping.method).toBe('GET');
        expect(ann.readOnlyHint).toBe(true);
      }
    }
    expect(tool('openrouter_chat_completion').description).toMatch(/[Cc]onfirm/);
    expect(tool('openrouter_generate_image').description).toMatch(/[Cc]onfirm/);
  });

  it('leaves out management-key endpoints and streaming', () => {
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/^\/(credits|activity|keys|analytics|guardrails|workspaces|byok|organization)/);
    expect(a.instructions).toMatch(/management key/);
  });

  it('every tool is prefixed and unique in the catalog, every declared parameter reaches the request and path parameters are required', () => {
    const dir = join(__dirname, '..');
    const others = new Set<string>();
    for (const region of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      for (const f of readdirSync(join(dir, region.name)).filter((x) => x.endsWith('.json') && x !== 'openrouter.json')) {
        const other = JSON.parse(readFileSync(join(dir, region.name, f), 'utf8')) as { tools?: Array<{ name: string }> };
        for (const t of other.tools ?? []) others.add(t.name);
      }
    }
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const t of a.tools) {
      expect(t.name).toMatch(/^openrouter_[a-z_]+$/);
      expect(others.has(t.name)).toBe(false);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [p, schema] of Object.entries(t.parameters?.properties ?? {})) expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('probes with a read tool and documents every tool in the instructions, without em dashes', () => {
    expect(a.probe).toEqual({ tool: 'openrouter_get_current_key' });
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    expect(annotationsOf(tool(a.probe.tool)).readOnlyHint).toBe(true);
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [...a.instructions.matchAll(/\bopenrouter_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bopenrouter_[a-z_]+/g)])].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const live = process.env.RUN_OPENROUTER_LIVE === '1' && process.env.OPENROUTER_API_KEY ? describe : describe.skip;
live('openrouter adapter: live (free reads only)', () => {
  const real = mockedAxios.__actual;
  const get = async (path: string) => {
    const res = await real.get(`${BASE}${path}`, { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, ...a.connector.headers }, validateStatus: () => true });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return res.data as { data: any };
  };
  it('reads the key, the catalog, one model with its endpoints, and the providers', async () => {
    const key = (await get('/key')).data;
    expect(typeof key.usage).toBe('number');
    const models = (await get('/models?limit=5&sort=most-popular')).data as Array<{ id: string; pricing: unknown }>;
    expect(models.length).toBeGreaterThan(0);
    const [author, slug] = models[0].id.split(':')[0].split('/');
    expect((await get(`/model/${author}/${slug}`)).data).toMatchObject({ id: expect.stringContaining(author) });
    expect(Array.isArray((await get(`/models/${author}/${slug}/endpoints`)).data.endpoints)).toBe(true);
    expect(Array.isArray((await get('/models/user?limit=5')).data)).toBe(true);
    expect((await get('/providers')).data.length).toBeGreaterThan(0);
  }, 60_000);
});
