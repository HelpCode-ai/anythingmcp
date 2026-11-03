import axios from 'axios';
import * as adapter from './browser-use.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';

/**
 * Browser Use Cloud API v4. Checked on 30 Oct 2026 against the OpenAPI document the
 * API serves (https://api.browser-use.com/api/v4/openapi.json) and the one behind the
 * docs (https://docs.browser-use.com/cloud/openapi/v4.json). Auth is the
 * X-Browser-Use-API-Key header, no Bearer. Runs, sessions, workspaces, browsers,
 * profiles and extensions answer on both the US and the EU host
 * (api.eu.browser-use.com); v2 agent endpoints do not exist on the EU host, which is
 * why this adapter is built on v4.
 *
 * Live part (reads only: sessions, runs, browsers, profiles, extensions, and the
 * session and workspace of the newest run):
 *   BROWSER_USE_API_KEY=bu_... RUN_BROWSER_USE_LIVE=1 npx jest src/adapters/intl/browser-use
 *   (BROWSER_USE_API_HOST defaults to https://api.browser-use.com)
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
  parameters?: { properties?: Record<string, { description?: string; enum?: unknown[]; minimum?: number; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; headers?: Record<string, string> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  category: string;
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
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
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
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations } as never);

const FAKE_KEY = ['bu', 'X'.repeat(20), 'y'.repeat(12)].join('_');
const ENV: Record<string, string> = { BROWSER_USE_API_HOST: 'https://api.browser-use.com', BROWSER_USE_API_KEY: FAKE_KEY };
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
const sent = () => mockedAxios.mock.calls[0][0];

const OFF = ['browser_use_delete_profile', 'browser_use_delete_session', 'browser_use_delete_workspace', 'browser_use_delete_workspace_file'];
const PAID = ['browser_use_create_run', 'browser_use_send_session_message', 'browser_use_create_browser'];

describe('browser-use adapter: static spec conformance (API v4)', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the key as X-Browser-Use-API-Key to the chosen host under /api/v4', () => {
    expect(a.slug).toBe('browser-use');
    expect(a.icon).toBe('browser-use');
    expect(a.category).toBe('infrastructure');
    expect(a.requiredEnvVars).toEqual(['BROWSER_USE_API_HOST', 'BROWSER_USE_API_KEY']);
    expect(a.connector.baseUrl).toBe('{{BROWSER_USE_API_HOST}}/api/v4');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Browser-Use-API-Key', apiKey: '{{BROWSER_USE_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/sessions?limit=1');
    expect(a.probe).toEqual({ tool: 'browser_use_list_sessions' });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    const meta = describeAdapterEnvVars(a as never);
    expect(meta.find((m) => m.name === 'BROWSER_USE_API_HOST')).toMatchObject({ kind: 'address', required: true });
    expect(meta.find((m) => m.name === 'BROWSER_USE_API_KEY')).toMatchObject({ kind: 'credential', secret: true, required: true });
    for (const s of ['401', '403', '404', '429']) expect(a.verifyHints[s]).toBeTruthy();
  });

  it('accepts exactly the US and EU hosts and a bu_ key', () => {
    const host = new RegExp(a.envVarMeta.BROWSER_USE_API_HOST.pattern!);
    for (const ok of ['https://api.browser-use.com', 'https://api.eu.browser-use.com']) expect(host.test(ok)).toBe(true);
    for (const bad of ['https://api.browser-use.com/api/v4', 'https://api.browser-use.com/', 'api.browser-use.com', 'https://cloud.browser-use.com']) expect(host.test(bad)).toBe(false);
    const key = new RegExp(a.envVarMeta.BROWSER_USE_API_KEY.pattern!);
    expect(key.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_KEY}`, `${FAKE_KEY} `, 'bu_']) expect(key.test(bad)).toBe(false);
  });

  it('builds the documented requests through the real RestEngine on both hosts', async () => {
    mockedAxios.mockResolvedValue({ status: 200, data: { id: 'r1', sessionId: 's1', workspaceId: 'w1' }, headers: {} });
    await call('browser_use_create_run', { task: 'Read the heading of example.com', model: 'gpt-6-luna', max_cost_usd: 0.5, keep_alive: 300, browser_settings: { proxyCountryCode: 'de' } });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe('https://api.browser-use.com/api/v4/runs');
    expect(sent().headers['X-Browser-Use-API-Key']).toBe(FAKE_KEY);
    expect(sent().headers.Authorization).toBeUndefined();
    expect(sent().data).toEqual({ task: 'Read the heading of example.com', model: 'gpt-6-luna', maxCostUsd: 0.5, keepAlive: 300, browserSettings: { proxyCountryCode: 'de' } });

    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { sessions: [] }, headers: {} });
    await call('browser_use_list_sessions', { limit: 5 }, { ...ENV, BROWSER_USE_API_HOST: 'https://api.eu.browser-use.com' });
    expect(sent().url).toBe('https://api.eu.browser-use.com/api/v4/sessions');
    expect(sent().params).toEqual({ limit: 5 });

    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: {}, headers: {} });
    await call('browser_use_send_session_message', { session_id: 's1', text: 'Now sort by price', interrupt: true });
    expect(sent().url).toBe('https://api.browser-use.com/api/v4/sessions/s1/queue');
    expect(sent().data).toEqual({ text: 'Now sort by price', interrupt: true });

    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: {}, headers: {} });
    await call('browser_use_stop_browser', { browser_id: 'b1' });
    expect(sent().method).toBe('PATCH');
    expect(sent().url).toBe('https://api.browser-use.com/api/v4/browsers/b1');
    expect(sent().data).toEqual({ action: 'stop' });
  });

  it('maps every covered v4 endpoint with its documented method, path and field names', () => {
    const m = (n: string) => tool(n).endpointMapping;
    const expected: Array<[string, string, string]> = [
      ['browser_use_create_run', 'POST', '/runs'],
      ['browser_use_list_runs', 'GET', '/runs'],
      ['browser_use_get_run', 'GET', '/runs/{run_id}'],
      ['browser_use_get_run_status', 'GET', '/runs/{run_id}/status'],
      ['browser_use_get_run_events', 'GET', '/runs/{run_id}/events'],
      ['browser_use_list_run_attachments', 'GET', '/runs/{run_id}/attachments'],
      ['browser_use_cancel_run', 'POST', '/runs/{run_id}/cancel'],
      ['browser_use_list_sessions', 'GET', '/sessions'],
      ['browser_use_get_session', 'GET', '/sessions/{session_id}'],
      ['browser_use_rename_session', 'PATCH', '/sessions/{session_id}'],
      ['browser_use_delete_session', 'DELETE', '/sessions/{session_id}'],
      ['browser_use_get_session_cost', 'GET', '/sessions/{session_id}/cost'],
      ['browser_use_get_session_cost_cap', 'GET', '/sessions/{session_id}/cost-cap'],
      ['browser_use_update_session_cost_cap', 'PATCH', '/sessions/{session_id}/cost-cap'],
      ['browser_use_send_session_message', 'POST', '/sessions/{session_id}/queue'],
      ['browser_use_list_session_queue', 'GET', '/sessions/{session_id}/queue'],
      ['browser_use_get_session_queue_message', 'GET', '/sessions/{session_id}/queue/{message_id}'],
      ['browser_use_cancel_session_queue_message', 'DELETE', '/sessions/{session_id}/queue/{message_id}'],
      ['browser_use_get_session_share', 'GET', '/sessions/{session_id}/share'],
      ['browser_use_create_session_share', 'POST', '/sessions/{session_id}/share'],
      ['browser_use_update_session_share', 'PUT', '/sessions/{session_id}/share'],
      ['browser_use_create_workspace', 'POST', '/workspaces'],
      ['browser_use_get_workspace', 'GET', '/workspaces/{workspace_id}'],
      ['browser_use_rename_workspace', 'PATCH', '/workspaces/{workspace_id}'],
      ['browser_use_delete_workspace', 'DELETE', '/workspaces/{workspace_id}'],
      ['browser_use_get_workspace_size', 'GET', '/workspaces/{workspace_id}/size'],
      ['browser_use_list_workspace_files', 'GET', '/workspaces/{workspace_id}/files'],
      ['browser_use_delete_workspace_file', 'DELETE', '/workspaces/{workspace_id}/files'],
      ['browser_use_create_workspace_upload_urls', 'POST', '/workspaces/{workspace_id}/files/upload'],
      ['browser_use_list_browsers', 'GET', '/browsers'],
      ['browser_use_create_browser', 'POST', '/browsers'],
      ['browser_use_get_browser', 'GET', '/browsers/{browser_id}'],
      ['browser_use_stop_browser', 'PATCH', '/browsers/{browser_id}'],
      ['browser_use_list_browser_downloads', 'GET', '/browsers/{browser_id}/downloads'],
      ['browser_use_list_profiles', 'GET', '/profiles'],
      ['browser_use_create_profile', 'POST', '/profiles'],
      ['browser_use_get_profile', 'GET', '/profiles/{profile_id}'],
      ['browser_use_update_profile', 'PATCH', '/profiles/{profile_id}'],
      ['browser_use_delete_profile', 'DELETE', '/profiles/{profile_id}'],
      ['browser_use_list_extensions', 'GET', '/extensions'],
      ['browser_use_get_extension', 'GET', '/extensions/{extension_id}'],
    ];
    expect(a.tools.map((t) => t.name).sort()).toEqual(expected.map(([n]) => n).sort());
    for (const [name, method, path] of expected) expect(`${name} ${m(name).method} ${m(name).path}`).toBe(`${name} ${method} ${path}`);
    expect(m('browser_use_list_runs').queryParams).toEqual({ limit: '$limit', cursor: '$cursor', sessionId: '$session_id' });
    expect(m('browser_use_get_run_events').queryParams).toEqual({ after: '$after', limit: '$limit', include_output: '$include_output' });
    expect(m('browser_use_list_sessions').queryParams).toEqual({ limit: '$limit', cursor: '$cursor' });
    expect(m('browser_use_update_session_cost_cap').bodyMapping).toEqual({ maxCostUsd: '$max_cost_usd' });
    expect(m('browser_use_update_session_share').bodyMapping).toEqual({ isActive: '$is_active' });
    expect(m('browser_use_rename_session').bodyMapping).toEqual({ title: '$title' });
    expect(m('browser_use_list_workspace_files').queryParams).toEqual({ prefix: '$prefix', limit: '$limit', cursor: '$cursor', includeUrls: '$include_urls' });
    expect(m('browser_use_delete_workspace_file').queryParams).toEqual({ path: '$path' });
    expect(m('browser_use_create_workspace_upload_urls').bodyMapping).toEqual({ files: '$files', allowOverrides: '$allow_overrides' });
    expect(m('browser_use_list_browsers').queryParams).toEqual({ pageSize: '$page_size', pageNumber: '$page_number', filterBy: '$filter_by', metadata: '$metadata', agentSessionId: '$agent_session_id' });
    expect(m('browser_use_create_browser')).toMatchObject({ bodyMapping: { timeout: '$timeout', solveCaptchas: '$solve_captchas', extensionIds: '$extension_ids' } });
    expect(tool('browser_use_create_browser').parameters?.properties?.timeout.maximum).toBe(240);
    expect(tool('browser_use_create_run').parameters?.properties?.keep_alive).toMatchObject({ minimum: 120, maximum: 14400 });
    expect(m('browser_use_list_profiles').queryParams).toEqual({ pageSize: '$page_size', pageNumber: '$page_number', query: '$query' });
    expect(m('browser_use_update_profile').bodyMapping).toEqual({ name: '$name', userId: '$user_id' });
  });

  it('keeps the run events mapping valid and drops only the repeated run id', () => {
    for (const t of a.tools) if (t.responseMapping?.transform) expect(() => validateTransform(t.responseMapping!.transform)).not.toThrow();
    const shaped = applyResponseTransform(
      { events: [{ runId: 'r1', id: 1, ts: 't', type: 'step', data: { url: 'https://example.com' } }], nextAfter: 1, hasMore: false },
      tool('browser_use_get_run_events').responseMapping as never,
    ).value;
    expect(shaped).toEqual({ events: [{ id: 1, ts: 't', type: 'step', data: { url: 'https://example.com' } }], nextAfter: 1, hasMore: false });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    for (const t of a.tools) {
      expect(t.name).toMatch(/^browser_use_[a-z_]+$/);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
      for (const [p, s] of Object.entries(t.parameters?.properties ?? {})) expect(`${t.name}.${p}:${typeof s.description}`).toBe(`${t.name}.${p}:string`);
    }
  });

  it('reads are read-only, deletes are destructive and off, paid writes ask for a yes', () => {
    for (const t of a.tools) {
      const ann = annotationsOf(t);
      expect(`${t.name}:${ann.readOnlyHint}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
      if (t.endpointMapping.method !== 'GET') expect(t.description).toMatch(/[Cc]onfirm/);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(OFF);
    for (const n of OFF) expect(annotationsOf(tool(n)).destructiveHint).toBe(true);
    for (const n of PAID) expect(tool(n).description).toMatch(/COSTS MONEY/);
    expect(a.instructions).toMatch(/wait for a yes/);
  });

  it('documents every tool and the EU host, and writes no em dash', () => {
    const names = new Set(a.tools.map((t) => t.name));
    for (const n of names) expect(`${n}:${a.instructions.includes(`\`${n}\``)}`).toBe(`${n}:true`);
    const mentioned = [...a.instructions.matchAll(/\bbrowser_use_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bbrowser_use_[a-z_]+/g)])].map((x) => x[0]);
    for (const n of mentioned) expect(names).toContain(n);
    expect(a.instructions).toContain('https://api.eu.browser-use.com');
    expect(a.instructions).toContain('/api/v4');
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const live = process.env.RUN_BROWSER_USE_LIVE === '1' && process.env.BROWSER_USE_API_KEY ? describe : describe.skip;
live('browser-use adapter: live (read-only)', () => {
  const host = process.env.BROWSER_USE_API_HOST || 'https://api.browser-use.com';
  const get = async (path: string) => {
    const res = await mockedAxios.__actual.get(`${host}/api/v4${path}`, {
      headers: { 'X-Browser-Use-API-Key': process.env.BROWSER_USE_API_KEY!, Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return res.data as Record<string, any>;
  };
  it('lists sessions, runs, browsers, profiles and extensions, and reads the newest run', async () => {
    expect(Array.isArray((await get('/sessions?limit=2')).sessions)).toBe(true);
    const runs = await get('/runs?limit=2');
    expect(Array.isArray(runs.runs)).toBe(true);
    expect(Array.isArray((await get('/browsers?pageSize=2')).items)).toBe(true);
    expect(Array.isArray((await get('/profiles?pageSize=2')).items)).toBe(true);
    expect(Array.isArray((await get('/extensions?pageSize=2')).items)).toBe(true);
    const run = runs.runs[0];
    if (run) {
      expect((await get(`/runs/${run.id}`)).id).toBe(run.id);
      expect(typeof (await get(`/runs/${run.id}/status`)).status).toBe('string');
      expect(Array.isArray((await get(`/runs/${run.id}/events?limit=5&include_output=false`)).events)).toBe(true);
      expect((await get(`/sessions/${run.sessionId}`)).sessionId).toBe(run.sessionId);
      expect(typeof (await get(`/sessions/${run.sessionId}/cost`)).totalCostUsd).toBe('string');
      if (run.workspaceId) expect(typeof (await get(`/workspaces/${run.workspaceId}/size`)).usedBytes).toBe('number');
    }
  }, 60_000);
});
