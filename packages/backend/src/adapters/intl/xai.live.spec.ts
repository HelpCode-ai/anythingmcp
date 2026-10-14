import axios from 'axios';
import * as adapter from './xai.json';
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
 * Two layers of verification for the xAI Grok adapter:
 *
 *   1. Static: always runs. Pins Bearer auth on api.x.ai/v1 and every tool's
 *      method, URL and body through the real RestEngine, checked against
 *      xAI's OpenAPI document (docs.x.ai/openapi.json, fetched 14 Oct 2026)
 *      and the official REST SDK (xai-sdk-ts): the Responses API with the
 *      web_search and x_search server-side tools (not Live Search), deferred
 *      chat completions, Grok Imagine with b64_json handed to the client as
 *      image content, tokenize-text and api-key, and the response shaping.
 *
 *   2. Live: skipped unless RUN_XAI_LIVE=1. Without a key it checks that xAI
 *      refuses a wrong one (with 400, as xAI does) on every real route and
 *      answers 404 on a made-up one. With XAI_API_KEY it reads the key, the
 *      model lists and tokenizes a text (free). XAI_LIVE_PAID=1 also asks
 *      grok-4.3 one short question (a fraction of a cent):
 *
 *        RUN_XAI_LIVE=1 XAI_API_KEY=xai-... npx jest src/adapters/intl/xai.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[]; minimum?: number; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  aliases: string[];
  unlisted?: boolean;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath: string; config: { errorWhen: unknown } };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const BASE = 'https://api.x.ai/v1';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['xai', '-', 'Q'.repeat(40), '7'.repeat(40)].join('');
const ENV: Record<string, string> = { XAI_API_KEY: FAKE_KEY };

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

const PAID_MEDIA = ['xai_edit_image', 'xai_generate_image'];
const READ_ONLY = [
  'xai_create_response',
  'xai_get_api_key_info',
  'xai_get_deferred_completion',
  'xai_get_response',
  'xai_list_image_models',
  'xai_list_language_models',
  'xai_list_models',
  'xai_tokenize_text',
  'xai_web_search',
  'xai_x_search',
];

describe('xai adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor SDK and API spec on 14 Oct 2026, and is found as Grok', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.name).toBe('xAI Grok');
    expect(a.aliases).toContain('Grok');
  });

  it('sends the key as Bearer, on api.x.ai/v1, and checks it on /api-key', () => {
    expect(a.icon).toBe('xai');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{XAI_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/api-key');
    expect(describeErrorWhenProblems(a.connector.config.errorWhen as any)).toEqual([]);
    expect(a.requiredEnvVars).toEqual(['XAI_API_KEY']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'XAI_API_KEY', kind: 'credential', secret: true, required: true });
  });

  it('accepts an xai- key and refuses pasted headers or spaces', () => {
    const re = new RegExp(a.envVarMeta.XAI_API_KEY.pattern!);
    expect(re.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_KEY}`, `${FAKE_KEY} `, 'xai-short', 'sk-abcdefghijklmnopqrstuvwxyz']) expect(re.test(bad)).toBe(false);
  });

  it('probes with the free key read and explains that xAI answers a wrong key with 400', () => {
    expect(a.probe).toEqual({ tool: 'xai_get_api_key_info' });
    for (const status of ['400', '401', '403', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['400']).toMatch(/Incorrect API key/);
  });

  it('prefixes every tool with xai_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^xai_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks answers and reads read-only, media and deferred starts as writes, and installs the delete switched off', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name).sort();
    expect(readOnly).toEqual(READ_ONLY);
    for (const name of [...PAID_MEDIA, 'xai_start_deferred_completion']) expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['xai_delete_response']);
    expect(annotationsOf(tool('xai_delete_response'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('keeps the defaults cheap and asks before paid pictures', () => {
    for (const name of ['xai_create_response', 'xai_web_search', 'xai_x_search', 'xai_start_deferred_completion', 'xai_tokenize_text']) {
      expect(tool(name).parameters.properties!.model.default).toBe('grok-4.3');
    }
    expect(tool('xai_create_response').parameters.properties!.store.default).toBe(false);
    for (const name of PAID_MEDIA) {
      expect(tool(name).description).toMatch(/COSTS MONEY/);
      expect(tool(name).description).toMatch(/Confirm with the user/);
      expect(tool(name).parameters.properties!.model.default).toBe('grok-imagine-image');
      expect(tool(name).parameters.properties!.n.default).toBe(1);
      expect(tool(name).parameters.properties!.n.maximum).toBe(4);
    }
    expect(a.instructions).toMatch(/spends the user's own xAI credits/);
  });

  it('only points the model at tools that exist, documents every tool and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bxai_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bxai_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/Out of scope/);
    expect(a.instructions).toMatch(/replace the older Live Search/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('carries valid response mappings, and images only on the picture tools', () => {
    for (const t of a.tools) {
      const rm = t.responseMapping;
      if (!rm) {
        expect(t.name).toBe('xai_delete_response');
        continue;
      }
      expect(validateImages(rm.images)).toBeNull();
      if (rm.transform) {
        expect(validateTransform(rm.transform)).toBeNull();
        expect(rm.transform.select ?? rm.transform.expression ?? rm.transform.exclude ?? rm.transform.include).toBeDefined();
      }
    }
    expect(a.tools.filter((t) => t.responseMapping?.images).map((t) => t.name).sort()).toEqual(PAID_MEDIA);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['xai_list_language_models', {}, 'GET', `${BASE}/language-models`],
    ['xai_list_models', {}, 'GET', `${BASE}/models`],
    ['xai_list_image_models', {}, 'GET', `${BASE}/image-generation-models`],
    ['xai_create_response', { input: 'Hi' }, 'POST', `${BASE}/responses`],
    ['xai_web_search', { input: 'News?' }, 'POST', `${BASE}/responses`],
    ['xai_x_search', { input: 'Posts?' }, 'POST', `${BASE}/responses`],
    ['xai_get_response', { response_id: 'resp_1' }, 'GET', `${BASE}/responses/resp_1`],
    ['xai_delete_response', { response_id: 'resp_1' }, 'DELETE', `${BASE}/responses/resp_1`],
    ['xai_start_deferred_completion', { messages: [{ role: 'user', content: 'Hi' }] }, 'POST', `${BASE}/chat/completions`],
    ['xai_get_deferred_completion', { request_id: 'req_1' }, 'GET', `${BASE}/chat/deferred-completion/req_1`],
    ['xai_generate_image', { prompt: 'a cat' }, 'POST', `${BASE}/images/generations`],
    ['xai_edit_image', { prompt: 'make it blue', image_url: 'https://example.com/a.png' }, 'POST', `${BASE}/images/edits`],
    ['xai_tokenize_text', { text: 'Hello' }, 'POST', `${BASE}/tokenize-text`],
    ['xai_get_api_key_info', {}, 'GET', `${BASE}/api-key`],
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

  it('asks the Responses API with grok-4.3 and nothing stored by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('xai_create_response', { input: 'Hi' });
    expect(sent().data).toEqual({ model: 'grok-4.3', input: 'Hi', store: false });
    mockedAxios.mockClear();
    await call('xai_create_response', { input: 'Hi', tools: [{ type: 'code_interpreter' }], reasoning: { effort: 'low' }, max_output_tokens: 100, previous_response_id: 'resp_0', store: true });
    expect(sent().data).toEqual({ model: 'grok-4.3', input: 'Hi', tools: [{ type: 'code_interpreter' }], reasoning: { effort: 'low' }, max_output_tokens: 100, previous_response_id: 'resp_0', store: true });
  });

  it('searches the web and X with the server-side tools, not Live Search', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('xai_web_search', { input: 'EU AI Act news', allowed_domains: ['europa.eu'] });
    expect(sent().data).toEqual({ model: 'grok-4.3', input: 'EU AI Act news', store: false, tools: [{ type: 'web_search', allowed_domains: ['europa.eu'] }] });
    expect(sent().data.search_parameters).toBeUndefined();
    mockedAxios.mockClear();
    await call('xai_x_search', { input: 'What did they post?', allowed_x_handles: ['xai'], from_date: '2026-10-01', to_date: '2026-10-14' });
    expect(sent().data).toEqual({ model: 'grok-4.3', input: 'What did they post?', store: false, tools: [{ type: 'x_search', allowed_x_handles: ['xai'], from_date: '2026-10-01', to_date: '2026-10-14' }] });
  });

  it('starts a deferred chat completion and asks pictures as base64', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const messages = [{ role: 'user', content: 'Think hard' }];
    await call('xai_start_deferred_completion', { messages, reasoning_effort: 'high' });
    expect(sent().data).toEqual({ model: 'grok-4.3', messages, reasoning_effort: 'high', deferred: true });
    mockedAxios.mockClear();
    await call('xai_generate_image', { prompt: 'a cat', aspect_ratio: '16:9' });
    expect(sent().data).toEqual({ model: 'grok-imagine-image', prompt: 'a cat', n: 1, aspect_ratio: '16:9', resolution: '1k', response_format: 'b64_json' });
    mockedAxios.mockClear();
    await call('xai_edit_image', { prompt: 'blue', image_url: 'https://example.com/a.png' });
    expect(sent().data).toEqual({ model: 'grok-imagine-image', prompt: 'blue', image: { url: 'https://example.com/a.png' }, n: 1, response_format: 'b64_json' });
    mockedAxios.mockClear();
    await call('xai_tokenize_text', { text: 'Hello' });
    expect(sent().data).toEqual({ text: 'Hello', model: 'grok-4.3' });
  });

  it('shapes a search answer into text, citations and cost', () => {
    const out = shape('xai_web_search', {
      id: 'resp_1',
      object: 'response',
      model: 'grok-4.3',
      status: 'completed',
      output: [
        { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'x' } },
        { type: 'reasoning', id: 'r', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The answer.', annotations: [{ type: 'url_citation', url: 'https://example.com/a', title: 'A' }] }] },
      ],
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, output_tokens_details: { reasoning_tokens: 5 }, num_sources_used: 3, server_side_tool_usage_details: { web_search_calls: 1 }, cost_in_usd_ticks: 4200000 },
      tools: [{ type: 'web_search' }],
      error: null,
    });
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual({
      id: 'resp_1',
      model: 'grok-4.3',
      status: 'completed',
      output_text: 'The answer.',
      citations: ['https://example.com/a'],
      usage: { input_tokens: 100, output_tokens: 20, reasoning_tokens: 5, num_sources_used: 3, server_side_tool_usage_details: { web_search_calls: 1 }, cost_in_usd_ticks: 4200000 },
    });
  });

  it('shapes a pending and a finished deferred completion', () => {
    expect(shape('xai_get_deferred_completion', '').value).toEqual({ pending: true });
    const done = shape('xai_get_deferred_completion', {
      id: 'c1',
      model: 'grok-4.3',
      choices: [{ index: 0, message: { role: 'assistant', content: '42', reasoning_content: 'thinking' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    });
    expect(done.value).toEqual({ id: 'c1', model: 'grok-4.3', answer: '42', reasoning: 'thinking', finish_reason: 'stop', usage: { prompt_tokens: 3, completion_tokens: 1 } });
  });

  it('hands a generated picture to the client as an image, not as base64 text', () => {
    // 1x1 PNG
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const out = shape('xai_generate_image', { data: [{ b64_json: png, mime_type: 'image/png' }], usage: { cost_in_usd_ticks: 200000000 } });
    expect(out.images?.[0].mimeType).toBe('image/png');
    expect(JSON.stringify(out.value)).not.toContain(png);
  });

  it('shapes the token count and the key info', () => {
    expect(shape('xai_tokenize_text', { token_ids: [{ token_id: 1, string_token: 'Hel', token_bytes: [1] }, { token_id: 2, string_token: 'lo', token_bytes: [2] }] }).value).toEqual({ token_count: 2, tokens: ['Hel', 'lo'] });
    const info = shape('xai_get_api_key_info', { redacted_api_key: 'xai-...b14o', user_id: 'u', name: 'k', team_id: 't', acls: ['api-key:model:*'], api_key_id: 'id', team_blocked: false, api_key_blocked: false, api_key_disabled: false, create_time: 'c', modify_time: 'm' });
    expect(info.value).toEqual({ redacted_api_key: 'xai-...b14o', name: 'k', team_id: 't', acls: ['api-key:model:*'], api_key_blocked: false, api_key_disabled: false, team_blocked: false, create_time: 'c' });
  });
});

const live = process.env.RUN_XAI_LIVE === '1' ? describe : describe.skip;
live('xai adapter: live', () => {
  const realKey = process.env.XAI_API_KEY;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  // xAI answers a wrong key with 400 "Incorrect API key provided" once the
  // body is valid, so every request here carries a valid body.
  it.each([
    ['xai_get_api_key_info', {}],
    ['xai_list_language_models', {}],
    ['xai_list_models', {}],
    ['xai_list_image_models', {}],
    ['xai_create_response', { input: 'Hi', max_output_tokens: 1 }],
    ['xai_web_search', { input: 'Hi', max_output_tokens: 1 }],
    ['xai_get_response', { response_id: 'resp_doesnotexist' }],
    ['xai_get_deferred_completion', { request_id: 'doesnotexist' }],
    ['xai_generate_image', { prompt: 'a red square' }],
    ['xai_tokenize_text', { text: 'Hello' }],
  ])('%s reaches a real route and xAI refuses a wrong key', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 400, data: { error: expect.stringMatching(/Incorrect API key/) } } });
  }, 30000);

  it('answers 404 on a made-up route', async () => {
    await expect(
      (mockedAxios.__actual as any).request({ url: `${BASE}/does-not-exist`, method: 'GET', headers: { Authorization: `Bearer ${FAKE_KEY}` } }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (realKey ? it : it.skip)('reads the key, the model lists and tokenizes a text (free)', async () => {
    const env = { XAI_API_KEY: realKey! };
    const run = async (name: string, params: Record<string, unknown> = {}) => {
      const out = shape(name, await call(name, params, env));
      expect(out.error).toBeUndefined();
      return out.value as any;
    };
    expect((await run('xai_get_api_key_info')).redacted_api_key).toMatch(/^xai-/);
    expect((await run('xai_list_language_models')).models.length).toBeGreaterThan(0);
    expect((await run('xai_list_image_models')).models.length).toBeGreaterThan(0);
    expect((await run('xai_tokenize_text', { text: 'Hello world' })).token_count).toBeGreaterThan(0);
  }, 60000);

  (realKey && process.env.XAI_LIVE_PAID === '1' ? it : it.skip)('asks grok-4.3 one short question (a fraction of a cent)', async () => {
    const env = { XAI_API_KEY: realKey! };
    const out = shape('xai_create_response', await call('xai_create_response', { input: 'Reply with the single word OK.', max_output_tokens: 20 }, env)).value as any;
    expect(typeof out.output_text).toBe('string');
  }, 60000);
});
