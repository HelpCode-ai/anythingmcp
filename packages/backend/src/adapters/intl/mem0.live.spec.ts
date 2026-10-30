import axios from 'axios';
import * as adapter from './mem0.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

/**
 * Mem0 Platform API (OpenAPI at https://docs.mem0.ai/openapi.json, reference
 * https://docs.mem0.ai/api-reference, the mem0-ts client for paths and paging),
 * checked on 30 Oct 2026: base https://api.mem0.ai, `Authorization: Token <key>`.
 * Add, search and list use the v3 endpoints (entity ids inside `filters` for
 * search and list); single memories, history and events are v1, entities v2.
 *
 * Static part: always runs, through the real RestEngine with axios mocked.
 * Live part (reads only: ping, stats, entities, events):
 *   RUN_MEM0_LIVE=1 MEM0_API_KEY=... npx jest src/adapters/intl/mem0
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
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; headers?: Record<string, string> };
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

const BASE = 'https://api.mem0.ai';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['m0', '-', 'Qw7'.repeat(13)].join('');
const ENV: Record<string, string> = { MEM0_API_KEY: FAKE_KEY };

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

const SWITCHED_OFF = ['mem0_delete_entity', 'mem0_delete_memory'];
const WRITES = ['mem0_add_memories', 'mem0_create_user', 'mem0_update_memory', ...SWITCHED_OFF];

describe('mem0 adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the key as "Authorization: Token <key>" to api.mem0.ai and checks it on /v1/ping/', async () => {
    expect(a.requiredEnvVars).toEqual(['MEM0_API_KEY']);
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'Token {{MEM0_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/v1/ping/');
    expect(a.envVarMeta.MEM0_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    const re = new RegExp(a.envVarMeta.MEM0_API_KEY.pattern!);
    expect(re.test(FAKE_KEY)).toBe(true);
    expect(re.test(`Token ${FAKE_KEY}`)).toBe(false);
    ok();
    await call('mem0_ping', {});
    expect(sent().url).toBe(`${BASE}/v1/ping/`);
    expect(sent().headers.Authorization).toBe(`Token ${FAKE_KEY}`);
  });

  it('maps every tool to the documented method and path, with the trailing slashes Mem0 requires', () => {
    const table = Object.fromEntries(a.tools.map((t) => [t.name, `${t.endpointMapping.method} ${t.endpointMapping.path}`]));
    expect(table).toEqual({
      mem0_ping: 'GET /v1/ping/',
      mem0_add_memories: 'POST /v3/memories/add/',
      mem0_search_memories: 'POST /v3/memories/search/',
      mem0_list_memories: 'POST /v3/memories/',
      mem0_get_memory: 'GET /v1/memories/{memory_id}/',
      mem0_update_memory: 'PUT /v1/memories/{memory_id}/',
      mem0_get_memory_history: 'GET /v1/memories/{memory_id}/history/',
      mem0_list_entities: 'GET /v1/entities/',
      mem0_get_entity: 'GET /v2/entities/{entity_type}/{entity_id}/',
      mem0_get_user_profile: 'GET /v2/entities/user/{user_id}/profile/',
      mem0_create_user: 'POST /v1/users/',
      mem0_list_events: 'GET /v1/events/',
      mem0_get_event: 'GET /v1/event/{event_id}/',
      mem0_get_stats: 'GET /v1/stats/',
      mem0_delete_memory: 'DELETE /v1/memories/{memory_id}/',
      mem0_delete_entity: 'DELETE /v2/entities/{entity_type}/{entity_id}/',
    });
    for (const t of a.tools) expect(t.endpointMapping.path.endsWith('/')).toBe(true);
  });

  it('adds with top-level entity ids, and searches and lists with them inside filters', async () => {
    ok();
    const messages = [{ role: 'user', content: 'I am vegetarian.' }];
    await call('mem0_add_memories', { messages, user_id: 'alice', metadata: { source: 'chat' } });
    expect(sent().data).toEqual({ messages, user_id: 'alice', metadata: { source: 'chat' } });
    mockedAxios.mockReset();
    ok();
    await call('mem0_search_memories', { query: 'diet?', filters: { user_id: 'alice' }, top_k: 5 });
    expect(sent().data).toEqual({ query: 'diet?', filters: { user_id: 'alice' }, top_k: 5 });
    for (const name of ['mem0_search_memories', 'mem0_list_memories']) {
      expect(tool(name).parameters?.required).toContain('filters');
      for (const id of ['user_id', 'agent_id', 'run_id']) expect(Object.keys(tool(name).parameters?.properties ?? {})).not.toContain(id);
    }
    mockedAxios.mockReset();
    ok();
    await call('mem0_list_memories', { filters: { user_id: 'alice' }, page: 2, keywords: 'food' });
    expect(sent().params).toEqual({ page: 2, page_size: 50 });
    expect(sent().data).toEqual({ filters: { user_id: 'alice' }, keywords: 'food' });
  });

  it('updates a memory with PUT and only the fields given', async () => {
    ok();
    await call('mem0_update_memory', { memory_id: 'm-1', text: 'Lives in Lyon' });
    expect(sent().method).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/v1/memories/m-1/`);
    expect(sent().data).toEqual({ text: 'Lives in Lyon' });
  });

  it('switches off exactly the two deletes, marks them destructive and names them in the instructions', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual(SWITCHED_OFF);
    for (const name of SWITCHED_OFF) {
      expect(tool(name).endpointMapping.method).toBe('DELETE');
      expect(annotationsOf(tool(name)).destructiveHint).toBe(true);
    }
    expect(a.instructions).toContain('**Switched off at install**: `mem0_delete_memory` and `mem0_delete_entity`; they cannot be undone');
    expect(a.instructions).toContain('so an admin switches them on when the team needs them.');
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.method} ${t.endpointMapping.path}`).not.toBe(`${t.name}:DELETE /v1/memories/`);
  });

  it('marks the POST search and list read-only, the other writes as writes, and every GET read-only', () => {
    for (const t of a.tools) {
      const ann = annotationsOf(t);
      if (WRITES.includes(t.name)) expect(`${t.name}:${ann.readOnlyHint}`).toBe(`${t.name}:false`);
      else expect(`${t.name}:${ann.readOnlyHint}`).toBe(`${t.name}:true`);
    }
    expect(annotationsOf(tool('mem0_add_memories')).destructiveHint).toBe(false);
    expect(annotationsOf(tool('mem0_create_user')).destructiveHint).toBe(false);
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name).toMatch(/^mem0_[a-z_]+$/);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [p, schema] of Object.entries(t.parameters?.properties ?? {})) expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('probes with a read tool and documents every tool in the instructions, without em dashes', () => {
    expect(a.probe).toEqual({ tool: 'mem0_ping' });
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [...a.instructions.matchAll(/\bmem0_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bmem0_[a-z_]+/g)])].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const live = process.env.RUN_MEM0_LIVE === '1' && process.env.MEM0_API_KEY ? describe : describe.skip;
live('mem0 adapter: live (reads only)', () => {
  const real = mockedAxios.__actual;
  const get = async (path: string) => {
    const res = await real.get(`${BASE}${path}`, { headers: { Authorization: `Token ${process.env.MEM0_API_KEY}`, ...a.connector.headers }, validateStatus: () => true });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return res.data as Record<string, any>;
  };
  it('pings and reads stats, entities and events', async () => {
    expect(await get('/v1/ping/')).toHaveProperty('org_id');
    expect(await get('/v1/stats/')).toHaveProperty('total_memories');
    expect(Array.isArray((await get('/v1/entities/')).results)).toBe(true);
    expect(Array.isArray((await get('/v1/events/')).results)).toBe(true);
  }, 60_000);
});
