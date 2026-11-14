import axios from 'axios';
import * as adapter from './cohere.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

/**
 * Cohere API (OpenAPI at
 * https://raw.githubusercontent.com/cohere-ai/cohere-developer-experience/main/cohere-openapi.yaml,
 * reference https://docs.cohere.com/reference/about), checked on 30 Oct 2026:
 * base https://api.cohere.com, `Authorization: Bearer <key>`. Chat, embed,
 * rerank, transcription and parse are v2; models, tokenize, datasets and embed
 * jobs are v1. Classify, summarize, generate, connectors and fine-tuning are
 * marked deprecated in the spec and are left out.
 *
 * Static part: always runs, through the real RestEngine with axios mocked.
 * Live part (free calls only: check key, models, one model, tokenize, datasets, batches, embed jobs):
 *   RUN_COHERE_LIVE=1 COHERE_API_KEY=... npx jest src/adapters/intl/cohere
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
jest.mock('../../common/outbound-fetch.util', () => {
  const actual = jest.requireActual('../../common/outbound-fetch.util');
  return {
    ...actual,
    fetchOutbound: jest.fn(async (url: string) => ({ body: Buffer.from('RIFFtestWAVE'), headers: { 'content-type': 'audio/wav' }, finalUrl: url, status: 200 })),
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { description?: string; default?: unknown; enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyEncoding?: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; headers?: Record<string, string> };
  annotations?: Record<string, boolean>;
};
const a = adapter as unknown as {
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

const BASE = 'https://api.cohere.com';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['Zx', 'Yw9'.repeat(12), 'Q'].join('');
const ENV: Record<string, string> = { COHERE_API_KEY: FAKE_KEY };

const call = (name: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, tool(name).endpointMapping, ENV);
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, ENV), headers: config.headers } as never,
    endpointMapping as never,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  ) as Promise<unknown>;
};
const sent = () => mockedAxios.mock.calls[0][0];
const ok = () => mockedAxios.mockResolvedValue({ data: {}, status: 200, headers: {} });

const PAID = ['cohere_chat', 'cohere_embed', 'cohere_rerank', 'cohere_transcribe_audio', 'cohere_parse_document'];
const FREE_POST = ['cohere_check_api_key', 'cohere_tokenize', 'cohere_detokenize'];

describe('cohere adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the key as a Bearer token to api.cohere.com and names the client', async () => {
    expect(a.requiredEnvVars).toEqual(['COHERE_API_KEY']);
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{COHERE_API_KEY}}' });
    expect(a.connector.headers['X-Client-Name']).toBe('AnythingMCP');
    expect(a.envVarMeta.COHERE_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    const re = new RegExp(a.envVarMeta.COHERE_API_KEY.pattern!);
    expect(re.test(FAKE_KEY)).toBe(true);
    expect(re.test(`Bearer ${FAKE_KEY}`)).toBe(false);
    ok();
    await call('cohere_list_models', {});
    expect(sent().url).toBe(`${BASE}/v1/models`);
    expect(sent().params).toEqual({ page_size: 50 });
    expect(sent().headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it('maps every tool to the documented method and path', () => {
    const table = Object.fromEntries(a.tools.map((t) => [t.name, `${t.endpointMapping.method} ${t.endpointMapping.path}`]));
    expect(table).toEqual({
      cohere_list_models: 'GET /v1/models',
      cohere_get_model: 'GET /v1/models/{model}',
      cohere_check_api_key: 'POST /v1/check-api-key',
      cohere_chat: 'POST /v2/chat',
      cohere_embed: 'POST /v2/embed',
      cohere_rerank: 'POST /v2/rerank',
      cohere_transcribe_audio: 'POST /v2/audio/transcriptions',
      cohere_parse_document: 'POST /v2/parse',
      cohere_tokenize: 'POST /v1/tokenize',
      cohere_detokenize: 'POST /v1/detokenize',
      cohere_list_datasets: 'GET /v1/datasets',
      cohere_get_dataset: 'GET /v1/datasets/{dataset_id}',
      cohere_get_dataset_usage: 'GET /v1/datasets/usage',
      cohere_list_batches: 'GET /v2/batches',
      cohere_get_batch: 'GET /v2/batches/{batch_id}',
      cohere_list_embed_jobs: 'GET /v1/embed-jobs',
      cohere_get_embed_job: 'GET /v1/embed-jobs/{job_id}',
    });
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/classify|summarize|generate|connectors|finetuning/);
  });

  it('sends a non-streaming v2 chat with documents, and only the fields the caller set', async () => {
    ok();
    const messages = [{ role: 'user', content: 'Where is the office?' }];
    const documents = [{ id: 'd1', data: { title: 'Office', snippet: 'Berlin' } }];
    await call('cohere_chat', { model: 'command-a-03-2025', messages, documents, max_tokens: 200, thinking: { type: 'disabled' } });
    expect(sent().data).toEqual({ model: 'command-a-03-2025', messages, documents, max_tokens: 200, thinking: { type: 'disabled' }, stream: false });
  });

  it('embeds with the small defaults and reranks with the documented field names', async () => {
    ok();
    await call('cohere_embed', { texts: ['a', 'b'], input_type: 'search_query' });
    expect(sent().data).toEqual({ texts: ['a', 'b'], model: 'embed-v4.0', input_type: 'search_query', output_dimension: 256, embedding_types: ['float'] });
    mockedAxios.mockReset();
    ok();
    await call('cohere_rerank', { query: 'q', documents: ['x', 'y'], top_n: 1 });
    expect(sent().data).toEqual({ query: 'q', documents: ['x', 'y'], model: 'rerank-v5.0-fast', top_n: 1 });
  });

  it('uploads the audio as a multipart file part and wraps a parse image as an image_url document', async () => {
    ok();
    await call('cohere_transcribe_audio', { audio_url: 'https://example.com/talk.wav', language: 'en' });
    const body = (sent().data as { getBuffer: () => Buffer }).getBuffer().toString('utf8');
    expect(String(sent().headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
    expect(body).toContain('name="file"; filename="talk.wav"');
    expect(body).toContain('RIFFtestWAVE');
    expect(body).toMatch(/name="language"\r\n\r\nen\r\n/);
    expect(body).toMatch(/name="model"\r\n\r\ncohere-transcribe-03-2026\r\n/);
    mockedAxios.mockReset();
    ok();
    await call('cohere_parse_document', { image_url: 'https://example.com/page.png' });
    expect(sent().data).toEqual({ model: 'parse-v5.0', document: { type: 'image_url', image_url: 'https://example.com/page.png' } });
  });

  it('maps the dataset filters to the camelCase query names Cohere documents', async () => {
    ok();
    await call('cohere_list_datasets', { dataset_type: 'embed-input', validation_status: 'validated', offset: 25 });
    expect(sent().params).toEqual({ datasetType: 'embed-input', validationStatus: 'validated', limit: 25, offset: 25 });
  });

  it('marks model calls read-only like the OpenAI adapter and labels them as paid; GETs and the free POSTs say Free', () => {
    for (const t of a.tools) {
      const ann = annotationsOf(t);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      expect(`${t.name}:${ann.readOnlyHint}`).toBe(`${t.name}:true`);
      if (PAID.includes(t.name)) {
        expect(t.endpointMapping.method).toBe('POST');
        expect(ann.openWorldHint).toBe(true);
        expect(t.description).toMatch(/COSTS MONEY/);
        expect(t.description).toMatch(/[Cc]onfirm/);
      } else {
        expect(t.endpointMapping.method).toBe(FREE_POST.includes(t.name) ? 'POST' : 'GET');
        expect(t.description).toMatch(/Free\./);
      }
    }
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name).toMatch(/^cohere_[a-z_]+$/);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [p, schema] of Object.entries(t.parameters?.properties ?? {})) expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('probes with a read tool and documents every tool in the instructions, without em dashes', () => {
    expect(a.probe).toEqual({ tool: 'cohere_list_models' });
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [...a.instructions.matchAll(/\bcohere_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bcohere_[a-z_]+/g)])].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const live = process.env.RUN_COHERE_LIVE === '1' && process.env.COHERE_API_KEY ? describe : describe.skip;
live('cohere adapter: live (free calls only)', () => {
  const real = mockedAxios.__actual;
  const headers = () => ({ Authorization: `Bearer ${process.env.COHERE_API_KEY}`, ...a.connector.headers });
  const get = async (path: string) => {
    const res = await real.get(`${BASE}${path}`, { headers: headers(), validateStatus: () => true });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return res.data as Record<string, any>;
  };
  it('checks the key, reads models, one model, datasets, batches and embed jobs, and tokenizes', async () => {
    const check = await real.post(`${BASE}/v1/check-api-key`, undefined, { headers: headers(), validateStatus: () => true });
    expect(check.data).toMatchObject({ valid: true });
    const models = (await get('/v1/models?endpoint=chat&page_size=5')).models as Array<{ name: string }>;
    expect(models.length).toBeGreaterThan(0);
    expect(await get(`/v1/models/${models[0].name}`)).toMatchObject({ name: models[0].name });
    const tok = await real.post(`${BASE}/v1/tokenize`, { text: 'hello world', model: models[0].name }, { headers: headers(), validateStatus: () => true });
    expect(Array.isArray(tok.data.tokens)).toBe(true);
    expect(Array.isArray((await get('/v1/datasets?limit=5')).datasets)).toBe(true);
    expect(await get('/v1/datasets/usage')).toHaveProperty('organization_usage');
    expect(Array.isArray((await get('/v2/batches?page_size=5')).batches ?? [])).toBe(true);
    expect(Array.isArray((await get('/v1/embed-jobs')).embed_jobs ?? [])).toBe(true);
  }, 60_000);
});
