import axios from 'axios';
import * as adapter from './snyk.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Snyk REST API (apidocs.snyk.io, OpenAPI at <region>/rest/openapi/2026-03-25,
 * every REST call carries version=2026-03-25) plus the v1 API where REST has no
 * equivalent (OpenAPI v1-api-spec.yaml in snyk/user-docs): aggregated issues,
 * issue paths, dependencies, integrations, project tags and attributes, and
 * ignores. Auth is `Authorization: token <key>` on every regional host
 * (api.snyk.io, api.us.snyk.io, api.eu.snyk.io, api.au.snyk.io, api.snykgov.io).
 * Paths and fields were checked against both documents (read 30 Oct 2026) and
 * the snyk-labs/pysnyk client. With a fake token /rest/self, /rest/orgs/{id}/issues
 * and /v1/org/{id}/project/{id}/ignores answered 401 (also on the us, eu and au
 * hosts) and an unknown route 404 on 30 Oct 2026.
 *
 * Live part (reads only: self, orgs, projects, issues, targets, members, policies, a package check):
 *   RUN_SNYK_LIVE=1 SNYK_TOKEN=... [SNYK_API_URL=https://api.eu.snyk.io] npx jest src/adapters/intl/snyk.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; enum?: unknown[]; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown>; exposeHeaders?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath?: string };
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
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping as never, annotations: t.annotations });

const HOST = 'https://api.eu.snyk.io';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = ['0'.repeat(8), '0'.repeat(4), '0'.repeat(4), '0'.repeat(4), '0'.repeat(12)].join('-');
const ENV: Record<string, string> = { SNYK_API_URL: HOST, SNYK_TOKEN: FAKE_TOKEN };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, tool(name).endpointMapping as never, ENV);
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, ENV), headers: config.headers } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  ) as Promise<unknown>;
};
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = [
  'snyk_add_project_tag',
  'snyk_create_ignore',
  'snyk_delete_ignore',
  'snyk_remove_project_tag',
  'snyk_set_project_attributes',
];
const SWITCHED_OFF = ['snyk_delete_ignore'];
const VERSION = '2026-03-25';
const O = '9a3e5d90-b782-468a-a042-9a2073736f0b';
const P = '4a18d42f-0706-4ad0-b127-24078731fbed';
const ISSUE = 'SNYK-JS-LODASH-567746';

describe('snyk adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends "Authorization: token <key>" to the chosen region and checks it on /rest/self', () => {
    expect(a.icon).toBe('snyk');
    expect(a.requiredEnvVars).toEqual(['SNYK_API_URL', 'SNYK_TOKEN']);
    expect(a.connector.baseUrl).toBe('{{SNYK_API_URL}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'token {{SNYK_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe(`/rest/self?version=${VERSION}`);
    expect(a.envVarMeta.SNYK_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    const region = new RegExp(a.envVarMeta.SNYK_API_URL.pattern!);
    for (const ok of ['https://api.snyk.io', 'https://api.us.snyk.io', 'https://api.eu.snyk.io', 'https://api.au.snyk.io', 'https://api.snykgov.io']) expect(`${ok}:${region.test(ok)}`).toBe(`${ok}:true`);
    for (const bad of ['https://api.snyk.io/', 'https://api.snyk.io/rest', 'https://app.snyk.io', 'http://api.snyk.io', 'https://api.evil.io']) expect(`${bad}:${region.test(bad)}`).toBe(`${bad}:false`);
    const token = new RegExp(a.envVarMeta.SNYK_TOKEN.pattern!);
    expect(token.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', 'short', `token ${FAKE_TOKEN}`, `Bearer ${FAKE_TOKEN}`]) expect(token.test(bad)).toBe(false);
  });

  it('every tool is prefixed and unique in the catalog, every declared parameter reaches the request and path parameters are required', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)?.tools ?? []) expect(mine.has(t.name)).toBe(false);
    }
    for (const t of a.tools) {
      expect(t.name).toMatch(/^snyk_[a-z_]+$/);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
    }
  });

  it('pins the REST version on every REST tool and keeps v1 calls unversioned', () => {
    for (const t of a.tools) {
      const isRest = t.endpointMapping.path.startsWith('/rest/');
      const isV1 = t.endpointMapping.path.startsWith('/v1/');
      expect(`${t.name}:${isRest || isV1}`).toBe(`${t.name}:true`);
      expect(`${t.name}:${t.endpointMapping.queryParams?.version}`).toBe(`${t.name}:${isRest ? VERSION : undefined}`);
      if (isRest) expect(t.endpointMapping.method).toBe('GET');
    }
  });

  it('knows exactly which tools write, asks for confirmation on each and switches off the ignore delete', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of WRITES) expect(`${name}:${/agree/i.test(tool(name).description)}`).toBe(`${name}:true`);
    expect(a.tools.filter((t) => t.endpointMapping.method === 'DELETE').map((t) => t.name)).toEqual(SWITCHED_OFF);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(SWITCHED_OFF);
    expect(a.instructions).toContain('**Switched off at install**: `snyk_delete_ignore`; it cannot be undone');
    for (const name of ['snyk_list_aggregated_issues', 'snyk_list_dependencies']) {
      expect(tool(name).endpointMapping.method).toBe('POST');
      expect(annotationsOf(tool(name)).readOnlyHint).toBe(true);
    }
  });

  it('probes with a read tool and documents every tool in the instructions, without em dashes', () => {
    expect(a.probe.tool).toBe('snyk_get_self');
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
    expect(annotationsOf(tool(a.probe.tool)).readOnlyHint).toBe(true);
    const names = new Set(a.tools.map((t) => t.name));
    for (const name of names) expect(`${name}:${a.instructions.includes(`\`${name}\``)}`).toBe(`${name}:true`);
    for (const [m] of [...a.instructions.matchAll(/\bsnyk_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bsnyk_[a-z_]+/g)])]) expect(names).toContain(m);
    expect(a.instructions).toContain('snyk@latest mcp -t stdio');
    expect(JSON.stringify(adapter)).not.toMatch(/\u2014/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['snyk_get_self', {}, 'GET', '/rest/self'],
    ['snyk_list_orgs', {}, 'GET', '/rest/orgs'],
    ['snyk_get_org', { org_id: O }, 'GET', `/rest/orgs/${O}`],
    ['snyk_list_projects', { org_id: O }, 'GET', `/rest/orgs/${O}/projects`],
    ['snyk_get_project', { org_id: O, project_id: P }, 'GET', `/rest/orgs/${O}/projects/${P}`],
    ['snyk_list_issues', { org_id: O }, 'GET', `/rest/orgs/${O}/issues`],
    ['snyk_list_project_issues', { org_id: O, project_id: P }, 'GET', `/rest/orgs/${O}/issues`],
    ['snyk_get_issue', { org_id: O, issue_id: P }, 'GET', `/rest/orgs/${O}/issues/${P}`],
    ['snyk_list_targets', { org_id: O }, 'GET', `/rest/orgs/${O}/targets`],
    ['snyk_get_target', { org_id: O, target_id: P }, 'GET', `/rest/orgs/${O}/targets/${P}`],
    ['snyk_get_project_sbom', { org_id: O, project_id: P }, 'GET', `/rest/orgs/${O}/projects/${P}/sbom`],
    ['snyk_list_package_issues', { org_id: O, purl: 'pkg:npm/lodash@4.17.20' }, 'GET', `/rest/orgs/${O}/packages/pkg%3Anpm%2Flodash%404.17.20/issues`],
    ['snyk_list_org_members', { org_id: O }, 'GET', `/rest/orgs/${O}/memberships`],
    ['snyk_list_policies', { org_id: O }, 'GET', `/rest/orgs/${O}/policies`],
    ['snyk_get_policy', { org_id: O, policy_id: P }, 'GET', `/rest/orgs/${O}/policies/${P}`],
    ['snyk_list_aggregated_issues', { org_id: O, project_id: P }, 'POST', `/v1/org/${O}/project/${P}/aggregated-issues`],
    ['snyk_list_issue_paths', { org_id: O, project_id: P, issue_id: ISSUE }, 'GET', `/v1/org/${O}/project/${P}/issue/${ISSUE}/paths`],
    ['snyk_list_dependencies', { org_id: O }, 'POST', `/v1/org/${O}/dependencies`],
    ['snyk_list_project_ignores', { org_id: O, project_id: P }, 'GET', `/v1/org/${O}/project/${P}/ignores`],
    ['snyk_list_integrations', { org_id: O }, 'GET', `/v1/org/${O}/integrations`],
    ['snyk_add_project_tag', { org_id: O, project_id: P, key: 'team', value: 'payments' }, 'POST', `/v1/org/${O}/project/${P}/tags`],
    ['snyk_remove_project_tag', { org_id: O, project_id: P, key: 'team', value: 'payments' }, 'POST', `/v1/org/${O}/project/${P}/tags/remove`],
    ['snyk_set_project_attributes', { org_id: O, project_id: P, lifecycle: ['production'] }, 'POST', `/v1/org/${O}/project/${P}/attributes`],
    ['snyk_create_ignore', { org_id: O, project_id: P, issue_id: ISSUE, reasonType: 'wont-fix', reason: 'x' }, 'POST', `/v1/org/${O}/project/${P}/ignore/${ISSUE}`],
    ['snyk_delete_ignore', { org_id: O, project_id: P, issue_id: ISSUE }, 'DELETE', `/v1/org/${O}/project/${P}/ignore/${ISSUE}`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the token header', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${path}`);
    expect(req.headers.Authorization).toBe(`token ${FAKE_TOKEN}`);
    expect(JSON.stringify(req)).not.toContain('{{');
  });

  it('builds the documented query strings and bodies', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('snyk_list_project_issues', { org_id: O, project_id: P, effective_severity_level: 'critical,high', status: 'open' });
    expect(sent().params).toEqual({ version: VERSION, 'scan_item.id': P, 'scan_item.type': 'project', effective_severity_level: 'critical,high', status: 'open', limit: 20 });
    mockedAxios.mockClear();
    await call('snyk_list_issues', { org_id: O, type: 'code' });
    expect(sent().params).toEqual({ version: VERSION, type: 'code', limit: 20 });
    mockedAxios.mockClear();
    await call('snyk_list_projects', { org_id: O, tags: 'team:payments' });
    expect(sent().params).toEqual({ version: VERSION, tags: 'team:payments', 'meta.latest_issue_counts': true, limit: 20 });
    mockedAxios.mockClear();
    await call('snyk_get_project_sbom', { org_id: O, project_id: P });
    expect(sent().params).toEqual({ version: VERSION, format: 'cyclonedx1.6+json' });
    mockedAxios.mockClear();
    await call('snyk_list_aggregated_issues', { org_id: O, project_id: P, severities: ['critical'], ignored: false });
    expect(sent().data).toEqual({ filters: { severities: ['critical'], ignored: false } });
    mockedAxios.mockClear();
    await call('snyk_list_dependencies', { org_id: O, projects: [P], sortBy: 'severity' });
    expect(sent().params).toEqual({ sortBy: 'severity', perPage: 100 });
    expect(sent().data).toEqual({ filters: { projects: [P] } });
    mockedAxios.mockClear();
    await call('snyk_create_ignore', { org_id: O, project_id: P, issue_id: ISSUE, reasonType: 'temporary-ignore', reason: 'Fix planned', expires: '2026-12-31T00:00:00Z' });
    expect(sent().data).toEqual({ reasonType: 'temporary-ignore', reason: 'Fix planned', expires: '2026-12-31T00:00:00Z', disregardIfFixable: false });
    mockedAxios.mockClear();
    await call('snyk_set_project_attributes', { org_id: O, project_id: P, criticality: ['high'], environment: ['backend', 'external'] });
    expect(sent().data).toEqual({ criticality: ['high'], environment: ['backend', 'external'] });
  });
});

const live = process.env.RUN_SNYK_LIVE === '1' && process.env.SNYK_TOKEN ? describe : describe.skip;
live('snyk adapter: live (read-only)', () => {
  const base = process.env.SNYK_API_URL || 'https://api.snyk.io';
  const get = async (path: string) => {
    const sep = path.includes('?') ? '&' : '?';
    const res = await mockedAxios.__actual.get(`${base}/rest${path}${sep}version=${VERSION}`, { headers: { Authorization: `token ${process.env.SNYK_TOKEN}` }, validateStatus: () => true });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return res.data as any;
  };
  it('reads self, orgs, projects, issues, targets, members, policies and a package check', async () => {
    expect((await get('/self')).data.id).toBeTruthy();
    const orgs = (await get('/orgs?limit=5')).data as Array<{ id: string }>;
    expect(Array.isArray(orgs)).toBe(true);
    if (!orgs[0]) return;
    const org = orgs[0].id;
    expect(Array.isArray((await get(`/orgs/${org}/projects?limit=5`)).data)).toBe(true);
    expect(Array.isArray((await get(`/orgs/${org}/issues?limit=5`)).data)).toBe(true);
    expect(Array.isArray((await get(`/orgs/${org}/targets?limit=5`)).data)).toBe(true);
    expect(Array.isArray((await get(`/orgs/${org}/memberships?limit=5`)).data)).toBe(true);
    expect(Array.isArray((await get(`/orgs/${org}/policies?limit=5`)).data)).toBe(true);
    expect(Array.isArray((await get(`/orgs/${org}/packages/${encodeURIComponent('pkg:npm/lodash@4.17.20')}/issues?limit=5`)).data)).toBe(true);
  }, 60_000);
});
