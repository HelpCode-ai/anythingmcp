import axios, { AxiosError } from 'axios';
import { ConfigService } from '@nestjs/config';
import * as adapter from './filemaker.json';
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
 * Two layers of verification for the Claris FileMaker adapter (FileMaker
 * Data API on FileMaker Server, read-only):
 *
 *   1. Static: always runs. Pins the LOGIN_TOKEN flow (POST
 *      /fmi/data/vLatest/databases/{database}/sessions with HTTP Basic through
 *      loginBasicAuth, token at response.token, sent as Bearer, 900 s
 *      inactivity lifetime), the four tools (three GET + POST _find), every
 *      tool's URL and body through the real RestEngine, response shapes, and
 *      that the find description states FileMaker code "401" is an empty
 *      result. Built from the Claris Data API guide and the maintainer notes
 *      on HelpCode-ai/anythingmcp#1405.
 *
 *   2. Live: skipped unless RUN_FILEMAKER_LIVE=1 with FILEMAKER_URL,
 *      FILEMAKER_DATABASE, FILEMAKER_USERNAME and FILEMAKER_PASSWORD set
 *      (a file account with the fmrest privilege). The sign-in goes through
 *      the real LoginTokenService (loginBasicAuth), then every tool runs
 *      through the RestEngine with the token it got. Optional
 *      FILEMAKER_LAYOUT (default first layout from list) and
 *      FILEMAKER_RECORD_ID for get-by-id.
 *      A trial Server often uses a self-signed certificate: pass
 *      NODE_EXTRA_CA_CERTS, or for a throwaway local container
 *      NODE_TLS_REJECT_UNAUTHORIZED=0.
 *
 *        RUN_FILEMAKER_LIVE=1 SSRF_ALLOWED_HOSTS=localhost \
 *        FILEMAKER_URL=https://localhost FILEMAKER_DATABASE=People \
 *        FILEMAKER_USERNAME=... FILEMAKER_PASSWORD=... \
 *        npx jest src/adapters/intl/filemaker
 *
 * FileMaker's login takes `Authorization: Basic base64(user:pass)` and an
 * empty JSON body; the adapter sets `loginBasicAuth: true` so
 * LoginTokenService builds that header from username and password on the
 * login request only (#1460 / Wazuh pattern).
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
  parameters: {
    properties?: Record<string, { description?: string; type?: string; default?: unknown; maximum?: number; enum?: string[]; items?: unknown; minItems?: number }>;
    required?: string[];
  };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
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
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, any>;
    headers: Record<string, string>;
    healthcheckPath?: string;
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

const HOST = 'https://fm.example.com';
const DB = 'Contacts';
const BASE = `${HOST}/fmi/data/vLatest/databases/${DB}`;
// Built at runtime so no literal looks like a real credential.
const FAKE_PASSWORD = ['Fm', 'x'.repeat(10), '.*-'].join('');
const FAKE_TOKEN = ['fm-session', 'x'.repeat(16)].join('-');
const ENV: Record<string, string> = {
  FILEMAKER_URL: HOST,
  FILEMAKER_DATABASE: DB,
  FILEMAKER_USERNAME: 'mcp-readonly',
  FILEMAKER_PASSWORD: FAKE_PASSWORD,
};
const config = { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService;

const stubLogin = (token = FAKE_TOKEN) => {
  const b = async () => ({ token, expiresAt: Date.now() + 900_000 });
  return { getToken: b, forceRelogin: b } as unknown as LoginTokenService;
};

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
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[0][0];
const mapped = (name: string, raw: unknown) =>
  applyResponseTransform(raw, tool(name).responseMapping as any).value as any;

const okLayouts = {
  response: {
    layouts: [
      { name: 'People', isFolder: false },
      { name: 'Reports', isFolder: true, folderLayoutNames: [{ name: 'Summary' }] },
    ],
  },
  messages: [{ code: '0', message: 'OK' }],
};
const okMeta = {
  response: {
    fieldMetaData: [{ name: 'Name', type: 'normal', result: 'text' }],
    portalMetaData: {},
    valueLists: [],
  },
  messages: [{ code: '0', message: 'OK' }],
};
const okFind = {
  response: {
    data: [{ recordId: '12', modId: '1', fieldData: { Name: 'Ada' } }],
    dataInfo: { foundCount: 1, returnedCount: 1 },
  },
  messages: [{ code: '0', message: 'OK' }],
};
const okRecord = {
  response: {
    data: [{ recordId: '12', modId: '1', fieldData: { Name: 'Ada' }, portalData: {} }],
    dataInfo: { foundCount: 1, returnedCount: 1 },
  },
  messages: [{ code: '0', message: 'OK' }],
};

describe('filemaker adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in at /sessions with Basic and sends the token as Bearer', () => {
    expect(a.category).toBe('database');
    expect(a.icon).toBe('filemaker');
    expect(a.connector.baseUrl).toBe(
      '{{FILEMAKER_URL}}/fmi/data/vLatest/databases/{{FILEMAKER_DATABASE}}',
    );
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toMatchObject({
      loginUrl: '{{FILEMAKER_URL}}/fmi/data/vLatest/databases/{{FILEMAKER_DATABASE}}/sessions',
      loginMethod: 'POST',
      loginBasicAuth: true,
      loginBody: {},
      username: '{{FILEMAKER_USERNAME}}',
      password: '{{FILEMAKER_PASSWORD}}',
      tokenJsonPath: 'response.token',
      tokenTTLSeconds: 900,
      refreshOn401: true,
      headerName: 'Authorization',
      headerTemplate: 'Bearer ${token}',
    });
    expect(a.connector.authConfig.proactiveRefreshSeconds).toBeLessThan(900);
    expect(a.connector.healthcheckPath).toBe('/layouts');
    expect(a.probe.tool).toBe('filemaker_list_layouts');
    expect(a.requiredEnvVars).toEqual([
      'FILEMAKER_URL',
      'FILEMAKER_DATABASE',
      'FILEMAKER_USERNAME',
      'FILEMAKER_PASSWORD',
    ]);
    for (const s of ['401', '403', '404', '500']) expect(a.verifyHints[s]).toBeTruthy();
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.FILEMAKER_URL).toMatchObject({ kind: 'address', secret: false });
    expect(meta.FILEMAKER_DATABASE).toMatchObject({ kind: 'setting', secret: false });
    expect(meta.FILEMAKER_USERNAME).toMatchObject({ kind: 'credential', secret: false });
    expect(meta.FILEMAKER_PASSWORD).toMatchObject({ kind: 'credential', secret: true });
  });

  it('accepts the Server address with an optional path and no trailing slash', () => {
    const url = new RegExp(a.envVarMeta.FILEMAKER_URL.pattern!);
    for (const good of [HOST, 'https://10.0.0.5', 'https://localhost', 'https://fm.example.com:443', 'https://fm.example.com/fms']) {
      expect(url.test(good)).toBe(true);
    }
    for (const bad of ['fm.example.com', `${HOST}/`, 'https://fm example.com']) {
      expect(url.test(bad)).toBe(false);
    }
  });

  it('logs in with POST and an empty JSON body, so the password never travels in the body', async () => {
    const auth = interpolateDeep(a.connector.authConfig, ENV) as any;
    mockedAxios.mockResolvedValueOnce({
      data: { response: { token: FAKE_TOKEN }, messages: [{ code: '0', message: 'OK' }] },
      headers: {},
    });
    const bundle = await new LoginTokenService({} as any, config).getToken(auth);
    const login = sent();
    expect(login.method).toBe('POST');
    expect(login.url).toBe(`${BASE}/sessions`);
    expect(login.data).toEqual({});
    expect(JSON.stringify(login.data ?? '')).not.toContain(FAKE_PASSWORD);
    expect(login.params).toBeUndefined();
    expect(bundle.token).toBe(FAKE_TOKEN);
    expect(bundle.expiresAt - Date.now()).toBeLessThanOrEqual(900_000);
  });

  it('sends Authorization: Basic base64(user:pass) on the login only, and Bearer on the tools', async () => {
    const auth = interpolateDeep(a.connector.authConfig, ENV) as any;
    mockedAxios.mockResolvedValueOnce({
      data: { response: { token: FAKE_TOKEN }, messages: [{ code: '0', message: 'OK' }] },
      headers: {},
    });
    const loginService = new LoginTokenService({} as any, config);
    await loginService.getToken(auth);
    const loginReq = sent();
    const basic = Buffer.from(`mcp-readonly:${FAKE_PASSWORD}`).toString('base64');
    expect(loginReq.headers.Authorization).toBe(`Basic ${basic}`);
    expect(loginReq.headers.Accept).toBe('application/json');
    expect(loginReq.headers['Content-Type']).toBe('application/json');
    expect(a.connector.authConfig.loginHeaders).not.toHaveProperty('Authorization');

    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: okLayouts });
    await call('filemaker_list_layouts', {}, ENV, loginService);
    expect(sent().headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(JSON.stringify(sent())).not.toContain(basic);
  });

  it('logs in again and retries once when FileMaker answers HTTP 401', async () => {
    const tokens = [FAKE_TOKEN, `${FAKE_TOKEN}-2`];
    const prisma = {
      connectorAuthCache: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
      },
    };
    const loginService = new LoginTokenService(prisma as never, config);
    let apiCalls = 0;
    mockedAxios.mockImplementation(async (cfg: any) => {
      if (String(cfg.url).endsWith('/sessions')) {
        return {
          data: { response: { token: tokens.shift() }, messages: [{ code: '0', message: 'OK' }] },
          headers: {},
        };
      }
      apiCalls += 1;
      if (apiCalls === 1) {
        const response = {
          status: 401,
          statusText: 'Unauthorized',
          data: { messages: [{ code: '952', message: 'Invalid FileMaker Data API token' }] },
          headers: {},
          config: cfg,
        };
        throw new AxiosError(
          'Request failed with status code 401',
          'ERR_BAD_REQUEST',
          cfg as never,
          null,
          response as never,
        );
      }
      return { data: okLayouts, headers: {} };
    });
    await call('filemaker_list_layouts', {}, ENV, loginService);
    const toolCalls = mockedAxios.mock.calls
      .map((c) => c[0])
      .filter((c: any) => !String(c.url).endsWith('/sessions'));
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(toolCalls[1].headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}-2`);
    const loginCalls = mockedAxios.mock.calls
      .map((c) => c[0])
      .filter((c: any) => String(c.url).endsWith('/sessions'));
    expect(loginCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('is read-only: three GET tools and one POST _find, nothing that writes records', () => {
    expect(a.tools).toHaveLength(4);
    expect(tool('filemaker_find_records').endpointMapping.method).toBe('POST');
    expect(tool('filemaker_find_records').endpointMapping.path).toBe('/layouts/{layout}/_find');
    for (const t of a.tools) {
      expect(deriveToolAnnotations({
        name: t.name,
        connectorType: 'REST',
        endpointMapping: t.endpointMapping,
        annotations: t.annotations,
      })).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.endpointMapping.path).not.toMatch(
        /\/records$|\/script\/|\/globals|\/containers/,
      );
      if (t.name !== 'filemaker_find_records') {
        expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      }
    }
  });

  it('percent-encodes path parameters on every tool with a {param} in its path', () => {
    const withParams = a.tools.filter((t) => /\{[^}]+\}/.test(t.endpointMapping.path));
    expect(withParams.map((t) => t.name).sort()).toEqual([
      'filemaker_find_records',
      'filemaker_get_layout_metadata',
      'filemaker_get_record',
    ]);
    for (const t of withParams) {
      expect({ name: t.name, encodePathParams: t.endpointMapping.encodePathParams }).toEqual({
        name: t.name,
        encodePathParams: true,
      });
    }
  });

  it('prefixes every tool and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^filemaker_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      const used = new Set<string>();
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      for (const v of Object.values(t.endpointMapping.queryParams ?? {})) {
        if (typeof v === 'string' && v.startsWith('$')) used.add(v.slice(1));
      }
      const walk = (node: unknown) => {
        if (typeof node === 'string' && node.startsWith('$') && !node.includes('${')) used.add(node.slice(1));
        else if (Array.isArray(node)) node.forEach(walk);
        else if (node && typeof node === 'object') Object.values(node as Record<string, unknown>).forEach(walk);
      };
      walk(t.endpointMapping.bodyMapping);
      const props = Object.keys(t.parameters.properties ?? {});
      expect(`${t.name}:${props.sort().join(',')}`).toBe(`${t.name}:${[...used].sort().join(',')}`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) {
        expect(t.parameters.required).toContain(p);
      }
      for (const [p, s] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof s.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
  });

  it('the find tool description states FileMaker code 401 is an empty result, not auth failure', () => {
    const d = tool('filemaker_find_records').description;
    expect(d).toMatch(/messages\[\]\.code ["']?401["']?/);
    expect(d).toMatch(/empty result/i);
    expect(d).toMatch(/HTTP 401/);
    expect(d).toMatch(/re-logs in|signs in again|relogin/i);
    expect(a.instructions).toMatch(/FileMaker code ["']?401["']?/);
    expect(a.instructions).toMatch(/empty result/i);
    expect(a.verifyHints['500']).toMatch(/401/);
  });

  it('instructions cover setup, SSRF allowlist, self-signed TLS, Cloud, privacy, errors and what is out of scope', () => {
    const i = a.instructions;
    expect(i).toMatch(/SSRF_ALLOWED_HOSTS/);
    expect(i).toMatch(/A self-signed certificate will fail: the connector offers no trust-anything switch\./);
    expect(i).toMatch(/NODE_EXTRA_CA_CERTS/);
    expect(i).toMatch(/Cloud can only reach .* public internet over HTTPS/);
    expect(i).toMatch(/Assign this connector only to MCP servers/);
    expect(i).toMatch(/fmrest/);
    expect(i).toMatch(/\*\*Out of scope\*\*: .*FileMaker Cloud/);
    const names = new Set(a.tools.map((t) => t.name));
    for (const m of [
      ...i.matchAll(/\bfilemaker_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bfilemaker_[a-z_]+/g)]),
    ]) {
      expect(names).toContain(m[0]);
    }
    for (const name of names) expect(i).toContain(`\`${name}\``);
    for (const t of a.tools) expect(t.description.length).toBeGreaterThanOrEqual(60);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<{ name: string; params: Record<string, unknown>; method: string; path: string; body?: unknown }> = [
    { name: 'filemaker_list_layouts', params: {}, method: 'GET', path: '/layouts' },
    { name: 'filemaker_get_layout_metadata', params: { layout: 'People' }, method: 'GET', path: '/layouts/People' },
    {
      name: 'filemaker_find_records',
      params: { layout: 'People', query: [{ Name: '=Ada' }], limit: '50' },
      method: 'POST',
      path: '/layouts/People/_find',
      body: { query: [{ Name: '=Ada' }], limit: '50' },
    },
    { name: 'filemaker_get_record', params: { layout: 'People', recordId: '12' }, method: 'GET', path: '/layouts/People/records/12' },
  ];
  it('lists every tool in the URL table', () =>
    expect(table.map((r) => r.name).sort()).toEqual(a.tools.map((t) => t.name).sort()));
  it.each(table)('$name sends the right method and URL with the Bearer token', async ({ name, params, method, path, body }) => {
    mockedAxios.mockResolvedValue({ data: okLayouts });
    await call(name, params);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${BASE}${path}`);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    if (body !== undefined) expect(req.data).toEqual(body);
    expect(JSON.stringify(req)).not.toContain('{{');
    expect(JSON.stringify(req)).not.toContain('$query');
  });

  it('encodes spaces in layout names on the path', async () => {
    mockedAxios.mockResolvedValue({ data: okMeta });
    await call('filemaker_get_layout_metadata', { layout: 'People List' });
    expect(sent().url).toBe(`${BASE}/layouts/People%20List`);
  });

  it('omits optional find body fields when they are not set', async () => {
    mockedAxios.mockResolvedValue({ data: okFind });
    await call('filemaker_find_records', { layout: 'People', query: [{ Name: '*'}] });
    expect(sent().data).toEqual({ query: [{ Name: '*' }] });
    expect(sent().data).not.toHaveProperty('limit');
    expect(sent().data).not.toHaveProperty('offset');
    expect(sent().data).not.toHaveProperty('sort');
  });

  it('every transform is valid and shapes the answers', () => {
    for (const t of a.tools) {
      if (t.responseMapping) expect(`${t.name}:${validateTransform(t.responseMapping.transform)}`).toBe(`${t.name}:null`);
    }
    expect(mapped('filemaker_list_layouts', okLayouts)).toEqual({
      layouts: okLayouts.response.layouts,
      messages: okLayouts.messages,
    });
    expect(mapped('filemaker_get_layout_metadata', okMeta)).toEqual({
      fieldMetaData: okMeta.response.fieldMetaData,
      portalMetaData: {},
      valueLists: [],
      messages: okMeta.messages,
    });
    expect(mapped('filemaker_find_records', okFind)).toEqual({
      records: okFind.response.data,
      dataInfo: okFind.response.dataInfo,
      messages: okFind.messages,
    });
    expect(mapped('filemaker_get_record', okRecord)).toEqual({
      record: okRecord.response.data[0],
      dataInfo: okRecord.response.dataInfo,
      messages: okRecord.messages,
    });
  });
});

const live =
  process.env.RUN_FILEMAKER_LIVE === '1' &&
  process.env.FILEMAKER_URL &&
  process.env.FILEMAKER_DATABASE &&
  process.env.FILEMAKER_USERNAME &&
  process.env.FILEMAKER_PASSWORD
    ? describe
    : describe.skip;

live('filemaker adapter: live (read-only)', () => {
  const env = {
    FILEMAKER_URL: (process.env.FILEMAKER_URL ?? '').replace(/\/$/, ''),
    FILEMAKER_DATABASE: process.env.FILEMAKER_DATABASE ?? '',
    FILEMAKER_USERNAME: process.env.FILEMAKER_USERNAME ?? '',
    FILEMAKER_PASSWORD: process.env.FILEMAKER_PASSWORD ?? '',
  };
  const preferredLayout = process.env.FILEMAKER_LAYOUT;
  const preferredRecordId = process.env.FILEMAKER_RECORD_ID;
  const body = (res: unknown) => res;
  let login: LoginTokenService;
  beforeAll(async () => {
    mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg));
    login = new LoginTokenService({} as any, config);
    const bundle = await login.getToken(interpolateDeep(a.connector.authConfig, env) as any, 'filemaker-live');
    expect(typeof bundle.token).toBe('string');
    expect(bundle.token.length).toBeGreaterThan(8);
  });

  it('a wrong password is refused at sign-in without echoing the credentials', async () => {
    const wrong = { ...env, FILEMAKER_PASSWORD: `${env.FILEMAKER_PASSWORD}-wrong` };
    const err: any = await new LoginTokenService({} as any, config)
      .getToken(interpolateDeep(a.connector.authConfig, wrong) as any, 'filemaker-live-wrong')
      .catch((e) => e);
    expect(err?.response?.status).toBe(401);
    const text = `${err.message} ${JSON.stringify({ c: err.config, r: err.response?.config })}`;
    expect(text).not.toContain(wrong.FILEMAKER_PASSWORD);
    expect(text).not.toContain(
      Buffer.from(`${env.FILEMAKER_USERNAME}:${wrong.FILEMAKER_PASSWORD}`).toString('base64'),
    );
  }, 30_000);

  it('lists layouts, reads metadata, finds and gets a record', async () => {
    const layouts = mapped('filemaker_list_layouts', body(await call('filemaker_list_layouts', {}, env, login)));
    expect(Array.isArray(layouts.layouts)).toBe(true);
    expect(layouts.layouts.length).toBeGreaterThan(0);
    const layout =
      preferredLayout ??
      layouts.layouts.find((l: any) => !l.isFolder)?.name ??
      layouts.layouts[0].name;
    const meta = mapped(
      'filemaker_get_layout_metadata',
      body(await call('filemaker_get_layout_metadata', { layout }, env, login)),
    );
    expect(Array.isArray(meta.fieldMetaData)).toBe(true);

    const field = meta.fieldMetaData.find((f: any) => f.name && f.result === 'text')?.name ?? meta.fieldMetaData[0]?.name;
    if (field) {
      try {
        const found = mapped(
          'filemaker_find_records',
          body(await call('filemaker_find_records', { layout, query: [{ [field]: '*' }], limit: '5' }, env, login)),
        );
        expect(Array.isArray(found.records)).toBe(true);
        const recordId = preferredRecordId ?? found.records[0]?.recordId;
        if (recordId) {
          const one = mapped(
            'filemaker_get_record',
            body(await call('filemaker_get_record', { layout, recordId: String(recordId) }, env, login)),
          );
          expect(one.record).toMatchObject({ recordId: String(recordId) });
        }
      } catch (e: any) {
        // Empty find on Servers that answer non-2xx (e.g. HTTP 500) + messages code 401.
        // FileMaker Server 26 answers HTTP 200 + code 401 instead, which lands in the try block as zero records.
        const code = e?.response?.data?.messages?.[0]?.code ?? e?.data?.messages?.[0]?.code;
        if (String(code) === '401') {
          expect(tool('filemaker_find_records').description).toMatch(/empty result/i);
        } else {
          throw e;
        }
      }
    }
  }, 60_000);
});
