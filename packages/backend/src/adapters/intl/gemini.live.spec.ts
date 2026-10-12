import axios from 'axios';
import * as adapter from './gemini.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { describeErrorWhenProblems } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { validateImages } from '../../connectors/response-images.util';
import { validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Google Gemini API adapter:
 *
 *   1. Static: always runs. Pins the API key header, every tool's method, URL
 *      and body through the real RestEngine against the Generative Language
 *      API discovery document (revision 20261010), the cheap default models,
 *      the safety blocks turned into errors, the response shaping and the
 *      images handed to the client as image content.
 *
 *   2. Live: skipped unless RUN_GEMINI_LIVE=1. Without a key it only checks
 *      that Google refuses a wrong one (400 API_KEY_INVALID). With
 *      GEMINI_API_KEY it lists models, counts tokens, asks one short question
 *      and embeds one text on the cheapest models (well under a cent, or free
 *      on the free tier). GEMINI_LIVE_IMAGES=1 also generates one picture
 *      (about $0.03, needs billing on the key's project):
 *
 *        RUN_GEMINI_LIVE=1 GEMINI_API_KEY=... npx jest src/adapters/intl/gemini.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
    config: { errorWhen: unknown };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'AIza' + 'x'.repeat(35);
const ENV: Record<string, string> = { GEMINI_API_KEY: FAKE_KEY };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; env vars also fill in params of the same name.
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
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
      errorWhen: a.connector.config.errorWhen,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, params);
const sent = () => mockedAxios.mock.calls[0][0];

const READ_ONLY = [
  'gemini_analyze_file_url',
  'gemini_batch_embed_texts',
  'gemini_count_tokens',
  'gemini_embed_text',
  'gemini_generate_content',
  'gemini_generate_text',
  'gemini_get_file',
  'gemini_get_model',
  'gemini_list_files',
  'gemini_list_models',
];
const IMAGE_TOOLS = ['gemini_edit_image', 'gemini_generate_image'];

// Smallest PNG and JPEG headers: what the image check recognises.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).toString('base64');

describe('gemini adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (verified against the official API spec on 12 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('sends the AI Studio key in x-goog-api-key, to the v1beta API only', () => {
    expect(a.category).toBe('data');
    expect(a.icon).toBe('googlegemini');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'x-goog-api-key', apiKey: '{{GEMINI_API_KEY}}' });
    expect(a.connector.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'AnythingMCP' });
    expect(a.connector.healthcheckPath).toBe('/models');
    expect(a.requiredEnvVars).toEqual(['GEMINI_API_KEY']);
    expect(a.optionalEnvVars).toBeUndefined();
    const [key] = describeAdapterEnvVars(a as never);
    expect(key).toMatchObject({ name: 'GEMINI_API_KEY', kind: 'credential', secret: true, required: true });
    const pattern = new RegExp(a.envVarMeta.GEMINI_API_KEY.pattern!);
    expect(pattern.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', 'AIza short', `Bearer ${FAKE_KEY}`, `${FAKE_KEY} `]) expect(pattern.test(bad)).toBe(false);
  });

  it('probes with a short model list and explains the 400 Google answers for a wrong key', () => {
    expect(a.probe).toEqual({ tool: 'gemini_list_models', params: { page_size: 5 } });
    expect(tool('gemini_list_models').parameters.required).toBeUndefined();
    expect(a.verifyHints['400']).toMatch(/API_KEY_INVALID/);
    expect(a.verifyHints['403']).toMatch(/Generative Language API/);
  });

  it('prefixes every tool with gemini_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^gemini_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks generation and reads read-only, image tools as additive writes, and installs delete switched off', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name).sort();
    expect(readOnly).toEqual(READ_ONLY);
    for (const name of IMAGE_TOOLS) {
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
      expect(tool(name).description).toMatch(/COSTS MONEY/);
      expect(tool(name).description).toMatch(/Confirm with the user before calling/);
    }
    expect(annotationsOf(tool('gemini_delete_file'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['gemini_delete_file']);
    expect(tool('gemini_delete_file').description).toMatch(/Confirm with the user/);
  });

  it('defaults to the cheapest stable models', () => {
    for (const name of ['gemini_generate_text', 'gemini_generate_content', 'gemini_analyze_file_url', 'gemini_count_tokens']) {
      expect(tool(name).parameters.properties!.model.default).toBe('gemini-3.1-flash-lite');
    }
    for (const name of IMAGE_TOOLS) expect(tool(name).parameters.properties!.model.default).toBe('gemini-3.1-flash-lite-image');
    for (const name of ['gemini_embed_text', 'gemini_batch_embed_texts']) {
      expect(tool(name).parameters.properties!.model.default).toBe('gemini-embedding-001');
    }
    expect(tool('gemini_embed_text').parameters.properties!.output_dimensionality.default).toBe(768);
  });

  it('only points the model at tools that exist, documents setup and cost, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bgemini_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgemini_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(15);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('https://aistudio.google.com/apikey');
    expect(a.instructions).toMatch(/billed to the user's key/);
    expect(a.instructions).toMatch(/Image models have no free tier/);
    expect(a.instructions).toMatch(/confirm with the user before every call/);
    expect(a.instructions).toMatch(/RESOURCE_EXHAUSTED/);
    expect(a.instructions).toMatch(/Out of scope/);
    expect(a.prerequisites).toMatch(/billing/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });

  it('carries valid response mappings and error rules', () => {
    expect(describeErrorWhenProblems(a.connector.config.errorWhen)).toEqual([]);
    for (const t of a.tools) {
      if (!t.responseMapping) continue;
      expect(validateImages(t.responseMapping.images)).toBeNull();
      if (t.responseMapping.transform) expect(validateTransform(t.responseMapping.transform)).toBeNull();
    }
    expect(a.tools.filter((t) => t.responseMapping?.images).map((t) => t.name).sort()).toEqual(IMAGE_TOOLS);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['gemini_list_models', {}, 'GET', `${BASE}/models`],
    ['gemini_get_model', { model: 'gemini-3.8-flash' }, 'GET', `${BASE}/models/gemini-3.8-flash`],
    ['gemini_generate_text', { prompt: 'Hi' }, 'POST', `${BASE}/models/gemini-3.1-flash-lite:generateContent`],
    ['gemini_generate_content', { contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] }, 'POST', `${BASE}/models/gemini-3.1-flash-lite:generateContent`],
    ['gemini_analyze_file_url', { prompt: 'Describe', file_url: 'https://example.com/a.png', mime_type: 'image/png' }, 'POST', `${BASE}/models/gemini-3.1-flash-lite:generateContent`],
    ['gemini_count_tokens', { text: 'Hi' }, 'POST', `${BASE}/models/gemini-3.1-flash-lite:countTokens`],
    ['gemini_embed_text', { text: 'Hi' }, 'POST', `${BASE}/models/gemini-embedding-001:embedContent`],
    ['gemini_batch_embed_texts', { requests: [] }, 'POST', `${BASE}/models/gemini-embedding-001:batchEmbedContents`],
    ['gemini_generate_image', { prompt: 'A cat' }, 'POST', `${BASE}/models/gemini-3.1-flash-lite-image:generateContent`],
    ['gemini_edit_image', { prompt: 'Make it blue', image_url: 'https://example.com/a.png', image_mime_type: 'image/png' }, 'POST', `${BASE}/models/gemini-3.1-flash-lite-image:generateContent`],
    ['gemini_list_files', {}, 'GET', `${BASE}/files`],
    ['gemini_get_file', { file_id: 'abc-123' }, 'GET', `${BASE}/files/abc-123`],
    ['gemini_delete_file', { file_id: 'abc-123' }, 'DELETE', `${BASE}/files/abc-123`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the key header', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.headers['x-goog-api-key']).toBe(FAKE_KEY);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
    // The key never travels in the URL.
    expect(JSON.stringify(req.params ?? {})).not.toContain(FAKE_KEY);
  });

  it('builds generateContent bodies as the API names them, with a default system instruction', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('gemini_generate_text', { prompt: 'Hi' });
    expect(sent().data).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
      systemInstruction: { parts: [{ text: 'You are a helpful assistant. Answer accurately and concisely.' }] },
      generationConfig: {},
    });
    mockedAxios.mockClear();
    await call('gemini_generate_text', {
      prompt: 'List 3 colours',
      model: 'gemini-3.8-flash',
      system_instruction: 'Answer in German.',
      max_output_tokens: 200,
      temperature: 0.2,
      response_mime_type: 'application/json',
      response_json_schema: { type: 'array', items: { type: 'string' } },
    });
    expect(sent().url).toBe(`${BASE}/models/gemini-3.8-flash:generateContent`);
    expect(sent().data).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'List 3 colours' }] }],
      systemInstruction: { parts: [{ text: 'Answer in German.' }] },
      generationConfig: {
        maxOutputTokens: 200,
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'array', items: { type: 'string' } },
      },
    });
  });

  it('passes the full request through gemini_generate_content and leaves out what is not given', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const contents = [
      { role: 'user', parts: [{ text: 'Hi' }] },
      { role: 'model', parts: [{ text: 'Hello' }] },
      { role: 'user', parts: [{ fileData: { fileUri: 'https://example.com/a.pdf', mimeType: 'application/pdf' } }, { text: 'Summarise' }] },
    ];
    await call('gemini_generate_content', { contents });
    expect(sent().data).toEqual({ contents });
    mockedAxios.mockClear();
    await call('gemini_generate_content', {
      contents,
      system_instruction: { parts: [{ text: 'Be brief.' }] },
      generation_config: { thinkingConfig: { thinkingLevel: 'LOW' } },
      tools: [{ googleSearch: {} }],
    });
    expect(sent().data).toEqual({
      contents,
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } },
      tools: [{ googleSearch: {} }],
    });
  });

  it('puts a file link in fileData before the question', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('gemini_analyze_file_url', { prompt: 'Total?', file_url: 'https://example.com/invoice.pdf', mime_type: 'application/pdf' });
    expect(sent().data.contents).toEqual([
      { role: 'user', parts: [{ fileData: { fileUri: 'https://example.com/invoice.pdf', mimeType: 'application/pdf' } }, { text: 'Total?' }] },
    ]);
  });

  it('counts and embeds with the documented bodies', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('gemini_count_tokens', { text: 'Hello' });
    expect(sent().data).toEqual({ contents: [{ parts: [{ text: 'Hello' }] }] });
    mockedAxios.mockClear();
    await call('gemini_embed_text', { text: 'Hello', task_type: 'RETRIEVAL_QUERY' });
    expect(sent().data).toEqual({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text: 'Hello' }] },
      taskType: 'RETRIEVAL_QUERY',
      outputDimensionality: 768,
    });
    mockedAxios.mockClear();
    const requests = [{ model: 'models/gemini-embedding-001', content: { parts: [{ text: 'a' }] } }];
    await call('gemini_batch_embed_texts', { requests });
    expect(sent().data).toEqual({ requests });
  });

  it('asks the image models for text and image, with an aspect ratio by default and the input picture by link', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('gemini_generate_image', { prompt: 'A red bicycle' });
    expect(sent().data).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'A red bicycle' }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1' } },
    });
    mockedAxios.mockClear();
    await call('gemini_generate_image', { prompt: 'A red bicycle', aspect_ratio: '16:9', image_size: '2K', model: 'gemini-nano-banana-2.1' });
    expect(sent().url).toBe(`${BASE}/models/gemini-nano-banana-2.1:generateContent`);
    expect(sent().data.generationConfig.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: '2K' });
    mockedAxios.mockClear();
    await call('gemini_edit_image', { prompt: 'Make it blue', image_url: 'https://example.com/a.png', image_mime_type: 'image/png' });
    expect(sent().data).toEqual({
      contents: [{ role: 'user', parts: [{ fileData: { fileUri: 'https://example.com/a.png', mimeType: 'image/png' } }, { text: 'Make it blue' }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    });
  });

  it('turns a safety block into an error the model does not retry, and lets normal answers through', async () => {
    mockedAxios.mockResolvedValue({ data: { promptFeedback: { blockReason: 'SAFETY' } } });
    await expect(call('gemini_generate_text', { prompt: 'x' })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('SAFETY') });
    mockedAxios.mockResolvedValue({
      data: { candidates: [{ finishReason: 'IMAGE_SAFETY', finishMessage: 'Unable to show the generated image.' }] },
    });
    await expect(call('gemini_generate_image', { prompt: 'x' })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('IMAGE_SAFETY Unable to show the generated image.'),
    });
    for (const finishReason of ['STOP', 'MAX_TOKENS', 'NO_IMAGE']) {
      mockedAxios.mockResolvedValue({ data: { candidates: [{ finishReason, content: { parts: [{ text: 'ok' }] } }] } });
      await expect(call('gemini_generate_text', { prompt: 'x' })).resolves.toBeDefined();
    }
  });

  it('shapes a text answer into text, finish reason and usage, without thoughts', () => {
    const raw = {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'thinking...', thought: true }, { text: 'Hello ' }, { text: 'world', thoughtSignature: 'x'.repeat(5000) }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
      modelVersion: 'gemini-3.1-flash-lite',
      responseId: 'r1',
    };
    const out = applyResponseTransform(raw, tool('gemini_generate_text').responseMapping as any);
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual({
      text: 'Hello world',
      finishReason: 'STOP',
      finishMessage: null,
      modelVersion: 'gemini-3.1-flash-lite',
      responseId: 'r1',
      usage: raw.usageMetadata,
      grounding: null,
    });
  });

  it('hands generated pictures to the client as images and keeps the text small', () => {
    const raw = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'Here is a red bicycle.' },
              { inlineData: { mimeType: 'image/png', data: PNG }, thoughtSignature: 'y'.repeat(20000) },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { totalTokenCount: 1300 },
      modelVersion: 'gemini-3.1-flash-lite-image',
    };
    for (const name of IMAGE_TOOLS) {
      const out = applyResponseTransform(raw, tool(name).responseMapping as any);
      expect(out.error).toBeUndefined();
      expect(out.images).toEqual([{ data: PNG, mimeType: 'image/png', bytes: 16 }]);
      const text = JSON.stringify(out.value);
      expect(text).not.toContain(PNG);
      expect(text).not.toContain('yyyy');
      expect(out.value).toMatchObject({
        modelVersion: 'gemini-3.1-flash-lite-image',
        finishReason: 'STOP',
        parts: [{ text: 'Here is a red bicycle.' }, { image: expect.stringMatching(/^\[image 1: image\/png/), mimeType: 'image/png' }],
        usage: { totalTokenCount: 1300 },
      });
    }
  });

  it('keeps the model list to the fields that matter', () => {
    const raw = {
      models: [
        {
          name: 'models/gemini-3.1-flash-lite',
          baseModelId: 'gemini-3.1-flash-lite',
          version: '3.1',
          displayName: 'Gemini 3.1 Flash-Lite',
          description: 'long text',
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536,
          supportedGenerationMethods: ['generateContent', 'countTokens'],
          thinking: true,
          temperature: 1,
        },
      ],
      nextPageToken: 'n2',
    };
    expect(applyResponseTransform(raw, tool('gemini_list_models').responseMapping as any).value).toEqual({
      models: [
        {
          name: 'gemini-3.1-flash-lite',
          resource: 'models/gemini-3.1-flash-lite',
          displayName: 'Gemini 3.1 Flash-Lite',
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536,
          thinking: true,
          methods: ['generateContent', 'countTokens'],
        },
      ],
      nextPageToken: 'n2',
    });
  });
});

const live = process.env.RUN_GEMINI_LIVE ? describe : describe.skip;

live('gemini adapter: live Generative Language API', () => {
  const key = process.env.GEMINI_API_KEY;
  const env = { GEMINI_API_KEY: key ?? '' };
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, params);

  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  it('refuses a wrong key with 400 API_KEY_INVALID', async () => {
    await expect(execute('gemini_list_models', ENV, {})).rejects.toMatchObject({ response: { status: 400 } });
  }, 30_000);

  (key ? it : it.skip)('lists models, counts tokens, answers and embeds on the cheapest models', async () => {
    const models = await run('gemini_list_models', { page_size: 100 });
    expect(Array.isArray(models.models)).toBe(true);
    const tokens = await run('gemini_count_tokens', { text: 'Hello from AnythingMCP' });
    expect(tokens.totalTokens).toBeGreaterThan(0);
    const answer = await run('gemini_generate_text', { prompt: 'Reply with the single word OK.', max_output_tokens: 50 });
    expect(answer.candidates?.length).toBeGreaterThan(0);
    const embedding = await run('gemini_embed_text', { text: 'Hello', task_type: 'SEMANTIC_SIMILARITY' });
    expect(embedding.embedding.values).toHaveLength(768);
    const files = await run('gemini_list_files', { page_size: 5 });
    expect(typeof files).toBe('object');
  }, 120_000);

  (key && process.env.GEMINI_LIVE_IMAGES === '1' ? it : it.skip)('generates one picture that the client receives as an image', async () => {
    const raw = await run('gemini_generate_image', { prompt: 'A small red square on a white background, flat, no text.' });
    const out = applyResponseTransform(raw, tool('gemini_generate_image').responseMapping as any);
    expect(out.images?.length).toBeGreaterThan(0);
    expect(['image/png', 'image/jpeg', 'image/webp']).toContain(out.images![0].mimeType);
  }, 120_000);
});
