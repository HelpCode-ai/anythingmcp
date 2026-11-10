import axios from 'axios';
import * as adapter from './tookan.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Tookan (Jungleworks) adapter, API v2.
 *
 * Static checks always run: every call is a POST under
 * https://api.tookanapp.com/v2 with api_key inside the JSON body (the
 * connector has no auth header; the key comes from TOOKAN_API_KEY through
 * the body mapping), the body status codes 100/101/201/404 become failed
 * calls, read tools are marked read-only although they POST, agent and
 * customer answers drop login tokens and password hashes, and deletes
 * install switched off. Paths and fields follow the published blueprint:
 * https://tookanapi.docs.apiary.io/
 *
 * Live checks run only with RUN_TOOKAN_LIVE=1. Without a key they confirm a
 * wrong key is refused (status 101 in the body); with TOOKAN_API_KEY they
 * list the teams and agents. Reads only.
 *
 *   RUN_TOOKAN_LIVE=1 TOOKAN_API_KEY=... npx jest src/adapters/intl/tookan.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  responseMapping?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
    config: { errorWhen: unknown[] };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({ name: entry.name, connectorType: 'REST', endpointMapping: entry.endpointMapping, annotations: entry.annotations });
const used = (entry: Tool) => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (/^\$\w+$/.test(v)) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};

const ENV: Record<string, string> = { TOOKAN_API_KEY: '5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f' };
const BASE = 'https://api.tookanapp.com/v2';

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: cfg.headers,
      errorWhen: a.connector.config.errorWhen,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (data: unknown = { message: 'Successful', status: 200, data: [] }) =>
  mockedAxios.mockResolvedValueOnce({ status: 200, data, headers: {} });

describe('tookan adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('posts JSON to v2 with the api key in every body and no auth header', () => {
    expect(a.slug).toBe('tookan');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('logistics');
    expect(a.icon).toBe('tookan');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('NONE');
    expect(a.requiredEnvVars).toEqual(['TOOKAN_API_KEY']);
    expect(a.envVarMeta.TOOKAN_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    const key = new RegExp(a.envVarMeta.TOOKAN_API_KEY.pattern!);
    expect(key.test(ENV.TOOKAN_API_KEY)).toBe(true);
    for (const bad of ['', 'short', `api_key ${ENV.TOOKAN_API_KEY}`]) expect(key.test(bad)).toBe(false);
    for (const entry of a.tools) {
      expect(entry.endpointMapping.method).toBe('POST');
      expect(entry.endpointMapping.bodyMapping?.api_key).toBe('{{TOOKAN_API_KEY}}');
    }
  });

  it('turns the body status codes into failed calls and probes the team list', () => {
    expect(a.connector.config.errorWhen).toEqual([
      { path: 'status', equals: 101, messagePath: 'message', status: 401 },
      { path: 'status', in: [100, 201], messagePath: 'message', status: 400 },
      { path: 'status', equals: 404, messagePath: 'message', status: 400 },
    ]);
    expect(a.probe).toEqual({ tool: 'tookan_list_teams', params: {} });
    expect(a.verifyHints['401']).toBeTruthy();
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^tookan_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(declared.has(arg) || envNames.has(arg)).toBe(true);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(40);
    }
  });

  it('marks the POST reads read-only, the writes not, and installs deletes switched off', () => {
    const reads = a.tools.filter((entry) => entry.annotations?.readOnlyHint === true).map((entry) => entry.name);
    for (const name of reads) expect(name).toMatch(/^tookan_(list|get|find)_/);
    for (const entry of a.tools) {
      expect(annotationsOf(entry).readOnlyHint).toBe(reads.includes(entry.name));
    }
    expect(reads).toHaveLength(12);
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(['tookan_delete_customer', 'tookan_delete_task']);
    for (const entry of a.tools) expect(entry.endpointMapping.path).not.toMatch(/wallet|stripe|fare|payment/i);
  });

  it('names every tool in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('removes login tokens and password hashes from agent and customer answers', () => {
    const profile = {
      message: 'Successful',
      status: 200,
      data: { fleet_details: [{ fleet_id: 1, first_name: 'Guri', access_token: 'x', password: 'y', device_token: 'z' }], jobs: [] },
    };
    const shaped = applyResponseTransform(profile, tool('tookan_get_agent_profile').responseMapping as never) as { value: typeof profile };
    expect(shaped.value.data.fleet_details[0]).toEqual({ fleet_id: 1, first_name: 'Guri' });
    const found = { message: 'Successful', status: 200, data: [{ customer_id: 101, customer_username: 'A', access_token: 'x', password: 'y', app_access_token: 'w', otp: '' }] };
    const shapedFound = applyResponseTransform(found, tool('tookan_find_customer_by_phone').responseMapping as never) as { value: typeof found };
    expect(shapedFound.value.data[0]).toEqual({ customer_id: 101, customer_username: 'A' });
  });

  it('lists tasks with the key in the body and the documented filters', async () => {
    ok();
    await call('tookan_list_tasks', { job_type: 1, start_date: '2026-11-01', end_date: '2026-11-09', job_status: '2' });
    const req = sent();
    expect(req.url).toBe(`${BASE}/get_all_tasks`);
    expect(String(req.method).toUpperCase()).toBe('POST');
    expect(req.headers.Authorization).toBeUndefined();
    expect(req.data).toEqual({
      api_key: ENV.TOOKAN_API_KEY,
      job_type: 1,
      start_date: '2026-11-01',
      end_date: '2026-11-09',
      job_status: '2',
      is_pagination: 1,
      requested_page: 1,
    });

    ok();
    await call('tookan_get_task_details', { job_ids: [101, 102] });
    expect(sent().url).toBe(`${BASE}/get_job_details`);
    expect(sent().data).toEqual({ api_key: ENV.TOOKAN_API_KEY, job_ids: [101, 102], include_task_history: 0 });

    ok();
    await call('tookan_list_teams', {});
    expect(sent().url).toBe(`${BASE}/view_all_team_only`);
    expect(sent().data).toEqual({ api_key: ENV.TOOKAN_API_KEY });
  });

  it('creates a delivery task and a customer with the documented bodies', async () => {
    ok({ message: 'The task has been created.', status: 200, data: { job_id: 5001 } });
    await call('tookan_create_task', {
      timezone: -330,
      has_pickup: 0,
      has_delivery: 1,
      order_id: 'ORD-1',
      customer_address: 'Powai, Mumbai',
      job_delivery_datetime: '2026-11-10 14:00:00',
      customer_username: 'Asha',
      customer_phone: '+919999999999',
    });
    expect(sent().url).toBe(`${BASE}/create_task`);
    expect(sent().data).toEqual({
      api_key: ENV.TOOKAN_API_KEY,
      timezone: -330,
      layout_type: 0,
      has_pickup: 0,
      has_delivery: 1,
      order_id: 'ORD-1',
      tracking_link: 1,
      customer_address: 'Powai, Mumbai',
      job_delivery_datetime: '2026-11-10 14:00:00',
      customer_username: 'Asha',
      customer_phone: '+919999999999',
    });

    ok();
    await call('tookan_add_customer', { name: 'Asha', phone: '+919999999999' });
    expect(sent().url).toBe(`${BASE}/customer/add`);
    expect(sent().data).toEqual({ api_key: ENV.TOOKAN_API_KEY, user_type: 0, name: 'Asha', phone: '+919999999999' });
  });

  it('fails the call when Tookan answers status 101 in a 200 body', async () => {
    ok({ message: 'Invalid API key', status: 101, data: {} });
    await expect(call('tookan_list_teams', {})).rejects.toThrow(/Invalid API key/);
  });
});

// Opt-in: RUN_TOOKAN_LIVE=1. The refusal check needs no account; the reads
// need TOOKAN_API_KEY. Nothing is written.
const live = process.env.RUN_TOOKAN_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('Tookan: live', () => {
  it('refuses a wrong key with status 101', async () => {
    const response = await liveFetch.post(`${BASE}/view_all_team_only`, { api_key: 'not-a-real-key' }, { validateStatus: () => true });
    expect(response.data.status).toBe(101);
  });

  it('lists teams and agents', async () => {
    const key = process.env.TOOKAN_API_KEY;
    if (!key) throw new Error('Set TOOKAN_API_KEY for the live check');
    const teams = await liveFetch.post(`${BASE}/view_all_team_only`, { api_key: key }, { validateStatus: () => true });
    expect(teams.data.status).toBe(200);
    const agents = await liveFetch.post(`${BASE}/get_all_fleets`, { api_key: key }, { validateStatus: () => true });
    expect(agents.data.status).toBe(200);
  });
});
