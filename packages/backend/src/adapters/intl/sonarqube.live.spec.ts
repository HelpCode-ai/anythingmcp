import axios from 'axios';
import * as adapter from './sonarqube.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the SonarQube adapter:
 *
 *   1. Static: always runs. Pins Bearer auth on `{{SONARQUBE_URL}}/api`,
 *      checks every tool is a read-only GET, and checks the requests that
 *      differ between SonarQube Server and SonarQube Cloud: listing projects
 *      sends both `qualifiers=TRK` (Server) and `organization` (Cloud), and
 *      issue search filters by `componentKeys` with the impact filters.
 *
 *   2. Live: skipped unless RUN_SONARQUBE_LIVE=1.
 *      With SONARQUBE_URL, SONARQUBE_TOKEN and, for SonarQube Cloud,
 *      SONARQUBE_ORGANIZATION, they list projects and read the quality gate,
 *      measures and issues of the first one. Nothing is written.
 *
 *        RUN_SONARQUBE_LIVE=1 npx jest src/adapters/intl/sonarqube.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  docsUrl: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const FAKE_TOKEN = 'squ_' + 'a'.repeat(40);
const SERVER: Record<string, string> = { SONARQUBE_URL: 'https://sonar.example.com', SONARQUBE_TOKEN: FAKE_TOKEN };
const CLOUD: Record<string, string> = {
  SONARQUBE_URL: 'https://sonarcloud.io',
  SONARQUBE_TOKEN: FAKE_TOKEN,
  SONARQUBE_ORGANIZATION: 'my-org',
};

const call = (name: string, params: Record<string, unknown>, env = SERVER) => {
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
const query = () => {
  const req = sent();
  return new URLSearchParams(req.paramsSerializer ? req.paramsSerializer(req.params) : '');
};

describe('sonarqube adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed and categorized as infrastructure', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.category).toBe('infrastructure');
    expect(a.icon).toBe('sonarqube');
    expect(a.docsUrl).toMatch(/^https:\/\/docs\.sonarsource\.com\//);
  });

  it('sends a Bearer token to the SonarQube address with /api', () => {
    expect(a.connector.baseUrl).toBe('{{SONARQUBE_URL}}/api');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{SONARQUBE_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['SONARQUBE_URL', 'SONARQUBE_TOKEN']);
    expect(a.optionalEnvVars).toEqual(['SONARQUBE_ORGANIZATION']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.SONARQUBE_URL).toMatchObject({ kind: 'address', secret: false });
    expect(meta.SONARQUBE_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    expect(meta.SONARQUBE_ORGANIZATION).toMatchObject({ kind: 'setting', secret: false });
  });

  it('probes with the project list, not api/authentication/validate', () => {
    // authentication/validate answers {"valid":true} without a token too.
    expect(a.probe.tool).toBe('sonarqube_list_projects');
    expect(JSON.stringify(adapter)).not.toContain('authentication/validate');
  });

  it('accepts Cloud and Server addresses, with a context path, but not /api or a trailing slash', () => {
    const url = new RegExp(a.envVarMeta.SONARQUBE_URL.pattern!);
    for (const ok of ['https://sonarcloud.io', 'https://sonarqube.us', 'https://sonar.example.com', 'https://example.com/sonarqube', 'http://localhost:9000']) {
      expect(url.test(ok)).toBe(true);
    }
    for (const bad of ['sonarcloud.io', 'https://sonarcloud.io/', 'https://sonarcloud.io/api', 'https://sonar.example.com/api/']) {
      expect(url.test(bad)).toBe(false);
    }
    const token = new RegExp(a.envVarMeta.SONARQUBE_TOKEN.pattern!);
    expect(token.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', 'short', `Bearer ${FAKE_TOKEN}`]) expect(token.test(bad)).toBe(false);
  });

  it('explains a missing organization, wrong tokens, permissions, a wrong URL and rate limits', () => {
    for (const key of ['400', '401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool with sonarqube_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^sonarqube_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('has exactly 7 tools and all are read-only GET methods', () => {
    expect(a.tools.length).toBe(7);
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(t.endpointMapping.bodyMapping).toBeUndefined();
      expect(annotationsOf(t)).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    expect(a.tools.some((t) => ['DELETE', 'PUT', 'PATCH', 'POST'].includes(t.endpointMapping.method))).toBe(false);
  });

  it('only points the model at tools that exist, and descriptions meet minimum length', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bsonarqube_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bsonarqube_[a-z_]+/g)]),
      ...a.tools.flatMap((t) => Object.values(t.parameters.properties ?? {}).flatMap((p) => [...(p.description ?? '').matchAll(/\bsonarqube_[a-z_]+/g)])),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('instructions meet the 800-character minimum and cover setup, Cloud and the quality-gate fallback', () => {
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    for (const text of [
      'https://sonarcloud.io',
      'https://sonarqube.us',
      '/sonarqube',
      '**User**',
      'SONARQUBE_ORGANIZATION',
      'SSRF_ALLOWED_HOSTS',
      'alert_status,quality_gate_details',
      'software_quality_security_issues',
      '429',
      'Out of scope',
    ]) {
      expect(a.instructions).toContain(text);
    }
  });

  const table: Array<[string, Record<string, unknown>, string]> = [
    ['sonarqube_list_projects', {}, '/components/search'],
    ['sonarqube_get_quality_gate_status', { projectKey: 'payments-api' }, '/qualitygates/project_status'],
    ['sonarqube_get_measures', { component: 'payments-api', metricKeys: 'coverage' }, '/measures/component'],
    ['sonarqube_get_measures_history', { component: 'payments-api', metrics: 'coverage' }, '/measures/search_history'],
    ['sonarqube_search_issues', { componentKeys: 'payments-api' }, '/issues/search'],
    ['sonarqube_list_project_analyses', { project: 'payments-api' }, '/project_analyses/search'],
    ['sonarqube_list_branches', { project: 'payments-api' }, '/project_branches/list'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends GET to the right URL with the Bearer token', async (name, params, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`https://sonar.example.com/api${path}`);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(JSON.stringify(req)).not.toContain('{{');
    expect(JSON.stringify(req)).not.toContain('${');
  });

  it('keeps a Server context path', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('sonarqube_list_projects', {}, { ...SERVER, SONARQUBE_URL: 'https://example.com/sonarqube' });
    expect(sent().url).toBe('https://example.com/sonarqube/api/components/search');
  });

  it('lists projects with qualifiers=TRK and no organization on Server', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('sonarqube_list_projects', { q: 'pay' });
    const q = query();
    expect(q.get('qualifiers')).toBe('TRK');
    expect(q.has('organization')).toBe(false);
    expect(q.get('q')).toBe('pay');
    expect(q.get('p')).toBe('1');
    expect(q.get('ps')).toBe('100');
  });

  it('lists projects with both qualifiers=TRK and the organization on Cloud', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('sonarqube_list_projects', {}, CLOUD);
    expect(sent().url).toBe('https://sonarcloud.io/api/components/search');
    const q = query();
    expect(q.get('qualifiers')).toBe('TRK');
    expect(q.get('organization')).toBe('my-org');
  });

  it('searches issues by componentKeys with the impact filters, not the deprecated ones', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(
      'sonarqube_search_issues',
      {
        componentKeys: 'payments-api',
        issueStatuses: 'OPEN,CONFIRMED',
        impactSeverities: 'HIGH,BLOCKER',
        impactSoftwareQualities: 'SECURITY',
        createdAfter: '2026-06-01',
        assigned: false,
        branch: 'develop',
      },
      CLOUD,
    );
    const q = query();
    expect(q.get('componentKeys')).toBe('payments-api');
    expect(q.get('organization')).toBe('my-org');
    expect(q.get('issueStatuses')).toBe('OPEN,CONFIRMED');
    expect(q.get('impactSeverities')).toBe('HIGH,BLOCKER');
    expect(q.get('impactSoftwareQualities')).toBe('SECURITY');
    expect(q.get('createdAfter')).toBe('2026-06-01');
    expect(q.get('assigned')).toBe('false');
    expect(q.get('branch')).toBe('develop');
    for (const deprecated of ['components', 'types', 'severities', 'statuses']) expect(q.has(deprecated)).toBe(false);
  });

  it('reads the quality gate and measures of a branch or pull request', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('sonarqube_get_quality_gate_status', { projectKey: 'payments-api', pullRequest: '42' });
    let q = query();
    expect(q.get('projectKey')).toBe('payments-api');
    expect(q.get('pullRequest')).toBe('42');
    expect(q.has('branch')).toBe(false);

    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('sonarqube_get_measures', { component: 'payments-api', metricKeys: 'alert_status,quality_gate_details', branch: 'develop' });
    q = query();
    expect(q.get('metricKeys')).toBe('alert_status,quality_gate_details');
    expect(q.get('branch')).toBe('develop');
  });

  it('pages measure history up to 1000 per page', async () => {
    expect((tool('sonarqube_get_measures_history').parameters.properties!.ps as { maximum?: number }).maximum).toBe(1000);
    mockedAxios.mockResolvedValue({ data: {} });
    await call('sonarqube_get_measures_history', { component: 'payments-api', metrics: 'coverage', from: '2026-06-01', ps: 1000 });
    const q = query();
    expect(q.get('metrics')).toBe('coverage');
    expect(q.get('from')).toBe('2026-06-01');
    expect(q.get('ps')).toBe('1000');
  });
});

const live = process.env.RUN_SONARQUBE_LIVE === '1' ? describe : describe.skip;
live('sonarqube adapter: live', () => {
  const liveEnv = (): Record<string, string> => {
    for (const name of ['SONARQUBE_URL', 'SONARQUBE_TOKEN']) {
      if (!process.env[name]?.trim()) throw new Error(`Set ${name} before running SonarQube live tests`);
    }
    return {
      SONARQUBE_URL: process.env.SONARQUBE_URL!,
      SONARQUBE_TOKEN: process.env.SONARQUBE_TOKEN!,
      ...(process.env.SONARQUBE_ORGANIZATION ? { SONARQUBE_ORGANIZATION: process.env.SONARQUBE_ORGANIZATION } : {}),
    };
  };
  const firstProject = async (env: Record<string, string>) => {
    const projects = await call('sonarqube_list_projects', { ps: 5 }, env);
    expect(Array.isArray(projects?.components)).toBe(true);
    if (!projects.components.length) throw new Error('The token sees no analyzed project; analyze one first');
    return projects.components[0].key as string;
  };

  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it('lists projects and reads the quality gate of the first one', async () => {
    const env = liveEnv();
    const key = await firstProject(env);
    const gate = await call('sonarqube_get_quality_gate_status', { projectKey: key }, env);
    expect(gate?.projectStatus?.status).toMatch(/^(OK|WARN|ERROR|NONE)$/);
  }, 30000);

  it('reads measures and their history', async () => {
    const env = liveEnv();
    const key = await firstProject(env);
    const measures = await call('sonarqube_get_measures', { component: key, metricKeys: 'ncloc,alert_status' }, env);
    expect(measures?.component?.key).toBe(key);
    const history = await call('sonarqube_get_measures_history', { component: key, metrics: 'ncloc' }, env);
    expect(Array.isArray(history?.measures)).toBe(true);
  }, 30000);

  it('searches open issues, lists analyses and branches', async () => {
    const env = liveEnv();
    const key = await firstProject(env);
    const issues = await call('sonarqube_search_issues', { componentKeys: key, issueStatuses: 'OPEN,CONFIRMED', ps: 5 }, env);
    expect(typeof issues?.paging?.total).toBe('number');
    const analyses = await call('sonarqube_list_project_analyses', { project: key, ps: 5 }, env);
    expect(Array.isArray(analyses?.analyses)).toBe(true);
    const branches = await call('sonarqube_list_branches', { project: key }, env);
    expect(branches?.branches?.some((b: { isMain?: boolean }) => b.isMain)).toBe(true);
  }, 60000);
});
