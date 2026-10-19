import axios from 'axios';
import * as adapter from './kie-ai.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Kie.ai adapter:
 *
 *   1. Static: always runs. Pins the Bearer key on api.kie.ai, every tool's
 *      method and URL through the real RestEngine against docs.kie.ai, the
 *      unified createTask bodies, that every generation is a paid write that
 *      asks for confirmation, and the errorWhen rules: Kie.ai answers HTTP 200
 *      with {code, msg} even for a wrong key or missing credits.
 *
 *   2. Live: skipped unless RUN_KIE_LIVE=1 and KIE_API_KEY are set. Free
 *      reads only: credits and prices. Nothing generates.
 *
 *        RUN_KIE_LIVE=1 KIE_API_KEY=... npx jest src/adapters/intl/kie-ai.live.spec.ts
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
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: { method: string; path: string; encodePathParams?: boolean; headers?: Record<string, string>; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath?: string; config?: { errorWhen?: unknown } };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

// Built at run time so no literal here looks like a real credential.
const KEY = ['0a1b2c3d4e5f', '60718293a4b5c6d7'].join('');
const BASE = 'https://api.kie.ai';
const ENV = { KIE_API_KEY: KEY };
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
  const c = interpolateDeep(a.connector, env) as typeof a.connector;
  return engine().execute(
    { baseUrl: c.baseUrl, authType: c.authType, authConfig: c.authConfig, headers: c.headers, errorWhen: c.config?.errorWhen },
    interpolateDeep(tool(name).endpointMapping, env) as Tool['endpointMapping'],
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown> = {}) => execute(name, ENV, params);
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES: string[] = ["kie_ai_create_task", "kie_ai_generate_image", "kie_ai_generate_gpt_image"];
const SWITCHED_OFF: string[] = [];
const READ_POSTS: string[] = ["kie_ai_search_pricing"];

describe('kie-ai adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed under intl/data with its own icon', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('kie-ai');
    expect(a.region).toBe('intl');
    expect(a.icon).toBe('kie-ai');
    expect(a.category).toBe('data');
    expect(getAdapter('kie-ai')).toBeDefined();
  });

  it('sends the key as Bearer to api.kie.ai and probes the free credit read', async () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{KIE_API_KEY}}' });
    expect(a.probe.tool).toBe('kie_ai_get_credits');
    mockedAxios.mockResolvedValue({ data: { code: 200, msg: 'success', data: 100 } });
    await call('kie_ai_get_credits');
    expect(sent().headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it('asks for credentials as secrets with a pattern that refuses pasted prefixes', () => {
    for (const [name, meta] of Object.entries(a.envVarMeta)) {
      if (meta.kind === 'credential') expect(`${name}:${meta.secret}`).toBe(`${name}:true`);
      expect(meta.pattern).toBeDefined();
    }
    const described = describeAdapterEnvVars(a as never);
    for (const name of a.requiredEnvVars) expect(described.find((d) => d.name === name)).toBeDefined();
    const re = new RegExp(a.envVarMeta.KIE_API_KEY.pattern!);
    expect(re.test(KEY)).toBe(true);
    for (const bad of [`Bearer ${KEY}`, 'short', `${KEY} x`]) expect(re.test(bad)).toBe(false);
  });

  it('prefixes every tool with kie_ai_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^kie_ai_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
    expect(mine.has(a.probe.tool)).toBe(true);
  });

  it('marks reads read-only, every write as a write with a confirmation, and installs the risky ones switched off', () => {
    for (const t of a.tools) {
      const read = t.endpointMapping.method === 'GET' || READ_POSTS.includes(t.name);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${read}`);
    }
    expect(a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort()).toEqual([...WRITES].sort());
    for (const name of WRITES) expect(`${name}:${/confirm|wait for a yes/i.test(tool(name).description)}`).toBe(`${name}:true`);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...SWITCHED_OFF].sort());
    expect(annotationsOf(tool(a.probe.tool)).readOnlyHint).toBe(true);
  });

  it('URL-encodes path parameters, so an id cannot reach another route', () => {
    for (const t of a.tools.filter((x) => /\{[a-z_]+\}/.test(x.endpointMapping.path))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bkie_ai_[a-z0-9_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bkie_ai_[a-z0-9_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(3);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Kie.ai\n')).toBe(true);
    expect(a.instructions).toContain('Out of scope');
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  // [tool, args, method, url]
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ["kie_ai_get_credits", {}, "GET", `${BASE}/api/v1/chat/credit`],
    ["kie_ai_search_pricing", {"search": "veo"}, "POST", `${BASE}/client/v1/model-pricing/page`],
    ["kie_ai_get_task", {"task_id": "t1"}, "GET", `${BASE}/api/v1/jobs/recordInfo`],
    ["kie_ai_create_task", {"model": "veo-3-1", "input": {"prompt": "x"}}, "POST", `${BASE}/api/v1/jobs/createTask`],
    ["kie_ai_generate_image", {"prompt": "x"}, "POST", `${BASE}/api/v1/jobs/createTask`],
    ["kie_ai_generate_gpt_image", {"prompt": "x"}, "POST", `${BASE}/api/v1/jobs/createTask`],
  ];

  it('lists every tool in the URL table', () => {
    expect([...new Set(table.map(([name]) => name))].sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s %s', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: { code: 200, msg: 'success', data: {} } });
    await call(name, params);
    expect(sent().method.toUpperCase()).toBe(method);
    expect(sent().url).toBe(url);
  });

  it('marks every generation as spending credits, priced with kie_ai_search_pricing, with confirmation', () => {
    for (const name of WRITES) {
      expect(tool(name).description).toMatch(/SPENDS CREDITS/);
      expect(tool(name).description).toContain('kie_ai_search_pricing');
    }
    expect(WRITES.sort()).toEqual(['kie_ai_create_task', 'kie_ai_generate_gpt_image', 'kie_ai_generate_image']);
  });

  it('builds the unified createTask bodies', async () => {
    mockedAxios.mockResolvedValue({ data: { code: 200, msg: 'success', data: { taskId: 't' } } });
    await call('kie_ai_create_task', { model: 'veo-3-1', input: { prompt: 'sea', aspect_ratio: '16:9' } });
    expect(sent().data).toEqual({ model: 'veo-3-1', input: { prompt: 'sea', aspect_ratio: '16:9' } });
    mockedAxios.mockClear();
    await call('kie_ai_generate_image', { prompt: 'cat' });
    expect(sent().data).toEqual({ model: 'google/nano-banana', input: { prompt: 'cat', image_size: '1:1', output_format: 'png' } });
    mockedAxios.mockClear();
    await call('kie_ai_generate_gpt_image', { prompt: 'cat', resolution: '2K' });
    expect(sent().data).toEqual({ model: 'gpt-image-2-text-to-image', input: { prompt: 'cat', aspect_ratio: 'auto', resolution: '2K' } });
  });

  it('polls by taskId and searches prices without sending empty filters', async () => {
    mockedAxios.mockResolvedValue({ data: { code: 200, msg: 'success', data: {} } });
    await call('kie_ai_get_task', { task_id: 'abc' });
    expect(sent().params).toEqual({ taskId: 'abc' });
    mockedAxios.mockClear();
    await call('kie_ai_search_pricing', {});
    expect(sent().data).toEqual({ pageNum: 1, pageSize: 30 });
  });

  it.each([
    [401, 401],
    [402, 402],
    [422, 422],
    [429, 429],
    [455, 502],
    [501, 502],
  ])('turns body code %s in an HTTP 200 into an error with status %s', async (code, status) => {
    mockedAxios.mockResolvedValue({ data: { code, msg: 'refused' } });
    await expect(call('kie_ai_get_credits')).rejects.toMatchObject({ status });
  });
});

const LIVE_KEY = process.env.KIE_API_KEY;
const live = process.env.RUN_KIE_LIVE === '1' && LIVE_KEY ? describe : describe.skip;

live('kie-ai adapter: live API (free reads only, no generation)', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, { KIE_API_KEY: LIVE_KEY as string }, params);

  it('reads the credits and a price page', async () => {
    expect(typeof (await run('kie_ai_get_credits')).data).toBe('number');
    expect(Array.isArray((await run('kie_ai_search_pricing', { search: 'nano banana', page_size: 3 })).data.records)).toBe(true);
  }, 60_000);

  it('an unknown task id is refused with 422', async () => {
    await expect(run('kie_ai_get_task', { task_id: 'nonexistent-task-0000' })).rejects.toMatchObject({ status: 422 });
  }, 30_000);
});
