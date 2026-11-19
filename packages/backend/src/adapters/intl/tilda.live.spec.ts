import axios from 'axios';
import * as adapter from './tilda.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Tilda Publishing API adapter (read-only).
 *
 * Static checks always run: the public and secret key as query parameters,
 * the seven documented GET requests with their trailing slash, the project
 * and page id parameters, and the rule that turns a status ERROR body into a
 * failed call.
 * https://help.tilda.cc/api
 *
 * Live checks run only with RUN_TILDA_LIVE=1. Without credentials they
 * confirm that the API refuses made-up keys with status ERROR; with
 * TILDA_PUBLIC_KEY and TILDA_SECRET_KEY they list the projects (one of the
 * 150 requests per hour). Reads only.
 *
 *   RUN_TILDA_LIVE=1 TILDA_PUBLIC_KEY=... TILDA_SECRET_KEY=... \
 *     npx jest src/adapters/intl/tilda.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; type?: string; pattern?: string; default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    bodyEncoding?: string;
    envDefaults?: Record<string, string>;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
  responseMapping?: { transform?: { exclude?: string[] } };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  instructions: string;
  aliases?: string[];
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean; options?: Array<{ value: string; label: string }> }>;
  verifyHints: Record<string, unknown>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
    config?: { errorWhen?: unknown };
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
// Every argument a mapping reads: {path} parts, "$name" values and ${name} in strings.
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

const ENV: Record<string, string> = {
  TILDA_PUBLIC_KEY: 'abcdefghij0123456789',
  TILDA_SECRET_KEY: 'zyxwvutsrq9876543210',
};

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  const tokens = { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService;
  return new RestEngine(tokens, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: cfg.headers,
      errorWhen: a.connector.config?.errorWhen,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (data: unknown = {}, status = 200) => mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
// The query string as it goes over the wire, percent-decoded for reading.
const wire = (req: { params: Record<string, unknown>; paramsSerializer: (p: Record<string, unknown>) => string }) =>
  decodeURIComponent(req.paramsSerializer(req.params));

// name, HTTP method, path
const TOOLS: Array<[string, string, string]> = [
  ['tilda_list_projects', 'GET', '/getprojectslist/'],
  ['tilda_get_project', 'GET', '/getprojectinfo/'],
  ['tilda_list_pages', 'GET', '/getpageslist/'],
  ['tilda_get_page', 'GET', '/getpage/'],
  ['tilda_get_page_full', 'GET', '/getpagefull/'],
  ['tilda_get_page_export', 'GET', '/getpageexport/'],
  ['tilda_get_page_full_export', 'GET', '/getpagefullexport/'],
];
const REQUIRED: Record<string, string[]> = {
  tilda_get_project: ['project_id'],
  tilda_list_pages: ['project_id'],
  tilda_get_page: ['page_id'],
  tilda_get_page_full: ['page_id'],
  tilda_get_page_export: ['page_id'],
  tilda_get_page_full_export: ['page_id'],
};
const OFF: string[] = [];

describe('tilda adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the public and secret key as query parameters', () => {
    expect(a.slug).toBe('tilda');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('cms');
    expect(a.icon).toBe('tilda');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://api.tildacdn.info/v1');
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ publickey: '{{TILDA_PUBLIC_KEY}}', secretkey: '{{TILDA_SECRET_KEY}}' });
    expect(a.requiredEnvVars).toEqual(['TILDA_PUBLIC_KEY', 'TILDA_SECRET_KEY']);
    expect(a.envVarMeta.TILDA_SECRET_KEY).toMatchObject({ kind: 'credential', secret: true });
    for (const name of a.requiredEnvVars) {
      const pattern = new RegExp(a.envVarMeta[name].pattern!);
      expect(pattern.test(ENV[name])).toBe(true);
      expect(pattern.test('00000000000000000000')).toBe(true);
      expect(pattern.test('publickey=abc')).toBe(false);
    }
    expect(a.probe).toEqual({ tool: 'tilda_list_projects', params: {} });
    for (const key of ['401', '404', '409', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    expect(a.instructions).toContain('150 requests per hour');
    expect(a.instructions).toContain('Business');
  });

  it('is read-only and reports a status ERROR body as a failed call', () => {
    for (const entry of a.tools) {
      expect(entry.endpointMapping.method).toBe('GET');
      expect(entry.endpointMapping.path).toMatch(/^\/get[a-z]+\/$/);
      expect(entry.enabled).toBeUndefined();
    }
    const rules = a.connector.config?.errorWhen as Array<{ path: string; equals: string; status: number }>;
    expect(rules.map((rule) => [rule.path, rule.equals, rule.status])).toEqual([
      ['status', 'ERROR', 401],
      ['status', 'ERROR', 400],
    ]);
  });

  it('pins every tool to its documented method and path', () => {
    expect(a.tools.map((entry) => [entry.name, entry.endpointMapping.method, entry.endpointMapping.path])).toEqual(TOOLS);
  });

  it('requires exactly the documented parameters', () => {
    for (const entry of a.tools) expect([entry.name, entry.parameters.required ?? []]).toEqual([entry.name, REQUIRED[entry.name] ?? []]);
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^tilda_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect([entry.name, arg, declared.has(arg) || envNames.has(arg)]).toEqual([entry.name, arg, true]);
      for (const arg of declared) expect([entry.name, arg, used(entry).has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const [param, def] of Object.entries(entry.parameters.properties ?? {})) expect([param, Boolean(def.description)]).toEqual([param, true]);
      expect(entry.description.length).toBeGreaterThan(60);
    }
  });

  it('marks reads read-only and installs only the listed tools switched off', () => {
    for (const entry of a.tools) {
      const read = entry.endpointMapping.method === 'GET';
      expect([entry.name, annotationsOf(entry).readOnlyHint]).toEqual([entry.name, read]);
    }
    expect(a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name).sort()).toEqual([...OFF].sort());
  });

  it('names every tool in the instructions and keeps the text free of MDX traps', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    const outsideCode = (text: string) => text.replace(/`[^`]*`/g, '');
    for (const text of [a.instructions, ...a.tools.map((entry) => entry.description)]) {
      expect(outsideCode(text)).not.toMatch(/[{}<]/);
      expect(text).not.toMatch(/\u2014/);
    }
  });

  it('asks for projects, pages and page HTML with the keys in the query', async () => {
    const keys = `publickey=${ENV.TILDA_PUBLIC_KEY}&secretkey=${ENV.TILDA_SECRET_KEY}`;

    ok({ status: 'FOUND', result: [] });
    await call('tilda_list_pages', { project_id: '1234567' });
    const req = sent();
    expect(req.url).toBe('https://api.tildacdn.info/v1/getpageslist/');
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Accept')).toBe('application/json');
    expect(wire(req)).toBe(`${keys}&projectid=1234567`);

    ok({ status: 'FOUND', result: [] });
    await call('tilda_list_projects', {});
    expect(sent().url).toBe('https://api.tildacdn.info/v1/getprojectslist/');
    expect(sent().params).toEqual({ publickey: ENV.TILDA_PUBLIC_KEY, secretkey: ENV.TILDA_SECRET_KEY });

    ok({ status: 'FOUND', result: {} });
    await call('tilda_get_project', { project_id: '1234567', webconfig: 'nginx' });
    expect(sent().url).toBe('https://api.tildacdn.info/v1/getprojectinfo/');
    expect(wire(sent())).toBe(`${keys}&projectid=1234567&webconfig=nginx`);

    for (const [name, path] of [
      ['tilda_get_page', 'getpage'],
      ['tilda_get_page_full', 'getpagefull'],
      ['tilda_get_page_export', 'getpageexport'],
      ['tilda_get_page_full_export', 'getpagefullexport'],
    ]) {
      ok({ status: 'FOUND', result: { id: '1001' } });
      await call(name, { page_id: '1001' });
      expect(sent().url).toBe(`https://api.tildacdn.info/v1/${path}/`);
      expect(wire(sent())).toBe(`${keys}&pageid=1001`);
    }
  });

  it('fails the call when Tilda answers status ERROR', async () => {
    ok({ status: 'ERROR', message: 'Wrong public key', errorside: 'info' });
    await expect(call('tilda_list_projects', {})).rejects.toThrow(/Wrong public key/);

    ok({ status: 'ERROR', message: 'Bad request line. Missing parameter: projectid' });
    await expect(call('tilda_list_pages', { project_id: '1' })).rejects.toThrow(/Missing parameter/);

    ok({ status: 'FOUND', result: [{ id: '1', title: 'First Project', descr: '' }] });
    await expect(call('tilda_list_projects', {})).resolves.toEqual({ status: 'FOUND', result: [{ id: '1', title: 'First Project', descr: '' }] });
  });
});

// Opt-in: RUN_TILDA_LIVE=1. The refusal check needs no account; the read
// needs TILDA_PUBLIC_KEY and TILDA_SECRET_KEY and uses one of the 150
// requests per hour. Nothing is written (the API cannot write).
const live = process.env.RUN_TILDA_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('tilda: live', () => {
  it('refuses made-up keys with status ERROR', async () => {
    const response = await liveFetch.get('https://api.tildacdn.info/v1/getprojectslist/', {
      params: { publickey: '00000000000000000000', secretkey: '00000000000000000000' },
      validateStatus: () => true,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.data.status).toBe('ERROR');
  });

  it('lists the projects', async () => {
    const publickey = process.env.TILDA_PUBLIC_KEY;
    const secretkey = process.env.TILDA_SECRET_KEY;
    if (!publickey || !secretkey) return;
    const response = await liveFetch.get('https://api.tildacdn.info/v1/getprojectslist/', { params: { publickey, secretkey }, validateStatus: () => true });
    expect(response.status).toBe(200);
    expect(response.data.status).toBe('FOUND');
  });
});
