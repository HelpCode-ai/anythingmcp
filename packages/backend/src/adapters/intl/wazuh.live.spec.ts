import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import * as adapter from './wazuh.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeErrorWhenProblems } from '../../connectors/engines/response-error.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Wazuh adapter (Wazuh 4.x server API,
 * read-only):
 *
 *   1. Static: always runs. Pins the LOGIN_TOKEN flow (POST
 *      /security/user/authenticate with HTTP Basic through loginBasicAuth,
 *      JWT at data.token, sent as Bearer, 900 s
 *      default lifetime), GET-only tools, every tool's URL and query through
 *      the real RestEngine, the {items, total} response shapes and the
 *      errorWhen rules for Wazuh's "failed_items" inside a 200. Routes and
 *      parameters follow the Wazuh v4.14.9 OpenAPI spec (api/api/spec/spec.yaml)
 *      and were checked with curl against a wazuh/wazuh-manager:4.14.9
 *      container on 2 Nov 2026.
 *
 *   2. Live: skipped unless RUN_WAZUH_LIVE=1 with WAZUH_URL, WAZUH_USERNAME
 *      and WAZUH_PASSWORD set (a user with the readonly role). The sign-in
 *      goes through the real LoginTokenService (loginBasicAuth), then every
 *      tool runs through the RestEngine with the token it got. Optional
 *      WAZUH_AGENT_ID (default 000, the manager).
 *      Wazuh's default certificate is self-signed: pass NODE_EXTRA_CA_CERTS,
 *      or for a throwaway local container NODE_TLS_REJECT_UNAUTHORIZED=0.
 *
 *        RUN_WAZUH_LIVE=1 SSRF_ALLOWED_HOSTS=localhost WAZUH_URL=https://localhost:55000 \
 *        WAZUH_USERNAME=... WAZUH_PASSWORD=... npx jest src/adapters/intl/wazuh
 *
 * Wazuh's login takes `Authorization: Basic base64(user:pass)`; the adapter
 * sets `loginBasicAuth: true` so LoginTokenService builds that header from
 * username and password on the login request only (#982).
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
  parameters: { properties?: Record<string, { description?: string; pattern?: string; default?: unknown; maximum?: number; enum?: string[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  icon: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, any>; headers: Record<string, string>; config: { errorWhen: unknown } };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

const BASE = 'https://wazuh.example.com:55000';
// Built at runtime so no literal looks like a real credential.
const FAKE_PASSWORD = ['Wz', 'x'.repeat(10), '.*-'].join('');
const FAKE_JWT = ['eyJhbGciOiJFUzUxMiJ9', 'eyJzdWIiOiJ4In0', 'AAAA'].join('.');
const ENV: Record<string, string> = { WAZUH_URL: BASE, WAZUH_USERNAME: 'mcp-readonly', WAZUH_PASSWORD: FAKE_PASSWORD };
const config = { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService;

const stubLogin = (token = FAKE_JWT) => {
  const b = async () => ({ token, expiresAt: Date.now() + 900_000 });
  return { getToken: b, forceRelogin: b } as unknown as LoginTokenService;
};
// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call; the catalog's
// errorWhen rules passed to the engine.
const call = (name: string, params: Record<string, unknown>, env = ENV, login: LoginTokenService = stubLogin()) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, login).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: cfg.headers,
      errorWhen: a.connector.config.errorWhen,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[0][0];
const query = () => {
  const req = sent();
  return req.paramsSerializer ? decodeURIComponent(req.paramsSerializer(req.params)) : '';
};
const mapped = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const ok = (items: unknown[]) => ({ data: { affected_items: items, total_affected_items: items.length, total_failed_items: 0, failed_items: [] }, message: 'ok', error: 0 });

describe('wazuh adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in at /security/user/authenticate and sends the JWT as Bearer', () => {
    expect(a.category).toBe('monitoring');
    expect(a.icon).toBe('wazuh');
    expect(a.connector.baseUrl).toBe('{{WAZUH_URL}}');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toMatchObject({
      loginUrl: '{{WAZUH_URL}}/security/user/authenticate',
      loginMethod: 'POST',
      loginBasicAuth: true,
      loginBody: {},
      username: '{{WAZUH_USERNAME}}',
      password: '{{WAZUH_PASSWORD}}',
      tokenJsonPath: 'data.token',
      tokenTTLSeconds: 900,
      refreshOn401: true,
      headerName: 'Authorization',
      headerTemplate: 'Bearer ${token}',
    });
    expect(a.connector.authConfig.proactiveRefreshSeconds).toBeLessThan(900);
    expect(a.probe.tool).toBe('wazuh_get_manager_info');
    expect(a.requiredEnvVars).toEqual(['WAZUH_URL', 'WAZUH_USERNAME', 'WAZUH_PASSWORD']);
    for (const s of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[s]).toBeTruthy();
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.WAZUH_URL).toMatchObject({ kind: 'address', secret: false });
    expect(meta.WAZUH_USERNAME).toMatchObject({ kind: 'credential', secret: false });
    expect(meta.WAZUH_PASSWORD).toMatchObject({ kind: 'credential', secret: true });
  });

  it('accepts the server API address with a port and no trailing slash', () => {
    const url = new RegExp(a.envVarMeta.WAZUH_URL.pattern!);
    for (const good of [BASE, 'https://10.0.0.5:55000', 'https://localhost:55000', 'https://siem.example.com/wazuh-api']) expect(url.test(good)).toBe(true);
    for (const bad of ['wazuh.example.com:55000', `${BASE}/`, 'https://wazuh example.com']) expect(url.test(bad)).toBe(false);
  });

  it('logs in with POST and an empty JSON body, so the password never travels in the body', async () => {
    const auth = interpolateDeep(a.connector.authConfig, ENV) as any;
    mockedAxios.mockResolvedValueOnce({ data: { data: { token: FAKE_JWT }, error: 0 }, headers: {} });
    const bundle = await new LoginTokenService({} as any, config).getToken(auth);
    const login = sent();
    expect(login.method).toBe('POST');
    expect(login.url).toBe(`${BASE}/security/user/authenticate`);
    expect(login.data).toEqual({});
    expect(JSON.stringify(login.data ?? '')).not.toContain(FAKE_PASSWORD);
    expect(login.params).toBeUndefined();
    expect(bundle.token).toBe(FAKE_JWT);
    expect(bundle.expiresAt - Date.now()).toBeLessThanOrEqual(900_000);
  });

  it('sends Authorization: Basic base64(user:pass) on the login only, and Bearer on the tools', async () => {
    const auth = interpolateDeep(a.connector.authConfig, ENV) as any;
    mockedAxios.mockResolvedValueOnce({ data: { data: { token: FAKE_JWT }, error: 0 }, headers: {} });
    const loginService = new LoginTokenService({} as any, config);
    // No connector id: the cache key is the one RestEngine uses below.
    await loginService.getToken(auth);
    const loginReq = sent();
    const basic = Buffer.from(`mcp-readonly:${FAKE_PASSWORD}`).toString('base64');
    expect(loginReq.headers.Authorization).toBe(`Basic ${basic}`);
    expect(loginReq.headers.Accept).toBe('application/json');
    expect(a.connector.authConfig.loginHeaders).not.toHaveProperty('Authorization');

    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: ok([]) });
    await call('wazuh_get_manager_info', {}, ENV, loginService);
    expect(sent().headers.Authorization).toBe(`Bearer ${FAKE_JWT}`);
    expect(JSON.stringify(sent())).not.toContain(basic);
  });

  it('is strictly read-only: fifteen GET tools, nothing under /security, /cluster or /active-response', () => {
    expect(a.tools).toHaveLength(15);
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations }))
        .toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.endpointMapping.path).not.toMatch(/security|cluster|active-response|restart|upgrade|vulnerability|logs/);
    }
  });

  it('prefixes every tool and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^wazuh_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('every declared parameter reaches the request, path parameters are required, limits stay at 500', () => {
    for (const t of a.tools) {
      const used = new Set<string>();
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      for (const v of Object.values(t.endpointMapping.queryParams ?? {})) if (typeof v === 'string' && v.startsWith('$')) used.add(v.slice(1));
      const props = Object.keys(t.parameters.properties ?? {});
      expect(`${t.name}:${props.sort().join(',')}`).toBe(`${t.name}:${[...used].sort().join(',')}`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters.required).toContain(p);
      const limit = t.parameters.properties?.limit;
      if (limit) expect([limit.default, limit.maximum]).toEqual([50, 500]);
      for (const [p, s] of Object.entries(t.parameters.properties ?? {})) expect(`${t.name}.${p}:${typeof s.description}`).toBe(`${t.name}.${p}:string`);
    }
  });

  it('agent ids have at least three digits', () => {
    for (const t of a.tools.filter((x) => x.parameters.properties?.agent_id)) {
      const re = new RegExp(t.parameters.properties!.agent_id.pattern!);
      for (const good of ['000', '001', '1234']) expect(re.test(good)).toBe(true);
      for (const bad of ['1', '01', 'abc', '001,002']) expect(re.test(bad)).toBe(false);
    }
    expect(tool('wazuh_list_sca_checks').parameters.properties!.result.enum).toEqual(['passed', 'failed', 'not applicable']);
  });

  it('instructions cover setup, SSRF allowlist, self-signed TLS, Cloud, privacy, errors and what is out of scope', () => {
    const i = a.instructions;
    expect(i).toMatch(/SSRF_ALLOWED_HOSTS/);
    expect(i).toMatch(/A self-signed certificate will fail: the connector offers no trust-anything switch\./);
    expect(i).toMatch(/NODE_EXTRA_CA_CERTS/);
    expect(i).toMatch(/Cloud can only reach .* public internet over HTTPS/);
    expect(i).toMatch(/Assign this connector only to MCP servers/);
    expect(i).toMatch(/`readonly` role/);
    expect(i).toMatch(/1701/);
    expect(i).toMatch(/\*\*Out of scope\*\*: alerts and events .*indexer.*vulnerability/);
    const names = new Set(a.tools.map((t) => t.name));
    for (const m of [...i.matchAll(/\bwazuh_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bwazuh_[a-z_]+/g)])]) expect(names).toContain(m[0]);
    for (const name of names) expect(i).toContain(`\`${name}\``);
    for (const t of a.tools) expect(t.description.length).toBeGreaterThanOrEqual(60);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string[]]> = [
    ['wazuh_get_api_info', {}, '/', []],
    ['wazuh_get_manager_info', {}, '/manager/info', []],
    ['wazuh_get_manager_status', {}, '/manager/status', []],
    ['wazuh_list_agents', { status: 'active,disconnected', os_platform: 'ubuntu' }, '/agents', ['status=active,disconnected', 'os.platform=ubuntu', 'limit=50', 'select=id,name,ip,status,os.name']],
    ['wazuh_get_agent', { agent_id: '001' }, '/agents', ['agents_list=001']],
    ['wazuh_get_agents_summary', {}, '/agents/summary/status', []],
    ['wazuh_get_agents_os_summary', {}, '/agents/summary/os', []],
    ['wazuh_list_outdated_agents', { offset: 50 }, '/agents/outdated', ['limit=50', 'offset=50']],
    ['wazuh_list_rules', { level: '10-15', nist_800_53: 'AU.6' }, '/rules', ['level=10-15', 'nist-800-53=AU.6', 'select=id,level,description']],
    ['wazuh_list_rule_groups', { search: 'auth' }, '/rules/groups', ['search=auth']],
    ['wazuh_list_decoders', { decoder_names: 'sshd' }, '/decoders', ['decoder_names=sshd', 'select=name,filename']],
    ['wazuh_list_sca_policies', { agent_id: '001' }, '/sca/001', ['limit=50']],
    ['wazuh_list_sca_checks', { agent_id: '001', policy_id: 'cis_ubuntu22-04', result: 'failed' }, '/sca/001/checks/cis_ubuntu22-04', ['result=failed', 'select=id,title,result']],
    ['wazuh_list_syscheck_files', { agent_id: '001', summary: true, type: 'file' }, '/syscheck/001', ['summary=true', 'type=file']],
    ['wazuh_get_syscheck_last_scan', { agent_id: '001' }, '/syscheck/001/last_scan', []],
  ];
  it('lists every tool in the URL table', () => expect(table.map(([n]) => n).sort()).toEqual(a.tools.map((t) => t.name).sort()));
  it.each(table)('%s sends GET to the right URL with the Bearer token', async (name, params, path, q) => {
    mockedAxios.mockResolvedValue({ data: ok([]) });
    await call(name, params);
    const req = sent();
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`${BASE}${path}`);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_JWT}`);
    for (const part of q) expect(query()).toContain(part);
    expect(query()).not.toContain('$');
    expect(JSON.stringify(req)).not.toContain('{{');
  });

  it('every transform and the errorWhen rules are valid', () => {
    for (const t of a.tools) if (t.responseMapping) expect(`${t.name}:${validateTransform(t.responseMapping.transform)}`).toBe(`${t.name}:null`);
    expect(describeErrorWhenProblems(a.connector.config.errorWhen)).toEqual([]);
  });

  it('lists come back as {items, total}; single records as the record', () => {
    const agents = ok([{ id: '001', name: 'web-01', status: 'active' }]);
    expect(mapped('wazuh_list_agents', agents)).toEqual({ items: [{ id: '001', name: 'web-01', status: 'active' }], total: 1 });
    expect(mapped('wazuh_get_agent', agents)).toEqual({ id: '001', name: 'web-01', status: 'active' });
    expect(mapped('wazuh_get_syscheck_last_scan', ok([{ start: '2026-11-02T11:26:28+00:00', end: '2026-11-02T11:26:28+00:00' }]))).toEqual({ start: '2026-11-02T11:26:28+00:00', end: '2026-11-02T11:26:28+00:00' });
    expect(mapped('wazuh_get_agents_summary', { data: { connection: { active: 2, total: 2 } }, error: 0 })).toEqual({ connection: { active: 2, total: 2 } });
    expect(mapped('wazuh_get_api_info', { data: { api_version: '4.14.9' }, error: 0 })).toEqual({ api_version: '4.14.9' });
  });

  it('a missing agent (failed_items 1701 inside a 200) fails the call as not found; an empty list does not', async () => {
    mockedAxios.mockResolvedValue({
      data: { data: { affected_items: [], total_affected_items: 0, total_failed_items: 1, failed_items: [{ error: { code: 1701, message: 'Agent does not exist' }, id: ['999'] }] }, error: 1 },
    });
    await expect(call('wazuh_get_agent', { agent_id: '999' })).rejects.toMatchObject({ status: 404, message: expect.stringContaining('Agent does not exist') });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: ok([]) });
    await expect(call('wazuh_list_outdated_agents', {})).resolves.toBeDefined();
  });
});

const live = process.env.RUN_WAZUH_LIVE === '1' && process.env.WAZUH_URL && process.env.WAZUH_USERNAME && process.env.WAZUH_PASSWORD ? describe : describe.skip;
live('wazuh adapter: live (read-only)', () => {
  const env = { WAZUH_URL: (process.env.WAZUH_URL ?? '').replace(/\/$/, ''), WAZUH_USERNAME: process.env.WAZUH_USERNAME ?? '', WAZUH_PASSWORD: process.env.WAZUH_PASSWORD ?? '' };
  const agent = process.env.WAZUH_AGENT_ID ?? '000';
  const body = (res: unknown) => res;
  let login: LoginTokenService;
  beforeAll(async () => {
    mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg));
    // The engine's own sign-in: loginBasicAuth builds the Basic header.
    login = new LoginTokenService({} as any, config);
    const bundle = await login.getToken(interpolateDeep(a.connector.authConfig, env) as any, 'wazuh-live');
    expect(bundle.token.split('.')).toHaveLength(3);
  });

  it('a wrong password is refused at sign-in without echoing the credentials', async () => {
    const wrong = { ...env, WAZUH_PASSWORD: `${env.WAZUH_PASSWORD}-wrong` };
    const err: any = await new LoginTokenService({} as any, config)
      .getToken(interpolateDeep(a.connector.authConfig, wrong) as any, 'wazuh-live-wrong')
      .catch((e) => e);
    expect(err?.response?.status).toBe(401);
    const text = `${err.message} ${JSON.stringify({ c: err.config, r: err.response?.config })}`;
    expect(text).not.toContain(wrong.WAZUH_PASSWORD);
    expect(text).not.toContain(Buffer.from(`${env.WAZUH_USERNAME}:${wrong.WAZUH_PASSWORD}`).toString('base64'));
  }, 30_000);

  it('runs every tool against the server and shapes the answers', async () => {
    const info = mapped('wazuh_get_api_info', body(await call('wazuh_get_api_info', {}, env, login)));
    expect(String(info.api_version)).toMatch(/^4\./);
    expect(mapped('wazuh_get_manager_info', body(await call('wazuh_get_manager_info', {}, env, login)))).toMatchObject({ type: 'server' });
    expect(mapped('wazuh_get_manager_status', body(await call('wazuh_get_manager_status', {}, env, login)))['wazuh-apid']).toBe('running');
    const agents = mapped('wazuh_list_agents', body(await call('wazuh_list_agents', { limit: 5 }, env, login)));
    expect(typeof agents.total).toBe('number');
    expect(mapped('wazuh_get_agent', body(await call('wazuh_get_agent', { agent_id: agent }, env, login)))).toMatchObject({ id: agent });
    expect(mapped('wazuh_get_agents_summary', body(await call('wazuh_get_agents_summary', {}, env, login)))).toHaveProperty('connection');
    expect(mapped('wazuh_get_agents_os_summary', body(await call('wazuh_get_agents_os_summary', {}, env, login)))).toBeDefined();
    for (const n of ['wazuh_list_outdated_agents', 'wazuh_list_rule_groups', 'wazuh_list_decoders']) {
      expect(typeof mapped(n, body(await call(n, { limit: 3 }, env, login))).total).toBe('number');
    }
    const rules = mapped('wazuh_list_rules', body(await call('wazuh_list_rules', { level: '12', limit: 3 }, env, login)));
    expect(rules.items[0]).toMatchObject({ level: 12 });
    const pols = mapped('wazuh_list_sca_policies', body(await call('wazuh_list_sca_policies', { agent_id: agent }, env, login)));
    if (pols.items.length) {
      const checks = mapped('wazuh_list_sca_checks', body(await call('wazuh_list_sca_checks', { agent_id: agent, policy_id: pols.items[0].policy_id, result: 'not applicable', limit: 2 }, env, login)));
      for (const c of checks.items) expect(c.result).toBe('not applicable');
    }
    const files = mapped('wazuh_list_syscheck_files', body(await call('wazuh_list_syscheck_files', { agent_id: agent, summary: true, limit: 2 }, env, login)));
    expect(typeof files.total).toBe('number');
    expect(mapped('wazuh_get_syscheck_last_scan', body(await call('wazuh_get_syscheck_last_scan', { agent_id: agent }, env, login)))).toHaveProperty('start');
  }, 60_000);

  it('an unknown agent fails as not found', async () => {
    await expect(call('wazuh_get_agent', { agent_id: '999' }, env, login)).rejects.toMatchObject({ status: 404 });
  }, 30_000);
});
