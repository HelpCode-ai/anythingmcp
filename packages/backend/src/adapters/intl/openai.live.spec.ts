import axios from 'axios';
import * as adapter from './openai.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { describeErrorWhenProblems } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { validateImages } from '../../connectors/response-images.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the OpenAI API adapter:
 *
 *   1. Static: always runs. Pins Bearer auth with the optional organization
 *      and project headers, every tool's method, URL and body through the real
 *      RestEngine against OpenAI's OpenAPI spec (openai/openai-openapi, 2.3.0),
 *      the cheap default models, the errors OpenAI reports inside a 200, the
 *      response shaping and the images handed to the client as image content.
 *
 *   2. Live: skipped unless RUN_OPENAI_LIVE=1. Without a key it only checks
 *      that OpenAI refuses a wrong one with 401. With OPENAI_API_KEY it lists
 *      models, files and batches, moderates a text (free), embeds one text and
 *      asks one short question on the cheapest model (a fraction of a cent).
 *      OPENAI_LIVE_IMAGES=1 also generates one low-quality picture (about
 *      $0.002, needs a verified organization):
 *
 *        RUN_OPENAI_LIVE=1 OPENAI_API_KEY=sk-... npx jest src/adapters/intl/openai.live.spec.ts
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
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
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
  optionalEnvVars: string[];
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

const BASE = 'https://api.openai.com/v1';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'sk-proj-' + 'x'.repeat(40);
const ENV: Record<string, string> = { OPENAI_API_KEY: FAKE_KEY };

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
const call = (name: string, params: Record<string, unknown>, env = ENV) => execute(name, env, params);
const sent = () => mockedAxios.mock.calls[0][0];

const READ_ONLY = [
  'openai_create_embeddings',
  'openai_create_response',
  'openai_get_batch',
  'openai_get_file',
  'openai_get_model',
  'openai_list_batches',
  'openai_list_files',
  'openai_list_models',
  'openai_moderate',
];
const IMAGE_TOOLS = ['openai_edit_image', 'openai_generate_image'];
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]).toString('base64');

describe('openai adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (verified against the official API spec on 12 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('authenticates with the secret key as Bearer, on api.openai.com/v1', () => {
    expect(a.category).toBe('data');
    expect(a.icon).toBe('openai');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{OPENAI_API_KEY}}' });
    expect(a.connector.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'AnythingMCP' });
    expect(a.connector.healthcheckPath).toBe('/models');
    expect(a.requiredEnvVars).toEqual(['OPENAI_API_KEY']);
    expect(a.optionalEnvVars).toEqual(['OPENAI_ORGANIZATION', 'OPENAI_PROJECT']);
    const described = describeAdapterEnvVars(a as never);
    const by = (n: string) => described.find((d) => d.name === n)!;
    expect(by('OPENAI_API_KEY')).toMatchObject({ kind: 'credential', secret: true, required: true });
    expect(by('OPENAI_ORGANIZATION')).toMatchObject({ kind: 'setting', secret: false, required: false });
    expect(by('OPENAI_PROJECT')).toMatchObject({ kind: 'setting', secret: false, required: false });
  });

  it('accepts OpenAI key, organization and project formats', () => {
    const key = new RegExp(a.envVarMeta.OPENAI_API_KEY.pattern!);
    for (const ok of [FAKE_KEY, 'sk-' + 'A'.repeat(48), 'sk-svcacct-' + 'b_'.repeat(20)]) expect(key.test(ok)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_KEY}`, 'pk-' + 'x'.repeat(40), `${FAKE_KEY} `, 'sk-short']) expect(key.test(bad)).toBe(false);
    const org = new RegExp(a.envVarMeta.OPENAI_ORGANIZATION.pattern!);
    expect(org.test('')).toBe(true);
    expect(org.test('org-AbC123')).toBe(true);
    expect(org.test('proj_AbC123')).toBe(false);
    const project = new RegExp(a.envVarMeta.OPENAI_PROJECT.pattern!);
    expect(project.test('')).toBe(true);
    expect(project.test('proj_AbC123')).toBe(true);
    expect(project.test('org-AbC123')).toBe(false);
  });

  it('probes with the free model list', () => {
    expect(a.probe).toEqual({ tool: 'openai_list_models' });
    expect(a.verifyHints['401']).toMatch(/api-keys/);
  });

  it('prefixes every tool with openai_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^openai_[a-z_]+$/);
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
    expect(annotationsOf(tool('openai_delete_file'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['openai_delete_file']);
  });

  it('defaults to the cheapest models, one picture and a small format', () => {
    expect(tool('openai_create_response').parameters.properties!.model.default).toBe('gpt-6-luna');
    expect(tool('openai_create_response').parameters.properties!.store.default).toBe(false);
    for (const name of IMAGE_TOOLS) {
      const p = tool(name).parameters.properties!;
      expect(p.model.default).toBe('gpt-image-1-mini');
      expect(p.quality.default).toBe('medium');
      expect(p.n.default).toBe(1);
      expect(p.output_format.default).toBe('jpeg');
    }
    expect(tool('openai_create_embeddings').parameters.properties!.model.default).toBe('text-embedding-3-small');
    expect(tool('openai_create_embeddings').parameters.properties!.dimensions.default).toBe(256);
    expect(tool('openai_moderate').parameters.properties!.model.default).toBe('omni-moderation-latest');
  });

  it('only points the model at tools that exist, documents setup and cost, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bopenai_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bopenai_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(12);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('https://platform.openai.com/api-keys');
    expect(a.instructions).toMatch(/billed to the user's OpenAI account/);
    expect(a.instructions).toMatch(/verified organization/);
    expect(a.instructions).toMatch(/confirm with the user before every call/);
    expect(a.instructions).toMatch(/insufficient_quota/);
    expect(a.instructions).toMatch(/Out of scope/);
    expect(a.prerequisites).toMatch(/ChatGPT subscription does not include API access/);
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
    ['openai_list_models', {}, 'GET', `${BASE}/models`],
    ['openai_get_model', { model: 'gpt-6-luna' }, 'GET', `${BASE}/models/gpt-6-luna`],
    ['openai_create_response', { input: 'Hi' }, 'POST', `${BASE}/responses`],
    ['openai_generate_image', { prompt: 'A cat' }, 'POST', `${BASE}/images/generations`],
    ['openai_edit_image', { prompt: 'Blue', images: [{ image_url: 'https://example.com/a.png' }] }, 'POST', `${BASE}/images/edits`],
    ['openai_create_embeddings', { input: 'Hi' }, 'POST', `${BASE}/embeddings`],
    ['openai_moderate', { input: 'Hi' }, 'POST', `${BASE}/moderations`],
    ['openai_list_files', {}, 'GET', `${BASE}/files`],
    ['openai_get_file', { file_id: 'file-abc' }, 'GET', `${BASE}/files/file-abc`],
    ['openai_delete_file', { file_id: 'file-abc' }, 'DELETE', `${BASE}/files/file-abc`],
    ['openai_list_batches', {}, 'GET', `${BASE}/batches`],
    ['openai_get_batch', { batch_id: 'batch_abc' }, 'GET', `${BASE}/batches/batch_abc`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Bearer key and no empty org headers', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
    expect(req.headers).not.toHaveProperty('OpenAI-Organization');
    expect(req.headers).not.toHaveProperty('OpenAI-Project');
  });

  it.each(table)('%s sends the organization and project headers when they are set', async (name, params) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params, { ...ENV, OPENAI_ORGANIZATION: 'org-Abc', OPENAI_PROJECT: 'proj_Xyz' });
    expect(sent().headers['OpenAI-Organization']).toBe('org-Abc');
    expect(sent().headers['OpenAI-Project']).toBe('proj_Xyz');
  });

  it('creates a response with the documented body, unstored by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('openai_create_response', { input: 'Hi' });
    expect(sent().data).toEqual({ model: 'gpt-6-luna', input: 'Hi', store: false });
    mockedAxios.mockClear();
    const input = [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'What is in this picture?' },
          { type: 'input_image', image_url: 'https://example.com/a.png', detail: 'auto' },
        ],
      },
    ];
    await call('openai_create_response', {
      input,
      model: 'gpt-6.1-sol',
      instructions: 'Answer in Italian.',
      max_output_tokens: 300,
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
      tools: [{ type: 'web_search' }],
      previous_response_id: 'resp_1',
      store: true,
    });
    expect(sent().data).toEqual({
      model: 'gpt-6.1-sol',
      input,
      instructions: 'Answer in Italian.',
      max_output_tokens: 300,
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
      tools: [{ type: 'web_search' }],
      previous_response_id: 'resp_1',
      store: true,
    });
  });

  it('generates and edits pictures with the cheap defaults, leaving out what is not given', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('openai_generate_image', { prompt: 'A cat' });
    expect(sent().data).toEqual({ model: 'gpt-image-1-mini', prompt: 'A cat', size: '1024x1024', quality: 'medium', n: 1, output_format: 'jpeg' });
    mockedAxios.mockClear();
    await call('openai_edit_image', {
      prompt: 'Make the sky purple',
      images: [{ image_url: 'https://example.com/a.png' }, { file_id: 'file-1' }],
      mask: { image_url: 'https://example.com/mask.png' },
    });
    expect(sent().headers['Content-Type'] ?? 'application/json').toMatch(/json/);
    expect(sent().data).toEqual({
      model: 'gpt-image-1-mini',
      prompt: 'Make the sky purple',
      images: [{ image_url: 'https://example.com/a.png' }, { file_id: 'file-1' }],
      mask: { image_url: 'https://example.com/mask.png' },
      quality: 'medium',
      n: 1,
      output_format: 'jpeg',
    });
  });

  it('embeds, moderates and pages lists with the documented fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('openai_create_embeddings', { input: ['a', 'b'] });
    expect(sent().data).toEqual({ model: 'text-embedding-3-small', input: ['a', 'b'], dimensions: 256 });
    mockedAxios.mockClear();
    await call('openai_moderate', { input: 'text' });
    expect(sent().data).toEqual({ model: 'omni-moderation-latest', input: 'text' });
    mockedAxios.mockClear();
    await call('openai_list_files', { purpose: 'batch', after: 'file-9' });
    expect(sent().params).toEqual({ purpose: 'batch', limit: 20, after: 'file-9' });
    mockedAxios.mockClear();
    await call('openai_list_batches', {});
    expect(sent().params).toEqual({ limit: 20 });
    mockedAxios.mockClear();
    await call('openai_delete_file', { file_id: 'file-abc' });
    expect(sent().data).toBeUndefined();
  });

  it('turns a failed or filtered response inside a 200 into an error', async () => {
    mockedAxios.mockResolvedValue({ data: { id: 'resp_1', status: 'failed', error: { code: 'server_error', message: 'Something went wrong.' } } });
    await expect(call('openai_create_response', { input: 'x' })).rejects.toMatchObject({ status: 502 });
    mockedAxios.mockResolvedValue({ data: { id: 'resp_1', status: 'failed', error: { code: 'invalid_prompt', message: 'Bad prompt.' } } });
    await expect(call('openai_create_response', { input: 'x' })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('invalid_prompt Bad prompt.') });
    mockedAxios.mockResolvedValue({ data: { id: 'resp_1', status: 'incomplete', incomplete_details: { reason: 'content_filter' }, error: null } });
    await expect(call('openai_create_response', { input: 'x' })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('content_filter') });
    mockedAxios.mockResolvedValue({ data: { id: 'resp_1', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, error: null } });
    await expect(call('openai_create_response', { input: 'x' })).resolves.toBeDefined();
    // A batch reports its own `errors`, which is not a failed call.
    mockedAxios.mockResolvedValue({ data: { id: 'batch_1', status: 'failed', errors: { data: [{ code: 'invalid_json' }] } } });
    await expect(call('openai_get_batch', { batch_id: 'batch_1' })).resolves.toBeDefined();
  });

  it('shapes a response into its text, refusal, citations and usage', () => {
    const raw = {
      id: 'resp_1',
      object: 'response',
      model: 'gpt-6-luna',
      status: 'completed',
      incomplete_details: null,
      error: null,
      tools: [],
      reasoning: { effort: 'low' },
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { type: 'web_search_call', id: 'ws_1', status: 'completed' },
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'Hello ', annotations: [{ type: 'url_citation', url: 'https://example.com' }] },
            { type: 'output_text', text: 'world', annotations: [] },
          ],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    };
    const out = applyResponseTransform(raw, tool('openai_create_response').responseMapping as any);
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual({
      id: 'resp_1',
      model: 'gpt-6-luna',
      status: 'completed',
      incomplete_details: null,
      output_text: 'Hello world',
      refusal: '',
      citations: ['https://example.com'],
      usage: raw.usage,
    });
  });

  it('hands generated pictures to the client as images', () => {
    const raw = { created: 1760000000, output_format: 'jpeg', quality: 'medium', size: '1024x1024', data: [{ b64_json: JPEG }], usage: { total_tokens: 1100 } };
    for (const name of IMAGE_TOOLS) {
      const out = applyResponseTransform(raw, tool(name).responseMapping as any);
      expect(out.images).toEqual([{ data: JPEG, mimeType: 'image/jpeg', bytes: 16 }]);
      expect(JSON.stringify(out.value)).not.toContain(JPEG);
      expect(out.value).toMatchObject({ output_format: 'jpeg', data: [{ b64_json: expect.stringMatching(/^\[image 1: image\/jpeg/) }] });
    }
  });

  it('keeps model lists and embeddings compact', () => {
    const models = { object: 'list', data: [{ id: 'gpt-6-luna', object: 'model', created: 1, owned_by: 'openai' }] };
    expect(applyResponseTransform(models, tool('openai_list_models').responseMapping as any).value).toEqual({
      models: [{ id: 'gpt-6-luna', owned_by: 'openai', created: 1 }],
    });
    const emb = { object: 'list', model: 'text-embedding-3-small', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 1, total_tokens: 1 } };
    expect(applyResponseTransform(emb, tool('openai_create_embeddings').responseMapping as any).value).toEqual({
      model: 'text-embedding-3-small',
      embeddings: [{ index: 0, embedding: [0.1, 0.2] }],
      usage: emb.usage,
    });
  });
});

const live = process.env.RUN_OPENAI_LIVE ? describe : describe.skip;

live('openai adapter: live OpenAI API', () => {
  const key = process.env.OPENAI_API_KEY;
  const env: Record<string, string> = { OPENAI_API_KEY: key ?? '' };
  if (process.env.OPENAI_ORGANIZATION) env.OPENAI_ORGANIZATION = process.env.OPENAI_ORGANIZATION;
  if (process.env.OPENAI_PROJECT) env.OPENAI_PROJECT = process.env.OPENAI_PROJECT;
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, params);

  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  it('refuses a wrong key with 401', async () => {
    await expect(execute('openai_list_models', ENV, {})).rejects.toMatchObject({ response: { status: 401 } });
  }, 30_000);

  (key ? it : it.skip)('lists, moderates, embeds and answers on the cheapest models', async () => {
    const models = await run('openai_list_models');
    expect(Array.isArray(models.data)).toBe(true);
    const files = await run('openai_list_files', { limit: 5 });
    expect(Array.isArray(files.data)).toBe(true);
    const batches = await run('openai_list_batches', { limit: 5 });
    expect(Array.isArray(batches.data)).toBe(true);
    const moderation = await run('openai_moderate', { input: 'Have a nice day.' });
    expect(moderation.results[0].flagged).toBe(false);
    const embeddings = await run('openai_create_embeddings', { input: 'Hello' });
    expect(embeddings.data[0].embedding).toHaveLength(256);
    const response = await run('openai_create_response', { input: 'Reply with the single word OK.', max_output_tokens: 100 });
    const shaped = applyResponseTransform(response, tool('openai_create_response').responseMapping as any).value as { output_text: string };
    expect(typeof shaped.output_text).toBe('string');
  }, 120_000);

  (key && process.env.OPENAI_LIVE_IMAGES === '1' ? it : it.skip)('generates one picture that the client receives as an image', async () => {
    const raw = await run('openai_generate_image', { prompt: 'A small red square on a white background, flat, no text.', quality: 'low' });
    const out = applyResponseTransform(raw, tool('openai_generate_image').responseMapping as any);
    expect(out.images?.[0].mimeType).toBe('image/jpeg');
  }, 120_000);
});
