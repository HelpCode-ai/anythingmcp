import axios from 'axios';
import * as adapter from './higgsfield.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Higgsfield adapter (https://docs.higgsfield.ai/docs, checked 18 Oct 2026).
 *
 *   1. Static: always runs. Pins the `Authorization: Key <id>:<secret>` header
 *      on api.higgsfield.ai, a free probe, every tool's method and URL, which
 *      tools start a billed generation, and the request bodies (the generic
 *      tools send the model's input as the body itself; the Kling tier is part
 *      of the path, not of the body). axios is mocked: nothing leaves the box.
 *
 *   2. Live: RUN_HIGGSFIELD_LIVE=1 only checks, with a made-up key, that the
 *      documented read endpoints exist and refuse it with a JSON 401 (an
 *      unknown path answers 405). It never submits a generation:
 *
 *        RUN_HIGGSFIELD_LIVE=1 npx jest src/adapters/intl/higgsfield.live.spec.ts
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
  parameters: { properties?: Record<string, { default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
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

// Built at run time so nothing here looks like a real credential.
const KEY_ID = 'kid' + 'x'.repeat(12);
const KEY_SECRET = 'sec' + 'y'.repeat(24);
const ENV = { HIGGSFIELD_API_KEY_ID: KEY_ID, HIGGSFIELD_API_KEY_SECRET: KEY_SECRET };
const BASE = 'https://api.higgsfield.ai';
const RID = '00000000-0000-4000-8000-000000000000';
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return engine().execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep({ ...a.connector.authConfig }, env), headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, params);
const sent = () => mockedAxios.mock.calls[0][0];
const bodyOf = () => {
  const d = sent().data;
  return typeof d === 'string' ? JSON.parse(d) : d;
};

const FREE = [
  'higgsfield_get_request_status',
  'higgsfield_estimate_cost',
  'higgsfield_list_soul_styles',
  'higgsfield_list_marketing_presets',
  'higgsfield_list_soul_ids',
  'higgsfield_get_soul_id',
];
const BILLED = [
  'higgsfield_generate',
  'higgsfield_soul_image',
  'higgsfield_marketing_studio_image',
  'higgsfield_ads_studio',
  'higgsfield_seedance_text_to_video',
  'higgsfield_seedance_image_to_video',
  'higgsfield_seedance_reference_to_video',
  'higgsfield_kling_text_to_video',
  'higgsfield_kling_image_to_video',
  'higgsfield_cinema_studio_video',
];

describe('higgsfield adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends key ID and secret as Authorization: Key <id>:<secret> to api.higgsfield.ai', async () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({
      headerName: 'Authorization',
      apiKey: 'Key {{HIGGSFIELD_API_KEY_ID}}:{{HIGGSFIELD_API_KEY_SECRET}}',
    });
    mockedAxios.mockResolvedValue({ data: [] });
    await call('higgsfield_list_soul_styles', {});
    expect(sent().headers.Authorization).toBe(`Key ${KEY_ID}:${KEY_SECRET}`);
    expect(JSON.stringify(sent().params ?? {})).not.toContain(KEY_SECRET);
    expect(String(sent().url)).not.toContain(KEY_SECRET);
  });

  it('keeps key ID and secret apart and marks the secret as secret', () => {
    expect(a.requiredEnvVars).toEqual(['HIGGSFIELD_API_KEY_ID', 'HIGGSFIELD_API_KEY_SECRET']);
    const id = new RegExp(a.envVarMeta.HIGGSFIELD_API_KEY_ID.pattern!);
    expect(id.test(KEY_ID)).toBe(true);
    expect(id.test(`${KEY_ID}:${KEY_SECRET}`)).toBe(false);
    expect(id.test(`Key ${KEY_ID}`)).toBe(false);
    const secret = describeAdapterEnvVars(a as never).find((d) => d.name === 'HIGGSFIELD_API_KEY_SECRET')!;
    expect(secret.secret).toBe(true);
  });

  it('probes with a free GET that can never start a generation', () => {
    expect(a.probe).toEqual({ tool: 'higgsfield_list_soul_styles' });
    expect(tool(a.probe.tool).endpointMapping).toEqual({ method: 'GET', path: '/v1/text2image/soul-styles/v2' });
    expect(a.connector.healthcheckPath).toBe('/v1/text2image/soul-styles/v2');
  });

  it('prefixes every tool with higgsfield_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    expect([...mine].sort()).toEqual([...FREE, ...BILLED, 'higgsfield_cancel_request'].sort());
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('says on every billed tool that it costs credits and must be confirmed', () => {
    for (const name of BILLED) {
      const t = tool(name);
      expect(`${name}:${t.endpointMapping.method}`).toBe(`${name}:POST`);
      expect(t.description).toMatch(/COSTS CREDITS/);
      expect(t.description).toMatch(/confirm/i);
      expect(t.parameters.properties).toHaveProperty('idempotency_key');
      expect(t.endpointMapping.headers).toEqual({ 'Idempotency-Key': '$idempotency_key' });
      const ann = annotationsOf(t);
      expect(`${name}:${ann.readOnlyHint}`).toBe(`${name}:false`);
    }
    for (const name of FREE) {
      expect(tool(name).description).toMatch(/Free|costs nothing/);
      expect(`${name}:${annotationsOf(tool(name)).readOnlyHint}`).toBe(`${name}:true`);
    }
    expect(a.instructions).toMatch(/spends the user's Higgsfield credits/);
    expect(a.instructions).toMatch(/higgsfield_estimate_cost/);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bhiggsfield_[a-z_0-9]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bhiggsfield_[a-z_0-9]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['higgsfield_get_request_status', { request_id: RID }, 'GET', `${BASE}/requests/${RID}/status`],
    ['higgsfield_cancel_request', { request_id: RID }, 'POST', `${BASE}/requests/${RID}/cancel`],
    ['higgsfield_estimate_cost', { model_id: 'higgsfield-ai/soul/v2/standard', input: { prompt: 'x' } }, 'POST', `${BASE}/estimate/higgsfield-ai/soul/v2/standard`],
    ['higgsfield_generate', { model_id: 'wan/v2.7/text-to-video', input: { prompt: 'x' } }, 'POST', `${BASE}/wan/v2.7/text-to-video`],
    ['higgsfield_list_soul_styles', {}, 'GET', `${BASE}/v1/text2image/soul-styles/v2`],
    ['higgsfield_list_marketing_presets', {}, 'GET', `${BASE}/marketing-studio/image/presets`],
    ['higgsfield_list_soul_ids', {}, 'GET', `${BASE}/v1/custom-references/list`],
    ['higgsfield_get_soul_id', { reference_id: RID }, 'GET', `${BASE}/v1/custom-references/${RID}`],
    ['higgsfield_soul_image', { prompt: 'x' }, 'POST', `${BASE}/higgsfield-ai/soul/v2/standard`],
    ['higgsfield_marketing_studio_image', { prompt: 'x' }, 'POST', `${BASE}/marketing-studio/image`],
    ['higgsfield_ads_studio', { prompt: 'x' }, 'POST', `${BASE}/higgsfield/ads-studio/v1.0`],
    ['higgsfield_seedance_text_to_video', { prompt: 'x' }, 'POST', `${BASE}/bytedance/seedance-2.5/text-to-video`],
    ['higgsfield_seedance_image_to_video', { image_url: 'https://example.com/a.jpg' }, 'POST', `${BASE}/bytedance/seedance-2.5/image-to-video`],
    ['higgsfield_seedance_reference_to_video', { image_urls: ['https://example.com/a.jpg'] }, 'POST', `${BASE}/bytedance/seedance-2.5/reference-to-video`],
    ['higgsfield_kling_text_to_video', { prompt: 'x' }, 'POST', `${BASE}/kling-video/v3.0/pro/text-to-video`],
    ['higgsfield_kling_image_to_video', { prompt: 'x', image_url: 'https://example.com/a.jpg', tier: '4k' }, 'POST', `${BASE}/kling-video/v3.0/4k/image-to-video`],
    ['higgsfield_cinema_studio_video', { prompt: 'x' }, 'POST', `${BASE}/higgsfield/cinema-studio/4.0`],
  ];
  it.each(table)('%s calls %s %s', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(sent().method.toUpperCase()).toBe(method);
    expect(sent().url).toBe(url);
  });

  it('sends the model input itself as the body of the generic tools', async () => {
    mockedAxios.mockResolvedValue({ data: { credits: '1.500', usd: '0.094' } });
    await call('higgsfield_estimate_cost', { model_id: 'higgsfield-ai/soul/v2/standard', input: { prompt: 'lake', aspect_ratio: '16:9' } });
    expect(bodyOf()).toEqual({ prompt: 'lake', aspect_ratio: '16:9' });
  });

  it('sends the Idempotency-Key header only when one is given', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('higgsfield_seedance_text_to_video', { prompt: 'x', idempotency_key: 'k-1' });
    expect(sent().headers['Idempotency-Key']).toBe('k-1');
    expect(bodyOf()).not.toHaveProperty('idempotency_key');
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('higgsfield_seedance_text_to_video', { prompt: 'x' });
    expect(sent().headers['Idempotency-Key']).toBeUndefined();
  });

  it('puts the Kling tier in the path and only documented fields in the body', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('higgsfield_kling_text_to_video', { prompt: 'x', tier: 'std', duration: 10 });
    expect(sent().url).toBe(`${BASE}/kling-video/v3.0/std/text-to-video`);
    const body = bodyOf();
    expect(body).not.toHaveProperty('tier');
    expect(body).toMatchObject({ prompt: 'x', duration: 10, sound: 'on' });
  });

  it('keeps output_format off image-to-video, whose documented schema has none', () => {
    expect(tool('higgsfield_seedance_text_to_video').parameters.properties).toHaveProperty('output_format');
    expect(tool('higgsfield_seedance_image_to_video').parameters.properties).not.toHaveProperty('output_format');
  });
});

const maybe = process.env.RUN_HIGGSFIELD_LIVE ? describe : describe.skip;
maybe('higgsfield adapter: live edge reachability (bogus key, no generation)', () => {
  const real = () => mockedAxios.__actual;
  const reads: Array<[string, string]> = [
    ['GET', `/requests/${RID}/status`],
    ['GET', '/v1/text2image/soul-styles/v2'],
    ['GET', '/marketing-studio/image/presets'],
    ['GET', '/v1/custom-references/list'],
  ];
  it.each(reads)('%s %s exists and refuses a bogus key with a JSON 401', async (method, path) => {
    const res = await real().request({
      method,
      url: `${BASE}${path}`,
      headers: { Authorization: 'Key bogus:bogus', Accept: 'application/json' },
      validateStatus: () => true,
      timeout: 20000,
    });
    expect(res.status).toBe(401);
    expect(res.data).toEqual({ detail: 'Invalid credentials' });
  }, 30000);
});
