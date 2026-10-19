import axios from 'axios';
import * as adapter from './genapi.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the GenAPI adapter (gen-api.ru API v1):
 *
 *   1. Static: always runs. Pins the Bearer key on api.gen-api.ru/api/v1,
 *      every tool's method and URL through the real RestEngine against
 *      GenAPI's documentation, that every generation tool is marked as a
 *      paid write that asks for confirmation, and the generation bodies
 *      (the generic input merged as the body, Nano Banana fields, chat).
 *
 *   2. Live: skipped unless RUN_GENAPI_LIVE=1 and GENAPI_API_KEY are set.
 *      Free reads only: the account and the model list. Nothing generates.
 *
 *        RUN_GENAPI_LIVE=1 GENAPI_API_KEY=... npx jest src/adapters/intl/genapi.live.spec.ts
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
const KEY = ['sk-test-', 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34'].join('');
const BASE = 'https://api.gen-api.ru/api/v1';
const ENV = { GENAPI_API_KEY: KEY };
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

const WRITES: string[] = ["genapi_generate", "genapi_generate_image", "genapi_chat"];
const SWITCHED_OFF: string[] = [];
const READ_POSTS: string[] = [];

describe('genapi adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed under intl/data with its own icon', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('genapi');
    expect(a.region).toBe('intl');
    expect(a.icon).toBe('genapi');
    expect(a.category).toBe('data');
    expect(getAdapter('genapi')).toBeDefined();
  });

  it('sends the key as Bearer to api.gen-api.ru and probes the free account read', async () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{GENAPI_API_KEY}}' });
    expect(a.probe.tool).toBe('genapi_get_account');
    mockedAxios.mockResolvedValue({ data: { balance: 1 } });
    await call('genapi_get_account');
    expect(sent().headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it('asks for credentials as secrets with a pattern that refuses pasted prefixes', () => {
    for (const [name, meta] of Object.entries(a.envVarMeta)) {
      if (meta.kind === 'credential') expect(`${name}:${meta.secret}`).toBe(`${name}:true`);
      expect(meta.pattern).toBeDefined();
    }
    const described = describeAdapterEnvVars(a as never);
    for (const name of a.requiredEnvVars) expect(described.find((d) => d.name === name)).toBeDefined();
    const re = new RegExp(a.envVarMeta.GENAPI_API_KEY.pattern!);
    expect(re.test(KEY)).toBe(true);
    for (const bad of [`Bearer ${KEY}`, 'short', `${KEY} x`]) expect(re.test(bad)).toBe(false);
  });

  it('prefixes every tool with genapi_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^genapi_[a-z0-9_]+$/);
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
      ...a.instructions.matchAll(/\bgenapi_[a-z0-9_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgenapi_[a-z0-9_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(3);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## GenAPI\n')).toBe(true);
    expect(a.instructions).toContain('Out of scope');
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  // [tool, args, method, url]
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ["genapi_get_account", {}, "GET", `${BASE}/user`],
    ["genapi_list_models", {}, "GET", `${BASE}/networks`],
    ["genapi_get_request", {"request_id": 123}, "GET", `${BASE}/request/get/123`],
    ["genapi_generate", {"model": "flux-2", "input": {"prompt": "x"}}, "POST", `${BASE}/networks/flux-2`],
    ["genapi_generate_image", {"prompt": "x"}, "POST", `${BASE}/networks/nano-banana-2-1`],
    ["genapi_chat", {"model": "gpt-5-5", "messages": [{"role": "user", "content": "x"}]}, "POST", `${BASE}/networks/gpt-5-5`],
  ];

  it('lists every tool in the URL table', () => {
    expect([...new Set(table.map(([name]) => name))].sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s %s', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(sent().method.toUpperCase()).toBe(method);
    expect(sent().url).toBe(url);
  });

  it('marks every generation as costing money, priced from genapi_list_models, with confirmation', () => {
    for (const name of WRITES) {
      expect(tool(name).description).toMatch(/COSTS MONEY/);
      expect(tool(name).description).toContain('genapi_list_models');
      expect(annotationsOf(tool(name)).idempotentHint).toBe(false);
    }
    expect(a.instructions).toMatch(/wait for a yes/);
  });

  it('sends the generic input as the body itself, with the callback when given', async () => {
    mockedAxios.mockResolvedValue({ data: { request_id: 1, status: 'processing' } });
    await call('genapi_generate', { model: 'kling-video-v3', input: { prompt: 'sea', duration: 5 }, callback_url: 'https://example.com/cb' });
    expect(sent().data).toEqual({ prompt: 'sea', duration: 5, callback_url: 'https://example.com/cb' });
  });

  it('sends Nano Banana fields and a chat with is_sync on by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('genapi_generate_image', { prompt: 'cat', aspect_ratio: '1:1' });
    expect(sent().data).toEqual({ prompt: 'cat', aspect_ratio: '1:1', resolution: '1K', num_images: 1 });
    mockedAxios.mockClear();
    const messages = [{ role: 'user', content: 'Hi' }];
    await call('genapi_chat', { model: 'deepseek-chat', messages, max_tokens: 200 });
    expect(sent().data).toEqual({ messages, max_tokens: 200, is_sync: true });
  });

  it('keeps a model slug inside one path segment', async () => {
    expect(new RegExp(tool('genapi_generate').parameters.properties!.model.pattern).test('../user')).toBe(false);
    mockedAxios.mockResolvedValue({ data: {} });
    await call('genapi_get_request', { request_id: '1/../../user' });
    expect(sent().url).toBe(`${BASE}/request/get/1%2F..%2F..%2Fuser`);
  });
});

const LIVE_KEY = process.env.GENAPI_API_KEY;
const live = process.env.RUN_GENAPI_LIVE === '1' && LIVE_KEY ? describe : describe.skip;

live('genapi adapter: live API (free reads only, no generation)', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, { GENAPI_API_KEY: LIVE_KEY as string }, params);

  it('reads the account balance and the priced model list', async () => {
    expect(typeof (await run('genapi_get_account')).balance).toBe('number');
    const models = await run('genapi_list_models');
    expect(models.data.length).toBeGreaterThan(100);
    expect(models.data[0]).toHaveProperty('slug');
  }, 60_000);

  it('an unknown request id is a 404', async () => {
    await expect(run('genapi_get_request', { request_id: 1 })).rejects.toMatchObject({ response: { status: 404 } });
  }, 30_000);
});
