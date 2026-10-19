import axios from 'axios';
import * as adapter from './yandex-direct.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Yandex Direct adapter (API v5, v501 URLs):
 *
 *   1. Static: always runs. Pins the OAuth token as Bearer, the optional
 *      Client-Login header, every service URL and its {"method":"get"} body
 *      through the real RestEngine against Yandex's API reference, the
 *      Reports request (TSV, decimals, retryIn header passed back) and the
 *      errorWhen rules: Direct answers HTTP 200 with {"error": {...}}.
 *      Every tool is read-only; the adapter has no write at all.
 *
 *   2. Live: skipped unless RUN_YANDEX_DIRECT_LIVE=1 and YANDEX_DIRECT_TOKEN
 *      are set (the token's app needs approved Direct API access). Reads the
 *      account, campaigns and a small report.
 *
 *        RUN_YANDEX_DIRECT_LIVE=1 YANDEX_DIRECT_TOKEN=y0_... npx jest src/adapters/intl/yandex-direct.live.spec.ts
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
const TOKEN = ['y0_', 'AgAAAAABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop'].join('');
const BASE = 'https://api.direct.yandex.com/json/v501';
const ENV: Record<string, string> = { YANDEX_DIRECT_TOKEN: TOKEN };
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

const WRITES: string[] = [];
const SWITCHED_OFF: string[] = [];
const READ_POSTS: string[] = ["yandex_direct_get_client", "yandex_direct_list_campaigns", "yandex_direct_list_ad_groups", "yandex_direct_list_ads", "yandex_direct_list_keywords", "yandex_direct_list_keyword_bids", "yandex_direct_list_sitelinks", "yandex_direct_list_ad_extensions", "yandex_direct_list_negative_keyword_sets", "yandex_direct_list_retargeting_lists", "yandex_direct_list_agency_clients", "yandex_direct_get_dictionaries", "yandex_direct_check_campaign_changes", "yandex_direct_get_report"];

describe('yandex-direct adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed under intl/advertising with its own icon', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('yandex-direct');
    expect(a.region).toBe('intl');
    expect(a.icon).toBe('yandex-direct');
    expect(a.category).toBe('advertising');
    expect(getAdapter('yandex-direct')).toBeDefined();
  });

  it('sends the token as Bearer and Client-Login only when set', async () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{YANDEX_DIRECT_TOKEN}}' });
    expect(a.optionalEnvVars).toEqual(['YANDEX_DIRECT_CLIENT_LOGIN']);
    expect(a.probe.tool).toBe('yandex_direct_get_client');
    mockedAxios.mockResolvedValue({ data: { result: {} } });
    await call('yandex_direct_get_client');
    expect(sent().headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent().headers['Client-Login']).toBeUndefined();
    mockedAxios.mockClear();
    await execute('yandex_direct_list_campaigns', { ...ENV, YANDEX_DIRECT_CLIENT_LOGIN: 'client-1' }, {});
    expect(sent().headers['Client-Login']).toBe('client-1');
  });

  it('asks for credentials as secrets with a pattern that refuses pasted prefixes', () => {
    for (const [name, meta] of Object.entries(a.envVarMeta)) {
      if (meta.kind === 'credential') expect(`${name}:${meta.secret}`).toBe(`${name}:true`);
      expect(meta.pattern).toBeDefined();
    }
    const described = describeAdapterEnvVars(a as never);
    for (const name of a.requiredEnvVars) expect(described.find((d) => d.name === name)).toBeDefined();
    const re = new RegExp(a.envVarMeta.YANDEX_DIRECT_TOKEN.pattern!);
    expect(re.test(TOKEN)).toBe(true);
    for (const bad of [`Bearer ${TOKEN}`, `OAuth ${TOKEN}`, 'short']) expect(re.test(bad)).toBe(false);
  });

  it('prefixes every tool with yandex_direct_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^yandex_direct_[a-z0-9_]+$/);
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
      ...a.instructions.matchAll(/\byandex_direct_[a-z0-9_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\byandex_direct_[a-z0-9_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(3);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Yandex Direct\n')).toBe(true);
    expect(a.instructions).toContain('Out of scope');
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  // [tool, args, method, url]
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ["yandex_direct_get_client", {}, "POST", `${BASE}/clients`],
    ["yandex_direct_list_campaigns", {}, "POST", `${BASE}/campaigns`],
    ["yandex_direct_list_ad_groups", {"campaign_ids": [1]}, "POST", `${BASE}/adgroups`],
    ["yandex_direct_list_ads", {"campaign_ids": [1]}, "POST", `${BASE}/ads`],
    ["yandex_direct_list_keywords", {"campaign_ids": [1]}, "POST", `${BASE}/keywords`],
    ["yandex_direct_list_keyword_bids", {"campaign_ids": [1]}, "POST", `${BASE}/keywordbids`],
    ["yandex_direct_list_sitelinks", {"ids": [1]}, "POST", `${BASE}/sitelinks`],
    ["yandex_direct_list_ad_extensions", {}, "POST", `${BASE}/adextensions`],
    ["yandex_direct_list_negative_keyword_sets", {"ids": [1]}, "POST", `${BASE}/negativekeywordsharedsets`],
    ["yandex_direct_list_retargeting_lists", {}, "POST", `${BASE}/retargetinglists`],
    ["yandex_direct_list_agency_clients", {}, "POST", `${BASE}/agencyclients`],
    ["yandex_direct_get_dictionaries", {"dictionary_names": ["Currencies"]}, "POST", `${BASE}/dictionaries`],
    ["yandex_direct_check_campaign_changes", {"timestamp": "2026-10-18T00:00:00Z"}, "POST", `${BASE}/changes`],
    ["yandex_direct_get_report", {"report_name": "r1"}, "POST", `${BASE}/reports`],
  ];

  it('lists every tool in the URL table', () => {
    expect([...new Set(table.map(([name]) => name))].sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s %s', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: { result: {} } });
    await call(name, params);
    expect(sent().method.toUpperCase()).toBe(method);
    expect(sent().url).toBe(url);
  });

  it('has no write tool at all', () => {
    expect(WRITES).toEqual([]);
    for (const t of a.tools) {
      expect(t.endpointMapping.bodyMapping!.method === undefined || ['get', 'checkCampaigns'].includes(String(t.endpointMapping.bodyMapping!.method))).toBe(true);
    }
  });

  it('sends a get with empty SelectionCriteria and the default fields for campaigns', async () => {
    mockedAxios.mockResolvedValue({ data: { result: { Campaigns: [] } } });
    await call('yandex_direct_list_campaigns');
    expect(sent().data).toEqual({
      method: 'get',
      params: {
        SelectionCriteria: {},
        FieldNames: ['Id', 'Name', 'Type', 'Status', 'State', 'StatusPayment', 'StartDate', 'EndDate', 'Currency', 'Funds', 'Statistics'],
        Page: { Limit: 500 },
      },
    });
  });

  it('selects ads by campaign with text ad fields and pages with offset', async () => {
    mockedAxios.mockResolvedValue({ data: { result: { Ads: [] } } });
    await call('yandex_direct_list_ads', { campaign_ids: [11, 12], offset: 500 });
    expect(sent().data.params.SelectionCriteria).toEqual({ CampaignIds: [11, 12] });
    expect(sent().data.params.TextAdFieldNames).toContain('Title');
    expect(sent().data.params.Page).toEqual({ Limit: 500, Offset: 500 });
  });

  it('checks campaign changes with the checkCampaigns method', async () => {
    mockedAxios.mockResolvedValue({ data: { result: {} } });
    await call('yandex_direct_check_campaign_changes', { timestamp: '2026-10-18T00:00:00Z' });
    expect(sent().data).toEqual({ method: 'checkCampaigns', params: { Timestamp: '2026-10-18T00:00:00Z' } });
  });

  it('asks Reports for TSV in decimals without the title and total rows', async () => {
    mockedAxios.mockResolvedValue({ data: 'Date\tClicks\n2026-10-01\t3\n', headers: { 'content-type': 'text/tab-separated-values' } });
    const out = await call('yandex_direct_get_report', { report_name: 'r1', date_range_type: 'CUSTOM_DATE', date_from: '2026-10-01', date_to: '2026-10-18', field_names: ['Date', 'Clicks'] });
    expect(out).toBe('Date\tClicks\n2026-10-01\t3\n');
    expect(sent().headers).toMatchObject({ processingMode: 'auto', returnMoneyInMicros: 'false', skipReportHeader: 'true', skipReportSummary: 'true' });
    expect(sent().data).toEqual({
      params: {
        SelectionCriteria: { DateFrom: '2026-10-01', DateTo: '2026-10-18' },
        FieldNames: ['Date', 'Clicks'],
        Page: { Limit: 1000 },
        ReportName: 'r1',
        ReportType: 'CAMPAIGN_PERFORMANCE_REPORT',
        DateRangeType: 'CUSTOM_DATE',
        Format: 'TSV',
        IncludeVAT: 'YES',
      },
    });
  });

  it('passes back retryIn when a report is still being built offline', async () => {
    mockedAxios.mockResolvedValue({ status: 202, data: '', headers: { retryin: '10', reportsinqueue: '1' } });
    const c = interpolateDeep(a.connector, ENV) as typeof a.connector;
    const res = await engine().executeWithMeta(
      { baseUrl: c.baseUrl, authType: c.authType, authConfig: c.authConfig, headers: c.headers, errorWhen: c.config?.errorWhen },
      interpolateDeep(tool('yandex_direct_get_report').endpointMapping, ENV) as any,
      { ...applySchemaDefaults(tool('yandex_direct_get_report').parameters, { report_name: 'r1' }), ...ENV },
    );
    expect(res.headers).toEqual({ retryin: '10', reportsinqueue: '1' });
  });

  it.each([
    ['53', 401],
    ['58', 403],
    ['3000', 403],
    ['152', 429],
    ['8800', 404],
    ['4001', 400],
  ])('turns error_code %s in an HTTP 200 into an error with status %s', async (code, status) => {
    mockedAxios.mockResolvedValue({ data: { error: { error_code: code, error_string: 'Refused', error_detail: 'detail' } } });
    await expect(call('yandex_direct_get_client')).rejects.toMatchObject({ status });
  });
});

const LIVE_TOKEN = process.env.YANDEX_DIRECT_TOKEN;
const live = process.env.RUN_YANDEX_DIRECT_LIVE === '1' && LIVE_TOKEN ? describe : describe.skip;

live('yandex-direct adapter: live API (reads only)', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const env = () => ({ YANDEX_DIRECT_TOKEN: LIVE_TOKEN as string, YANDEX_DIRECT_CLIENT_LOGIN: process.env.YANDEX_DIRECT_CLIENT_LOGIN ?? '' });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env(), params);

  it('reads the account, campaigns and a small report', async () => {
    expect(Array.isArray((await run('yandex_direct_get_client')).result.Clients)).toBe(true);
    expect(Array.isArray((await run('yandex_direct_list_campaigns', { limit: 5 })).result.Campaigns)).toBe(true);
    const report = await run('yandex_direct_get_report', { report_name: `amcp-live-${Date.now()}`, date_range_type: 'YESTERDAY', field_names: ['Date', 'Clicks'], processing_mode: 'online' });
    expect(typeof report === 'string' || report === '').toBe(true);
  }, 90_000);
});
