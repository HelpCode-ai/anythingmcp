import axios from 'axios';
import * as adapter from './replicate.json';
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
 * Two layers of verification for the Replicate adapter:
 *
 *   1. Static: always runs. Pins Bearer auth on api.replicate.com/v1 and every
 *      tool's method, URL, headers and body through the real RestEngine,
 *      checked against Replicate's OpenAPI document
 *      (api.replicate.com/openapi.json, 1.0.0-a1, fetched 14 Oct 2026) and the
 *      official SDKs: GET /search (the replacement for QUERY /models), the
 *      official-model, version and deployment prediction routes, the
 *      Prefer: wait=n and Cancel-After headers, and the response shaping.
 *
 *   2. Live: skipped unless RUN_REPLICATE_LIVE=1. Without a token it checks
 *      that Replicate refuses a wrong one with 401 on every route. With
 *      REPLICATE_API_TOKEN it reads the account, searches, reads a model,
 *      collections, hardware, predictions and deployments (all free).
 *      REPLICATE_LIVE_PAID=1 also runs flux-schnell once (about $0.003):
 *
 *        RUN_REPLICATE_LIVE=1 REPLICATE_API_TOKEN=r8_... npx jest src/adapters/intl/replicate.live.spec.ts
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
  endpointMapping: { method: string; path: string; headers?: Record<string, string>; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
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

const BASE = 'https://api.replicate.com/v1';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = ['r8', '_', 'A'.repeat(18), '0'.repeat(19)].join('');
const ENV: Record<string, string> = { REPLICATE_API_TOKEN: FAKE_TOKEN };

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

const RUN_TOOLS = ['replicate_create_prediction', 'replicate_run_deployment', 'replicate_run_official_model'];
const READ_ONLY = [
  'replicate_get_account',
  'replicate_get_collection',
  'replicate_get_deployment',
  'replicate_get_model',
  'replicate_get_model_version',
  'replicate_get_prediction',
  'replicate_list_collections',
  'replicate_list_deployments',
  'replicate_list_hardware',
  'replicate_list_model_versions',
  'replicate_list_models',
  'replicate_list_predictions',
  'replicate_search',
];

describe('replicate adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor SDK and API spec on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('sends the token as Bearer, on api.replicate.com/v1, and checks it on /account', () => {
    expect(a.icon).toBe('replicate');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{REPLICATE_API_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/account');
    expect(a.requiredEnvVars).toEqual(['REPLICATE_API_TOKEN']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'REPLICATE_API_TOKEN', kind: 'credential', secret: true, required: true });
  });

  it('accepts an r8_ token and refuses pasted headers or spaces', () => {
    const re = new RegExp(a.envVarMeta.REPLICATE_API_TOKEN.pattern!);
    expect(re.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_TOKEN}`, `${FAKE_TOKEN} `, 'r8_short', 'sk-abcdefghijklmnopqrstuvwxyz']) expect(re.test(bad)).toBe(false);
  });

  it('probes with the free account read and explains the error codes', () => {
    expect(a.probe).toEqual({ tool: 'replicate_get_account' });
    for (const status of ['401', '402', '429']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('prefixes every tool with replicate_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^replicate_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only, runs additive writes and the cancel destructive', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name).sort();
    expect(readOnly).toEqual(READ_ONLY);
    for (const name of RUN_TOOLS) expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(annotationsOf(tool('replicate_cancel_prediction'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('asks the model to confirm before every paid run and says outputs expire', () => {
    for (const name of RUN_TOOLS) {
      expect(tool(name).description).toMatch(/COSTS MONEY/);
      expect(tool(name).description).toMatch(/[Cc]onfirm/);
      expect(tool(name).description).toMatch(/one hour/);
    }
    expect(tool('replicate_cancel_prediction').description).toMatch(/[Cc]onfirm/);
    expect(a.instructions).toMatch(/expire one hour/);
    expect(a.instructions).toMatch(/spends the user's own Replicate credit/);
  });

  it('keeps the sync wait inside the 30 second call limit', () => {
    for (const name of RUN_TOOLS) {
      const wait = tool(name).parameters.properties!.wait_seconds;
      expect(wait.default).toBe(20);
      expect(wait.maximum).toBeLessThanOrEqual(25);
      expect(tool(name).endpointMapping.headers).toEqual({ Prefer: 'wait=${wait_seconds}', 'Cancel-After': '$cancel_after' });
    }
  });

  it('only points the model at tools that exist, documents every tool and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\breplicate_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\breplicate_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('https://replicate.com/account/api-tokens');
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
      expect(tr).toBeDefined();
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.expression ?? tr.exclude ?? tr.include).toBeDefined();
    }
  });

  const ID = 'gm3qorzdhgbfurvjtvhg6dckhu';
  const VER = 'f2ab8a5bfe79f02f0789a146cf5e73d2a4ff2684a98c2b303d1e1ff3814271db';
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['replicate_search', { query: 'upscale' }, 'GET', `${BASE}/search`],
    ['replicate_list_models', {}, 'GET', `${BASE}/models`],
    ['replicate_get_model', { owner: 'black-forest-labs', name: 'flux-schnell' }, 'GET', `${BASE}/models/black-forest-labs/flux-schnell`],
    ['replicate_list_model_versions', { owner: 'acme', name: 'm' }, 'GET', `${BASE}/models/acme/m/versions`],
    ['replicate_get_model_version', { owner: 'acme', name: 'm', version_id: VER }, 'GET', `${BASE}/models/acme/m/versions/${VER}`],
    ['replicate_list_collections', {}, 'GET', `${BASE}/collections`],
    ['replicate_get_collection', { slug: 'text-to-image' }, 'GET', `${BASE}/collections/text-to-image`],
    ['replicate_run_official_model', { owner: 'black-forest-labs', name: 'flux-schnell', input: { prompt: 'x' } }, 'POST', `${BASE}/models/black-forest-labs/flux-schnell/predictions`],
    ['replicate_create_prediction', { version: `acme/m:${VER}`, input: { a: 1 } }, 'POST', `${BASE}/predictions`],
    ['replicate_get_prediction', { prediction_id: ID }, 'GET', `${BASE}/predictions/${ID}`],
    ['replicate_list_predictions', {}, 'GET', `${BASE}/predictions`],
    ['replicate_cancel_prediction', { prediction_id: ID }, 'POST', `${BASE}/predictions/${ID}/cancel`],
    ['replicate_list_deployments', {}, 'GET', `${BASE}/deployments`],
    ['replicate_get_deployment', { owner: 'acme', name: 'img' }, 'GET', `${BASE}/deployments/acme/img`],
    ['replicate_run_deployment', { owner: 'acme', name: 'img', input: { prompt: 'x' } }, 'POST', `${BASE}/deployments/acme/img/predictions`],
    ['replicate_get_account', {}, 'GET', `${BASE}/account`],
    ['replicate_list_hardware', {}, 'GET', `${BASE}/hardware`],
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

  it('searches with GET /search and a limit of 10 by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('replicate_search', { query: 'remove background' });
    expect(sent().params).toEqual({ query: 'remove background', limit: 10 });
  });

  it('runs an official model with Prefer: wait=20 and only the documented body fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('replicate_run_official_model', { owner: 'black-forest-labs', name: 'flux-schnell', input: { prompt: 'a red bicycle' } });
    expect(sent().headers.Prefer).toBe('wait=20');
    expect(sent().headers['Cancel-After']).toBeUndefined();
    expect(sent().data).toEqual({ input: { prompt: 'a red bicycle' } });
    mockedAxios.mockClear();
    await call('replicate_run_official_model', {
      owner: 'black-forest-labs',
      name: 'flux-schnell',
      input: { prompt: 'x' },
      wait_seconds: 5,
      cancel_after: '2m',
      webhook: 'https://example.com/hook',
      webhook_events_filter: ['completed'],
    });
    expect(sent().headers.Prefer).toBe('wait=5');
    expect(sent().headers['Cancel-After']).toBe('2m');
    expect(sent().data).toEqual({ input: { prompt: 'x' }, webhook: 'https://example.com/hook', webhook_events_filter: ['completed'] });
  });

  it('creates a prediction by version and runs a deployment with the same headers', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('replicate_create_prediction', { version: `acme/m:${VER}`, input: { a: 1 } });
    expect(sent().data).toEqual({ version: `acme/m:${VER}`, input: { a: 1 } });
    expect(sent().headers.Prefer).toBe('wait=20');
    mockedAxios.mockClear();
    await call('replicate_run_deployment', { owner: 'acme', name: 'img', input: { prompt: 'x' }, cancel_after: '90s' });
    expect(sent().data).toEqual({ input: { prompt: 'x' } });
    expect(sent().headers['Cancel-After']).toBe('90s');
  });

  it('pages lists with the cursor from next and filters predictions by date', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('replicate_list_predictions', { created_after: '2026-10-01T00:00:00Z', cursor: 'cD0yMDI2' });
    expect(sent().params).toEqual({ created_after: '2026-10-01T00:00:00Z', cursor: 'cD0yMDI2' });
    mockedAxios.mockClear();
    await call('replicate_list_models', { sort_by: 'model_created_at' });
    expect(sent().params).toEqual({ sort_by: 'model_created_at' });
  });

  it('shapes a prediction: output and timing in, logs and input out', () => {
    const raw = {
      id: ID,
      model: 'black-forest-labs/flux-schnell',
      version: 'hidden',
      input: { prompt: 'x' },
      logs: 'a very long log',
      output: ['https://replicate.delivery/xezq/abc/out-0.webp'],
      data_removed: false,
      error: null,
      source: 'api',
      status: 'succeeded',
      created_at: '2026-10-14T10:00:00Z',
      started_at: '2026-10-14T10:00:01Z',
      completed_at: '2026-10-14T10:00:02Z',
      urls: { web: `https://replicate.com/p/${ID}`, get: 'g', cancel: 'c', stream: 's' },
      metrics: { predict_time: 0.9, total_time: 1.2 },
    };
    const out = shape('replicate_run_official_model', raw);
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual({
      id: ID,
      model: 'black-forest-labs/flux-schnell',
      version: 'hidden',
      status: 'succeeded',
      output: ['https://replicate.delivery/xezq/abc/out-0.webp'],
      predict_time: 0.9,
      total_time: 1.2,
      web_url: `https://replicate.com/p/${ID}`,
      created_at: '2026-10-14T10:00:00Z',
      started_at: '2026-10-14T10:00:01Z',
      completed_at: '2026-10-14T10:00:02Z',
      data_removed: false,
    });
  });

  it('shapes search results and a model with its input schema', () => {
    const search = shape('replicate_search', {
      query: 'flux',
      models: [{ model: { owner: 'black-forest-labs', name: 'flux-schnell', description: 'd', is_official: true, run_count: 5, url: 'u', latest_version: { openapi_schema: {} } }, metadata: { tags: ['image'], score: 0.9, generated_description: 'long' } }],
      collections: [{ name: 'T2I', slug: 'text-to-image', description: 'c', models: ['a/b'] }],
      pages: [{ name: 'Docs', href: 'https://replicate.com/docs' }],
    });
    expect(search.value).toEqual({
      query: 'flux',
      models: [{ owner: 'black-forest-labs', name: 'flux-schnell', description: 'd', is_official: true, run_count: 5, url: 'u', tags: ['image'], details: 'long' }],
      collections: [{ slug: 'text-to-image', name: 'T2I', description: 'c' }],
      pages: [{ name: 'Docs', href: 'https://replicate.com/docs' }],
    });
    const model = shape('replicate_get_model', {
      owner: 'o',
      name: 'n',
      is_official: false,
      run_count: 1,
      default_example: { input: { prompt: 'p' }, output: ['huge'], logs: 'l' },
      latest_version: { id: VER, created_at: 't', openapi_schema: { components: { schemas: { Input: { properties: { prompt: { type: 'string' } } }, Output: { type: 'array' } } } } },
    });
    expect(model.value).toEqual({
      owner: 'o',
      name: 'n',
      is_official: false,
      run_count: 1,
      latest_version_id: VER,
      latest_version_created_at: 't',
      input_schema: { properties: { prompt: { type: 'string' } } },
      output_schema: { type: 'array' },
      example_input: { prompt: 'p' },
    });
  });

  it('shapes hardware (a bare array) and deployments', () => {
    expect(shape('replicate_list_hardware', [{ name: 'Nvidia T4 GPU', sku: 'gpu-t4' }]).value).toEqual({ hardware: [{ sku: 'gpu-t4', name: 'Nvidia T4 GPU' }] });
    const deps = shape('replicate_list_deployments', {
      next: null,
      results: [{ owner: 'acme', name: 'img', current_release: { number: 2, model: 'a/b', version: VER, created_at: 't', created_by: {}, configuration: { hardware: 'gpu-t4', min_instances: 0, max_instances: 1 } } }],
    });
    expect(deps.value).toEqual({ next: null, deployments: [{ owner: 'acme', name: 'img', release: 2, model: 'a/b', version: VER, hardware: 'gpu-t4', min_instances: 0, max_instances: 1 }] });
  });
});

const live = process.env.RUN_REPLICATE_LIVE === '1' ? describe : describe.skip;
live('replicate adapter: live', () => {
  const realToken = process.env.REPLICATE_API_TOKEN;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  // Replicate authenticates before routing, so a wrong token gets 401 on any
  // path; these only prove the calls reach Replicate with the token attached.
  it.each([
    ['replicate_get_account', {}],
    ['replicate_search', { query: 'flux', limit: 1 }],
    ['replicate_get_model', { owner: 'black-forest-labs', name: 'flux-schnell' }],
    ['replicate_list_predictions', {}],
    ['replicate_list_deployments', {}],
    ['replicate_list_hardware', {}],
  ])('%s reaches Replicate and a wrong token is refused (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (realToken ? it : it.skip)('reads the account, searches and reads models, collections, hardware, predictions and deployments (free)', async () => {
    const env = { REPLICATE_API_TOKEN: realToken! };
    const run = async (name: string, params: Record<string, unknown> = {}) => {
      const out = shape(name, await call(name, params, env));
      expect(out.error).toBeUndefined();
      return out.value as any;
    };
    expect((await run('replicate_get_account')).username).toBeTruthy();
    expect((await run('replicate_search', { query: 'flux', limit: 2 })).models.length).toBeGreaterThan(0);
    const model = await run('replicate_get_model', { owner: 'black-forest-labs', name: 'flux-schnell' });
    expect(model.is_official).toBe(true);
    expect(model.input_schema.properties.prompt).toBeDefined();
    expect((await run('replicate_list_collections')).collections.length).toBeGreaterThan(0);
    expect((await run('replicate_list_hardware')).hardware.length).toBeGreaterThan(0);
    expect(Array.isArray((await run('replicate_list_predictions')).predictions)).toBe(true);
    expect(Array.isArray((await run('replicate_list_deployments')).deployments)).toBe(true);
  }, 120000);

  (realToken && process.env.REPLICATE_LIVE_PAID === '1' ? it : it.skip)('runs flux-schnell once and gets a replicate.delivery link (about $0.003)', async () => {
    const env = { REPLICATE_API_TOKEN: realToken! };
    const raw = await call('replicate_run_official_model', { owner: 'black-forest-labs', name: 'flux-schnell', input: { prompt: 'a small red square, flat', num_outputs: 1, megapixels: '0.25' } }, env);
    const out = shape('replicate_run_official_model', raw).value as any;
    expect(['succeeded', 'processing', 'starting']).toContain(out.status);
    if (out.status === 'succeeded') expect(String(out.output[0])).toMatch(/replicate\.delivery/);
  }, 60000);
});
