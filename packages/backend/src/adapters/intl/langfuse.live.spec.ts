import axios from 'axios';
import * as adapter from './langfuse.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

/**
 * Langfuse Public API (OpenAPI at https://cloud.langfuse.com/generated/api/openapi.yml,
 * reference https://api.reference.langfuse.com, migration guide
 * https://langfuse.com/faq/all/deprecated-api-migration), checked on 30 Oct 2026:
 * base <host>/api/public, HTTP Basic auth with the public key as user name and
 * the secret key as password. Traces, sessions and daily metrics are read
 * through Observations API v2 and Metrics API v2: the v1 /traces, /sessions
 * and /metrics/daily endpoints are deprecated (Cloud serves them until 2026-11-16).
 *
 * Static part: always runs, through the real RestEngine with axios mocked.
 * Live part (reads only: health, project, observations, prompts, datasets, scores):
 *   RUN_LANGFUSE_LIVE=1 LANGFUSE_HOST=https://cloud.langfuse.com LANGFUSE_PUBLIC_KEY=pk-lf-... LANGFUSE_SECRET_KEY=sk-lf-... \
 *   npx jest src/adapters/intl/langfuse
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
  parameters?: { properties?: Record<string, { description?: string; default?: unknown; enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; encodePathParams?: boolean; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, string> };
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

const HOST = 'https://cloud.langfuse.com';
// Built at runtime so no literal looks like a real credential.
const PK = ['pk', 'lf', '0a1b2c3d-0000-4000-8000-00000000abcd'].join('-');
const SK = ['sk', 'lf', '9f8e7d6c-0000-4000-8000-00000000dcba'].join('-');
const ENV: Record<string, string> = { LANGFUSE_HOST: HOST, LANGFUSE_PUBLIC_KEY: PK, LANGFUSE_SECRET_KEY: SK };

const call = (name: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, tool(name).endpointMapping as never, ENV);
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, ENV), headers: config.headers } as never,
    endpointMapping as never,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  ) as Promise<unknown>;
};
const sent = () => mockedAxios.mock.calls[0][0];
const ok = () => mockedAxios.mockResolvedValue({ data: {}, status: 200, headers: {} });

const WRITES = ['langfuse_create_dataset', 'langfuse_create_prompt_version', 'langfuse_create_score', 'langfuse_update_prompt_labels', 'langfuse_upsert_dataset_item'];

describe('langfuse adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('uses Basic auth with the public key as user and the secret key as password on <host>/api/public', async () => {
    expect(a.requiredEnvVars).toEqual(['LANGFUSE_HOST', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY']);
    expect(a.connector.baseUrl).toBe('{{LANGFUSE_HOST}}/api/public');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{LANGFUSE_PUBLIC_KEY}}', password: '{{LANGFUSE_SECRET_KEY}}' });
    expect(a.envVarMeta.LANGFUSE_SECRET_KEY).toMatchObject({ kind: 'credential', secret: true });
    expect(new RegExp(a.envVarMeta.LANGFUSE_PUBLIC_KEY.pattern!).test(PK)).toBe(true);
    expect(new RegExp(a.envVarMeta.LANGFUSE_SECRET_KEY.pattern!).test(SK)).toBe(true);
    expect(new RegExp(a.envVarMeta.LANGFUSE_SECRET_KEY.pattern!).test(PK)).toBe(false);
    ok();
    await call('langfuse_get_project', {});
    expect(sent().url).toBe(`${HOST}/api/public/projects`);
    const auth = sent().auth ?? {};
    const header = String(sent().headers.Authorization ?? '');
    const basic = header ? Buffer.from(header.replace(/^Basic /, ''), 'base64').toString('utf8') : `${auth.username}:${auth.password}`;
    expect(basic).toBe(`${PK}:${SK}`);
  });

  it('accepts every Langfuse Cloud region and a self-hosted address, without a trailing slash or path', () => {
    const re = new RegExp(a.envVarMeta.LANGFUSE_HOST.pattern!);
    for (const ok of ['https://cloud.langfuse.com', 'https://us.cloud.langfuse.com', 'https://jp.cloud.langfuse.com', 'https://hipaa.cloud.langfuse.com', 'https://langfuse.example.org', 'https://lf.example.org:8443']) expect(`${ok}:${re.test(ok)}`).toBe(`${ok}:true`);
    for (const bad of ['https://cloud.langfuse.com/', 'https://cloud.langfuse.com/api/public', 'http://cloud.langfuse.com', 'cloud.langfuse.com']) expect(`${bad}:${re.test(bad)}`).toBe(`${bad}:false`);
    for (const region of ['https://cloud.langfuse.com', 'https://us.cloud.langfuse.com', 'https://jp.cloud.langfuse.com', 'https://hipaa.cloud.langfuse.com']) expect(a.instructions).toContain(region);
  });

  it('maps every tool to the documented method and path, and never to the deprecated v1 trace, session or daily metric reads', () => {
    const table = Object.fromEntries(a.tools.map((t) => [t.name, `${t.endpointMapping.method} ${t.endpointMapping.path}`]));
    expect(table).toEqual({
      langfuse_get_project: 'GET /projects',
      langfuse_get_health: 'GET /health',
      langfuse_list_observations: 'GET /v2/observations',
      langfuse_get_trace: 'GET /v2/observations',
      langfuse_get_session: 'GET /v2/observations',
      langfuse_query_metrics: 'GET /v2/metrics',
      langfuse_list_scores: 'GET /v3/scores',
      langfuse_create_score: 'POST /scores',
      langfuse_list_score_configs: 'GET /score-configs',
      langfuse_list_prompts: 'GET /v2/prompts',
      langfuse_get_prompt: 'GET /v2/prompts/{prompt_name}',
      langfuse_create_prompt_version: 'POST /v2/prompts',
      langfuse_update_prompt_labels: 'PATCH /v2/prompts/{prompt_name}/versions/{version}',
      langfuse_list_datasets: 'GET /v2/datasets',
      langfuse_get_dataset: 'GET /v2/datasets/{dataset_name}',
      langfuse_create_dataset: 'POST /v2/datasets',
      langfuse_list_dataset_items: 'GET /dataset-items',
      langfuse_get_dataset_item: 'GET /dataset-items/{item_id}',
      langfuse_upsert_dataset_item: 'POST /dataset-items',
      langfuse_list_experiments: 'GET /experiments',
    });
    for (const t of a.tools) {
      expect(t.endpointMapping.path).not.toMatch(/^\/(traces|sessions|observations|metrics)(\/|$)/);
      expect(t.endpointMapping.path).not.toMatch(/^\/v2\/scores/);
    }
    expect(a.instructions).toContain('/api/public/mcp');
  });

  it('reads a trace and a session through Observations API v2 with camelCase filters', async () => {
    ok();
    await call('langfuse_get_trace', { trace_id: 't-1' });
    expect(sent().url).toBe(`${HOST}/api/public/v2/observations`);
    expect(sent().params).toEqual({ traceId: 't-1', fields: 'core,basic,time,io,model,usage,metrics,trace_context', limit: 200 });
    mockedAxios.mockReset();
    ok();
    await call('langfuse_get_session', { session_id: 's-1' });
    expect(sent().params).toEqual({ sessionId: 's-1', isRootObservation: true, fields: 'core,basic,io,usage,trace_context', limit: 100 });
    mockedAxios.mockReset();
    ok();
    const filter = JSON.stringify([{ type: 'string', column: 'traceName', operator: '=', value: 'chat' }]);
    await call('langfuse_list_observations', { from_start_time: '2026-10-01T00:00:00Z', to_start_time: '2026-10-02T00:00:00Z', type: 'GENERATION', user_id: 'u1', filter });
    expect(sent().params).toEqual({ fromStartTime: '2026-10-01T00:00:00Z', toStartTime: '2026-10-02T00:00:00Z', fields: 'core,basic,usage', type: 'GENERATION', userId: 'u1', filter, limit: 50 });
  });

  it('passes the metrics query as one JSON string', async () => {
    ok();
    const query = JSON.stringify({ view: 'observations', metrics: [{ measure: 'totalCost', aggregation: 'sum' }], fromTimestamp: '2026-10-01T00:00:00Z', toTimestamp: '2026-10-31T00:00:00Z' });
    await call('langfuse_query_metrics', { query });
    expect(sent().url).toBe(`${HOST}/api/public/v2/metrics`);
    expect(sent().params).toEqual({ query });
  });

  it('sends one score as a one-element list with only the fields given and the API source', async () => {
    ok();
    await call('langfuse_create_score', { name: 'correctness', value: 0.9, trace_id: 't-1', comment: 'good' });
    expect(sent().data).toEqual([{ name: 'correctness', value: 0.9, traceId: 't-1', comment: 'good', source: 'API' }]);
  });

  it('url-encodes prompt names with folders and maps prompt writes to the documented body fields', async () => {
    ok();
    await call('langfuse_get_prompt', { prompt_name: 'support/greeting', label: 'staging' });
    expect(sent().url).toBe(`${HOST}/api/public/v2/prompts/support%2Fgreeting`);
    expect(sent().params).toEqual({ label: 'staging' });
    mockedAxios.mockReset();
    ok();
    await call('langfuse_update_prompt_labels', { prompt_name: 'support/greeting', version: 4, new_labels: ['production'] });
    expect(sent().url).toBe(`${HOST}/api/public/v2/prompts/support%2Fgreeting/versions/4`);
    expect(sent().data).toEqual({ newLabels: ['production'] });
    mockedAxios.mockReset();
    ok();
    const prompt = [{ role: 'system', content: 'Be brief.' }];
    await call('langfuse_create_prompt_version', { name: 'support/greeting', type: 'chat', prompt, labels: ['staging'], commit_message: 'shorter' });
    expect(sent().data).toEqual({ name: 'support/greeting', type: 'chat', prompt, labels: ['staging'], commitMessage: 'shorter' });
    mockedAxios.mockReset();
    ok();
    await call('langfuse_upsert_dataset_item', { dataset_name: 'qa', input: { q: '2+2' }, expected_output: '4', item_id: 'i-1' });
    expect(sent().data).toEqual({ datasetName: 'qa', input: { q: '2+2' }, expectedOutput: '4', id: 'i-1' });
  });

  it('marks the five writes as writes, every GET read-only, and switches nothing off', () => {
    for (const t of a.tools) {
      const ann = annotationsOf(t);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      if (WRITES.includes(t.name)) expect(`${t.name}:${ann.readOnlyHint}`).toBe(`${t.name}:false`);
      else {
        expect(t.endpointMapping.method).toBe('GET');
        expect(`${t.name}:${ann.readOnlyHint}`).toBe(`${t.name}:true`);
      }
      expect(t.endpointMapping.method).not.toBe('DELETE');
    }
    expect(tool('langfuse_create_prompt_version').description).toMatch(/[Cc]onfirm/);
    expect(tool('langfuse_update_prompt_labels').description).toMatch(/[Cc]onfirm/);
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name).toMatch(/^langfuse_[a-z_]+$/);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [p, schema] of Object.entries(t.parameters?.properties ?? {})) expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('probes with a read tool and documents every tool in the instructions, without em dashes', () => {
    expect(a.probe).toEqual({ tool: 'langfuse_get_project' });
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [...a.instructions.matchAll(/\blangfuse_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\blangfuse_[a-z_]+/g)])].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const live = process.env.RUN_LANGFUSE_LIVE === '1' && process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY ? describe : describe.skip;
live('langfuse adapter: live (reads only)', () => {
  const real = mockedAxios.__actual;
  const host = process.env.LANGFUSE_HOST || HOST;
  const get = async (path: string) => {
    const res = await real.get(`${host}/api/public${path}`, {
      auth: { username: process.env.LANGFUSE_PUBLIC_KEY!, password: process.env.LANGFUSE_SECRET_KEY! },
      headers: a.connector.headers,
      validateStatus: () => true,
    });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return res.data as Record<string, any>;
  };
  it('reads health, the project, recent observations, prompts, datasets and scores', async () => {
    expect(await get('/health')).toMatchObject({ status: 'OK' });
    expect(Array.isArray((await get('/projects')).data)).toBe(true);
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
    expect(Array.isArray((await get(`/v2/observations?limit=5&fromStartTime=${from}&toStartTime=${to}`)).data)).toBe(true);
    expect(Array.isArray((await get('/v2/prompts?limit=5')).data)).toBe(true);
    expect(Array.isArray((await get('/v2/datasets?limit=5')).data)).toBe(true);
    expect(Array.isArray((await get('/v3/scores?limit=5')).data)).toBe(true);
  }, 60_000);
});
