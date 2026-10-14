import axios from 'axios';
import * as adapter from './mistral.json';
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
 * Two layers of verification for the Mistral AI adapter:
 *
 *   1. Static: always runs. Pins Bearer auth on api.mistral.ai/v1 and every
 *      tool's method, URL and body through the real RestEngine, checked
 *      against Mistral's OpenAPI document (docs.mistral.ai/openapi.yaml,
 *      fetched 14 Oct 2026) and the generated SDKs (client-python 3.2,
 *      client-ts 3.0): `input` (not `messages`) on chat moderation, the OCR
 *      document chunk, the beta Conversations and Agents routes, multipart
 *      file upload, and the response shaping (plain and chunked answers).
 *
 *   2. Live: skipped unless RUN_MISTRAL_LIVE=1. Without a key it checks that
 *      Mistral refuses a wrong one with 401 on every real route and answers
 *      404 on a made-up one. With MISTRAL_API_KEY it lists models, files,
 *      batch jobs, agents and conversations (free). MISTRAL_LIVE_PAID=1 also
 *      asks mistral-small-latest one short question and moderates one text
 *      (a fraction of a cent):
 *
 *        RUN_MISTRAL_LIVE=1 MISTRAL_API_KEY=... npx jest src/adapters/intl/mistral.live.spec.ts
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
jest.mock('../../common/outbound-fetch.util', () => {
  const actual = jest.requireActual('../../common/outbound-fetch.util');
  return {
    ...actual,
    fetchOutbound: jest.fn(async (url: string) => ({
      body: Buffer.from('%PDF-1.4 test'),
      headers: { 'content-type': 'application/pdf' },
      finalUrl: url,
      status: 200,
    })),
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[]; minimum?: number; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyEncoding?: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
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

const BASE = 'https://api.mistral.ai/v1';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['Ab', 'Cd'.repeat(7), '12'.repeat(8)].join('');
const ENV: Record<string, string> = { MISTRAL_API_KEY: FAKE_KEY };

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

const OFF = ['mistral_cancel_batch_job', 'mistral_delete_file'];
const WRITES = ['mistral_cancel_batch_job', 'mistral_continue_conversation', 'mistral_delete_file', 'mistral_start_conversation', 'mistral_upload_file'];

describe('mistral adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor SDK and API spec on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('sends the key as Bearer, on api.mistral.ai/v1, and checks it on /models', () => {
    expect(a.icon).toBe('mistralai');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{MISTRAL_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/models');
    // No JSON Content-Type on the connector: the multipart upload sets its own.
    expect(Object.keys(a.connector.headers).map((h) => h.toLowerCase())).not.toContain('content-type');
    expect(a.requiredEnvVars).toEqual(['MISTRAL_API_KEY']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'MISTRAL_API_KEY', kind: 'credential', secret: true, required: true });
  });

  it('accepts a key and refuses pasted headers or spaces', () => {
    const re = new RegExp(a.envVarMeta.MISTRAL_API_KEY.pattern!);
    expect(re.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_KEY}`, `${FAKE_KEY} `, 'short']) expect(re.test(bad)).toBe(false);
  });

  it('probes with the free model list and explains the error codes', () => {
    expect(a.probe).toEqual({ tool: 'mistral_list_models' });
    for (const status of ['401', '402', '429']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('prefixes every tool with mistral_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^mistral_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks model calls read-only, uploads and conversations as writes, and installs delete and cancel switched off', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(OFF);
    for (const name of OFF) expect(tool(name).description).toMatch(/Confirm with the user/);
    expect(annotationsOf(tool('mistral_cancel_batch_job'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('keeps the defaults cheap and says what costs money', () => {
    expect(tool('mistral_chat').parameters.properties!.model.default).toBe('mistral-small-latest');
    expect(tool('mistral_fim_complete').parameters.properties!.model.default).toBe('codestral-latest');
    expect(tool('mistral_create_embeddings').parameters.properties!.model.default).toBe('mistral-embed');
    expect(tool('mistral_moderate').parameters.properties!.model.default).toBe('mistral-moderation-latest');
    expect(tool('mistral_ocr').parameters.properties!.model.default).toBe('mistral-ocr-latest');
    expect(tool('mistral_ocr').parameters.properties!.include_blocks.default).toBe(false);
    expect(tool('mistral_ocr').description).toMatch(/COSTS MONEY/);
    expect(tool('mistral_ocr').description).toMatch(/confirm with the user/);
    expect(tool('mistral_upload_file').description).toMatch(/Confirm with the user/);
    expect(a.instructions).toMatch(/spends the user's own Mistral credits/);
  });

  it('only points the model at tools that exist, documents every tool and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bmistral_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bmistral_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('carries valid response mappings that do real work', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      if (!tr) {
        expect(t.name).toBe('mistral_delete_file');
        continue;
      }
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.expression ?? tr.exclude ?? tr.include).toBeDefined();
    }
  });

  const FILE = '0b1e6f3c-2c1f-4a7e-9b55-3f4c1c2d9e10';
  const CONV = 'conv_06a1b2c3d4e5f6';
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['mistral_list_models', {}, 'GET', `${BASE}/models`],
    ['mistral_get_model', { model_id: 'mistral-small-latest' }, 'GET', `${BASE}/models/mistral-small-latest`],
    ['mistral_chat', { messages: [{ role: 'user', content: 'Hi' }] }, 'POST', `${BASE}/chat/completions`],
    ['mistral_fim_complete', { prompt: 'def add(a, b):' }, 'POST', `${BASE}/fim/completions`],
    ['mistral_create_embeddings', { input: 'Hello' }, 'POST', `${BASE}/embeddings`],
    ['mistral_moderate', { input: 'Hello' }, 'POST', `${BASE}/moderations`],
    ['mistral_moderate_chat', { messages: [{ role: 'user', content: 'Hi' }] }, 'POST', `${BASE}/chat/moderations`],
    ['mistral_classify', { model: 'ft:classifier:x', input: 'Hello' }, 'POST', `${BASE}/classifications`],
    ['mistral_ocr', { document: { type: 'document_url', document_url: 'https://example.com/a.pdf' } }, 'POST', `${BASE}/ocr`],
    ['mistral_start_conversation', { inputs: 'Hi' }, 'POST', `${BASE}/conversations`],
    ['mistral_continue_conversation', { conversation_id: CONV, inputs: 'And?' }, 'POST', `${BASE}/conversations/${CONV}`],
    ['mistral_list_conversations', {}, 'GET', `${BASE}/conversations`],
    ['mistral_get_conversation_messages', { conversation_id: CONV }, 'GET', `${BASE}/conversations/${CONV}/messages`],
    ['mistral_list_agents', {}, 'GET', `${BASE}/agents/pages`],
    ['mistral_get_agent', { agent_id: 'ag_0123' }, 'GET', `${BASE}/agents/ag_0123`],
    ['mistral_list_files', {}, 'GET', `${BASE}/files`],
    ['mistral_get_file', { file_id: FILE }, 'GET', `${BASE}/files/${FILE}`],
    ['mistral_get_file_url', { file_id: FILE }, 'GET', `${BASE}/files/${FILE}/url`],
    ['mistral_upload_file', { file_url: 'https://example.com/a.pdf' }, 'POST', `${BASE}/files`],
    ['mistral_delete_file', { file_id: FILE }, 'DELETE', `${BASE}/files/${FILE}`],
    ['mistral_list_batch_jobs', {}, 'GET', `${BASE}/batch/jobs`],
    ['mistral_get_batch_job', { job_id: FILE }, 'GET', `${BASE}/batch/jobs/${FILE}`],
    ['mistral_cancel_batch_job', { job_id: FILE }, 'POST', `${BASE}/batch/jobs/${FILE}/cancel`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Bearer key', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('sends chat, FIM and embeddings with the SDK field names and cheap defaults', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const messages = [{ role: 'user', content: 'Hi' }];
    await call('mistral_chat', { messages });
    expect(sent().data).toEqual({ model: 'mistral-small-latest', messages });
    mockedAxios.mockClear();
    await call('mistral_chat', { messages, model: 'mistral-medium-latest', max_tokens: 50, temperature: 0.2, reasoning_effort: 'low', response_format: { type: 'json_object' }, random_seed: 1 });
    expect(sent().data).toEqual({ model: 'mistral-medium-latest', messages, max_tokens: 50, temperature: 0.2, reasoning_effort: 'low', response_format: { type: 'json_object' }, random_seed: 1 });
    mockedAxios.mockClear();
    await call('mistral_fim_complete', { prompt: 'def f(', suffix: 'return x' });
    expect(sent().data).toEqual({ model: 'codestral-latest', prompt: 'def f(', suffix: 'return x', max_tokens: 256 });
    mockedAxios.mockClear();
    await call('mistral_create_embeddings', { input: ['a', 'b'] });
    expect(sent().data).toEqual({ model: 'mistral-embed', input: ['a', 'b'] });
  });

  it('sends chat moderation messages as input, as the API names the field', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const messages = [{ role: 'user', content: 'Hi' }];
    await call('mistral_moderate_chat', { messages });
    expect(sent().data).toEqual({ model: 'mistral-moderation-latest', input: messages });
  });

  it('runs OCR without image base64 or blocks unless asked', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const document = { type: 'image_url', image_url: 'https://example.com/scan.png' };
    await call('mistral_ocr', { document });
    expect(sent().data).toEqual({ model: 'mistral-ocr-latest', document, include_blocks: false, include_image_base64: false });
    mockedAxios.mockClear();
    await call('mistral_ocr', { document: { type: 'file', file_id: FILE }, pages: '0-2', table_format: 'html' });
    expect(sent().data).toMatchObject({ document: { type: 'file', file_id: FILE }, pages: '0-2', table_format: 'html' });
  });

  it('starts and continues conversations without streaming', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('mistral_start_conversation', { inputs: 'News on Mistral?', tools: [{ type: 'web_search' }] });
    expect(sent().data).toEqual({ inputs: 'News on Mistral?', model: 'mistral-small-latest', tools: [{ type: 'web_search' }], store: true, stream: false });
    mockedAxios.mockClear();
    await call('mistral_continue_conversation', { conversation_id: CONV, inputs: 'More' });
    expect(sent().data).toEqual({ inputs: 'More', stream: false });
  });

  it('uploads a file as multipart with the fetched file and the purpose', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('mistral_upload_file', { file_url: 'https://example.com/a.pdf' });
    const req = sent();
    expect(String(req.headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
    const body = req.data.getBuffer().toString();
    expect(body).toContain('name="file"; filename="a.pdf"');
    expect(body).toContain('%PDF-1.4 test');
    expect(body).toMatch(/name="purpose"\r\n\r\nocr/);
  });

  it('lists with small pages and repeats array filters', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('mistral_list_batch_jobs', { status: ['RUNNING', 'QUEUED'] });
    expect(sent().params).toEqual({ status: ['RUNNING', 'QUEUED'], page_size: 20 });
    mockedAxios.mockClear();
    await call('mistral_get_file_url', { file_id: FILE });
    expect(sent().params).toEqual({ expiry: 1 });
  });

  it('shapes a plain chat answer and a reasoning answer made of chunks', () => {
    const plain = shape('mistral_chat', {
      id: 'c1',
      object: 'chat.completion',
      model: 'mistral-small-latest',
      created: 1,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Bonjour', tool_calls: null }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
    expect(plain.error).toBeUndefined();
    expect(plain.value).toEqual({ id: 'c1', model: 'mistral-small-latest', answer: 'Bonjour', finish_reason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } });
    const chunks = shape('mistral_chat', {
      id: 'c2',
      model: 'mistral-small-latest',
      choices: [{ message: { role: 'assistant', content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'hmm' }] }, { type: 'text', text: '42' }] }, finish_reason: 'stop' }],
      usage: { total_tokens: 9 },
    });
    expect(chunks.value).toMatchObject({ answer: '42', finish_reason: 'stop' });
  });

  it('shapes a conversation answer with its web sources', () => {
    const out = shape('mistral_start_conversation', {
      object: 'conversation.response',
      conversation_id: CONV,
      outputs: [
        { type: 'tool.execution', name: 'web_search', arguments: '{"query":"x"}', info: {} },
        {
          type: 'message.output',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Mistral released ' },
            { type: 'tool_reference', tool: 'web_search', title: 'News', url: 'https://example.com/n', favicon: 'f' },
            { type: 'text', text: 'a model.' },
          ],
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, connector_tokens: 100 },
    });
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual({
      conversation_id: CONV,
      answer: 'Mistral released a model.',
      sources: [{ title: 'News', url: 'https://example.com/n', tool: 'web_search' }],
      tool_calls: [{ type: 'tool.execution', name: 'web_search', arguments: '{"query":"x"}' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, connector_tokens: 100 },
    });
    const plain = shape('mistral_continue_conversation', { conversation_id: CONV, outputs: [{ type: 'message.output', content: 'Hello' }], usage: {} });
    expect(plain.value).toMatchObject({ answer: 'Hello', sources: [], tool_calls: [] });
  });

  it('shapes OCR pages, files and batch jobs', () => {
    const ocr = shape('mistral_ocr', {
      model: 'mistral-ocr-2512',
      pages: [{ index: 0, markdown: '# Invoice', images: [{ id: 'img-0', image_base64: 'xxx' }], tables: [], dimensions: { dpi: 200 }, blocks: [{}] }],
      usage_info: { pages_processed: 1, doc_size_bytes: 1000 },
      document_annotation: null,
    });
    expect(ocr.value).toEqual({ model: 'mistral-ocr-2512', pages: [{ index: 0, markdown: '# Invoice', tables: [], header: null, footer: null }], usage_info: { pages_processed: 1, doc_size_bytes: 1000 } });
    const files = shape('mistral_list_files', { object: 'list', total: 1, data: [{ id: FILE, object: 'file', bytes: 10, created_at: 1, filename: 'a.pdf', purpose: 'ocr', mimetype: 'application/pdf', source: 'upload', signature: 's' }] });
    expect(files.value).toEqual({ total: 1, files: [{ id: FILE, filename: 'a.pdf', purpose: 'ocr', bytes: 10, mimetype: 'application/pdf', created_at: 1, source: 'upload' }] });
    const job = shape('mistral_get_batch_job', { id: FILE, status: 'SUCCESS', endpoint: '/v1/chat/completions', model: 'm', input_files: ['f'], output_file: 'o', errors: [], outputs: [{ huge: true }], total_requests: 2, succeeded_requests: 2 });
    expect(job.value).toMatchObject({ id: FILE, status: 'SUCCESS', output_file: 'o', errors: [], input_files: ['f'] });
    expect((job.value as any).outputs).toBeUndefined();
  });
});

const live = process.env.RUN_MISTRAL_LIVE === '1' ? describe : describe.skip;
live('mistral adapter: live', () => {
  const realKey = process.env.MISTRAL_API_KEY;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['mistral_list_models', {}],
    ['mistral_chat', { messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 }],
    ['mistral_fim_complete', { prompt: 'def f(' }],
    ['mistral_create_embeddings', { input: 'Hello' }],
    ['mistral_moderate', { input: 'Hello' }],
    ['mistral_moderate_chat', { messages: [{ role: 'user', content: 'Hi' }] }],
    ['mistral_ocr', { document: { type: 'document_url', document_url: 'https://example.com/a.pdf' } }],
    ['mistral_start_conversation', { inputs: 'Hi', store: false }],
    ['mistral_list_conversations', {}],
    ['mistral_list_agents', {}],
    ['mistral_list_files', {}],
    ['mistral_list_batch_jobs', {}],
  ])('%s reaches a real route and Mistral refuses a wrong key (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('answers 404 on a made-up route', async () => {
    await expect(
      (mockedAxios.__actual as any).request({ url: `${BASE}/does-not-exist`, method: 'GET', headers: { Authorization: `Bearer ${FAKE_KEY}` } }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (realKey ? it : it.skip)('lists models, files, batch jobs, agents and conversations (free)', async () => {
    const env = { MISTRAL_API_KEY: realKey! };
    const run = async (name: string, params: Record<string, unknown> = {}) => {
      const out = shape(name, await call(name, params, env));
      expect(out.error).toBeUndefined();
      return out.value as any;
    };
    expect((await run('mistral_list_models')).models.length).toBeGreaterThan(0);
    expect(Array.isArray((await run('mistral_list_files', { page_size: 5 })).files)).toBe(true);
    expect(Array.isArray((await run('mistral_list_batch_jobs', { page_size: 5 })).jobs)).toBe(true);
    expect(Array.isArray((await run('mistral_list_agents', { page_size: 5 })).agents)).toBe(true);
    expect(Array.isArray((await run('mistral_list_conversations', { page_size: 5 })).conversations)).toBe(true);
  }, 120000);

  (realKey && process.env.MISTRAL_LIVE_PAID === '1' ? it : it.skip)('asks one short question and moderates one text (a fraction of a cent)', async () => {
    const env = { MISTRAL_API_KEY: realKey! };
    const chat = shape('mistral_chat', await call('mistral_chat', { messages: [{ role: 'user', content: 'Reply with the single word OK.' }], max_tokens: 10 }, env)).value as any;
    expect(typeof chat.answer).toBe('string');
    const mod = shape('mistral_moderate', await call('mistral_moderate', { input: 'Have a nice day.' }, env)).value as any;
    expect(mod.results[0].categories).toBeDefined();
  }, 60000);
});
