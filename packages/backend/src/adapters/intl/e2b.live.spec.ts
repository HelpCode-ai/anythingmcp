import axios from 'axios';
import * as adapter from './e2b.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * E2B control-plane API (OpenAPI at
 * https://raw.githubusercontent.com/e2b-dev/E2B/main/spec/openapi.yml, reference
 * https://e2b.dev/docs/api-reference), checked on 30 Oct 2026: base
 * https://api.e2b.app, team API key in `X-API-Key`. Lists page with the
 * X-Next-Token response header. Running code (envd on <port>-<sandboxID>.e2b.app)
 * is a per-sandbox host with its own token and streamed output, so it is not mapped.
 *
 * Static part: always runs, through the real RestEngine with axios mocked.
 * Live part (reads only: sandboxes, templates, default templates, snapshots):
 *   RUN_E2B_LIVE=1 E2B_API_KEY=e2b_... npx jest src/adapters/intl/e2b
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
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; headers?: Record<string, string>; exposeHeaders?: string[] };
  responseMapping?: Record<string, unknown>;
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

const BASE = 'https://api.e2b.app';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = ['e2b', '_', '0f'.repeat(20)].join('');
const ENV: Record<string, string> = { E2B_API_KEY: FAKE_KEY };

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

const SWITCHED_OFF = ['e2b_kill_sandbox'];
const PAID = ['e2b_create_sandbox', 'e2b_resume_sandbox'];
const WRITES = ['e2b_create_sandbox', 'e2b_kill_sandbox', 'e2b_pause_sandbox', 'e2b_resume_sandbox', 'e2b_set_sandbox_timeout'];

describe('e2b adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the team API key in X-API-Key to api.e2b.app', async () => {
    expect(a.requiredEnvVars).toEqual(['E2B_API_KEY']);
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-API-Key', apiKey: '{{E2B_API_KEY}}' });
    expect(a.envVarMeta.E2B_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    const re = new RegExp(a.envVarMeta.E2B_API_KEY.pattern!);
    expect(re.test(FAKE_KEY)).toBe(true);
    expect(re.test(`sk_${FAKE_KEY}`)).toBe(false);
    ok();
    await call('e2b_list_sandboxes', {});
    expect(sent().url).toBe(`${BASE}/v2/sandboxes`);
    expect(sent().params).toEqual({ limit: 50 });
    expect(sent().headers['X-API-Key']).toBe(FAKE_KEY);
  });

  it('maps every tool to the documented method and path, all on the control-plane host', () => {
    const table = Object.fromEntries(a.tools.map((t) => [t.name, `${t.endpointMapping.method} ${t.endpointMapping.path}`]));
    expect(table).toEqual({
      e2b_list_sandboxes: 'GET /v2/sandboxes',
      e2b_get_sandbox: 'GET /sandboxes/{sandbox_id}',
      e2b_create_sandbox: 'POST /v2/sandboxes',
      e2b_set_sandbox_timeout: 'POST /sandboxes/{sandbox_id}/timeout',
      e2b_pause_sandbox: 'POST /sandboxes/{sandbox_id}/pause',
      e2b_resume_sandbox: 'POST /v2/sandboxes/{sandbox_id}/connect',
      e2b_kill_sandbox: 'DELETE /sandboxes/{sandbox_id}',
      e2b_get_sandbox_logs: 'GET /v2/sandboxes/{sandbox_id}/logs',
      e2b_get_sandbox_metrics: 'GET /sandboxes/{sandbox_id}/metrics',
      e2b_list_templates: 'GET /v2/templates',
      e2b_list_template_builds: 'GET /templates/{template_id}',
      e2b_list_default_templates: 'GET /default-templates',
      e2b_list_snapshots: 'GET /snapshots',
    });
    // No tool leaves the base URL: the envd API on a sandbox's own host would receive the team key.
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith('/')).toBe(true);
    expect(a.instructions).toContain('Running code inside a sandbox is not part of this connector.');
  });

  it('creates a sandbox with the documented camelCase body and the short defaults', async () => {
    ok();
    await call('e2b_create_sandbox', { metadata: { user: 'abc' }, allow_internet_access: false });
    expect(sent().data).toEqual({ templateID: 'base', timeout: 300, allow_internet_access: false, metadata: { user: 'abc' } });
    mockedAxios.mockReset();
    ok();
    await call('e2b_set_sandbox_timeout', { sandbox_id: 'sbx1', timeout: 600 });
    expect(sent().url).toBe(`${BASE}/sandboxes/sbx1/timeout`);
    expect(sent().data).toEqual({ timeout: 600 });
    mockedAxios.mockReset();
    ok();
    await call('e2b_resume_sandbox', { sandbox_id: 'sbx1' });
    expect(sent().data).toEqual({ timeout: 300 });
  });

  it('filters and pages the sandbox list and exposes the next-token header', async () => {
    ok();
    await call('e2b_list_sandboxes', { state: 'paused', metadata: 'user=abc', next_token: 'tok' });
    expect(sent().params).toEqual({ state: 'paused', metadata: 'user=abc', limit: 50, nextToken: 'tok' });
    for (const name of ['e2b_list_sandboxes', 'e2b_list_templates', 'e2b_list_template_builds', 'e2b_list_snapshots']) expect(tool(name).endpointMapping.exposeHeaders).toContain('x-next-token');
  });

  it('removes the sandbox access tokens from answers', () => {
    const raw = { sandboxID: 'sbx1', templateID: 'base', domain: 'e2b.app', envdAccessToken: 'secret-a', trafficAccessToken: 'secret-b' };
    for (const name of ['e2b_get_sandbox', 'e2b_create_sandbox', 'e2b_resume_sandbox']) {
      expect(applyResponseTransform(raw, tool(name).responseMapping as never).value).toEqual({ sandboxID: 'sbx1', templateID: 'base', domain: 'e2b.app' });
    }
  });

  it('switches off exactly the kill, labels the paid calls and marks writes and reads', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(SWITCHED_OFF);
    expect(annotationsOf(tool('e2b_kill_sandbox')).destructiveHint).toBe(true);
    expect(a.instructions).toContain('**Switched off at install**: `e2b_kill_sandbox`; it cannot be undone');
    for (const t of a.tools) {
      const ann = annotationsOf(t);
      if (WRITES.includes(t.name)) expect(`${t.name}:${ann.readOnlyHint}`).toBe(`${t.name}:false`);
      else {
        expect(t.endpointMapping.method).toBe('GET');
        expect(`${t.name}:${ann.readOnlyHint}`).toBe(`${t.name}:true`);
      }
      if (PAID.includes(t.name)) {
        expect(t.description).toMatch(/COSTS MONEY/);
        expect(t.description).toMatch(/[Cc]onfirm/);
      }
    }
    for (const name of PAID) expect(a.instructions).toContain(`\`${name}\``);
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name).toMatch(/^e2b_[a-z_]+$/);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [p, schema] of Object.entries(t.parameters?.properties ?? {})) expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('probes with a read tool and documents every tool in the instructions, without em dashes', () => {
    expect(a.probe).toEqual({ tool: 'e2b_list_sandboxes' });
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [...a.instructions.matchAll(/\be2b_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\be2b_[a-z_]+/g)])].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const live = process.env.RUN_E2B_LIVE === '1' && process.env.E2B_API_KEY ? describe : describe.skip;
live('e2b adapter: live (reads only)', () => {
  const real = mockedAxios.__actual;
  const get = async (path: string) => {
    const res = await real.get(`${BASE}${path}`, { headers: { 'X-API-Key': process.env.E2B_API_KEY!, ...a.connector.headers }, validateStatus: () => true });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return res.data as unknown;
  };
  it('reads sandboxes, templates, default templates and snapshots', async () => {
    expect(Array.isArray(await get('/v2/sandboxes?limit=5'))).toBe(true);
    expect(Array.isArray(await get('/v2/templates?limit=5'))).toBe(true);
    expect(Array.isArray(await get('/default-templates'))).toBe(true);
    expect(Array.isArray(await get('/snapshots?limit=5'))).toBe(true);
  }, 60_000);
});
