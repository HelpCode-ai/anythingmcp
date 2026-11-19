import axios from 'axios';
import * as adapter from './metricool.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Metricool API adapter.
 *
 * Static checks always run: the X-Mc-Auth header, userId from the connector
 * variable and blogId from the argument (or the connector's default brand) on
 * every call, every tool's method and path against Metricool's published
 * OpenAPI document (https://app.metricool.com/api/swagger.json), the body of
 * a scheduled post, and that nothing touches paid promotion (boost).
 * https://app.metricool.com/resources/apidocs/index.html
 *
 * Live checks run only with RUN_METRICOOL_LIVE=1. Without credentials they
 * confirm that the API refuses an anonymous call; with METRICOOL_USER_TOKEN
 * and METRICOOL_USER_ID they list the brands. Reads only.
 *
 *   RUN_METRICOOL_LIVE=1 METRICOOL_USER_TOKEN=... METRICOOL_USER_ID=... \
 *     npx jest src/adapters/intl/metricool.live.spec.ts
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
  METRICOOL_USER_TOKEN: 'TESTTOKEN0123456789ABCDEFGHIJ',
  METRICOOL_USER_ID: '678901',
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
  ['metricool_list_brands', 'GET', '/v2/settings/brands'],
  ['metricool_list_posts', 'GET', '/v2/analytics/posts/{network}'],
  ['metricool_list_reels', 'GET', '/v2/analytics/reels/{network}'],
  ['metricool_list_stories', 'GET', '/v2/analytics/stories/{network}'],
  ['metricool_list_brand_posts', 'GET', '/v2/analytics/brand-summary/posts'],
  ['metricool_get_metric_timeline', 'GET', '/v2/analytics/timelines'],
  ['metricool_get_metric_total', 'GET', '/v2/analytics/aggregation'],
  ['metricool_list_competitors', 'GET', '/v2/analytics/competitors/{network}'],
  ['metricool_list_competitor_posts', 'GET', '/v2/analytics/competitors/{network}/posts'],
  ['metricool_list_instagram_competitor_posts', 'GET', '/v2/analytics/competitors/instagram/publications'],
  ['metricool_list_meta_ads_campaigns', 'GET', '/v2/analytics/campaigns/facebookads'],
  ['metricool_list_google_ads_campaigns', 'GET', '/v2/analytics/campaigns/googleads'],
  ['metricool_list_tiktok_ads_campaigns', 'GET', '/v2/analytics/campaigns/tiktokads'],
  ['metricool_get_best_times', 'GET', '/v2/scheduler/besttimes/{network}'],
  ['metricool_list_scheduled_posts', 'GET', '/v2/scheduler/posts'],
  ['metricool_get_scheduled_post', 'GET', '/v2/scheduler/posts/{post_id}'],
  ['metricool_schedule_post', 'POST', '/v2/scheduler/posts'],
  ['metricool_delete_scheduled_post', 'DELETE', '/v2/scheduler/posts/{post_id}'],
];
const REQUIRED: Record<string, string[]> = {
  metricool_list_posts: ['network', 'from', 'to'],
  metricool_list_reels: ['network', 'from', 'to'],
  metricool_list_stories: ['network', 'from', 'to'],
  metricool_list_brand_posts: ['from', 'to'],
  metricool_get_metric_timeline: ['network', 'metric', 'from', 'to'],
  metricool_get_metric_total: ['network', 'metric', 'from', 'to'],
  metricool_list_competitors: ['network', 'from', 'to', 'timezone'],
  metricool_list_competitor_posts: ['network', 'from', 'to', 'timezone'],
  metricool_list_instagram_competitor_posts: ['from', 'to', 'timezone'],
  metricool_list_meta_ads_campaigns: ['from', 'to'],
  metricool_list_google_ads_campaigns: ['from', 'to'],
  metricool_list_tiktok_ads_campaigns: ['from', 'to'],
  metricool_get_best_times: ['network', 'start', 'end'],
  metricool_list_scheduled_posts: ['start', 'end'],
  metricool_get_scheduled_post: ['post_id'],
  metricool_schedule_post: ['text', 'publication_date_time', 'timezone', 'providers'],
  metricool_delete_scheduled_post: ['post_id'],
};
const OFF: string[] = ['metricool_delete_scheduled_post'];

describe('metricool adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the token in X-Mc-Auth and the account and brand ids in the query', () => {
    expect(a.slug).toBe('metricool');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('social');
    expect(a.icon).toBe('metricool');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://app.metricool.com/api');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Mc-Auth', apiKey: '{{METRICOOL_USER_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['METRICOOL_USER_TOKEN', 'METRICOOL_USER_ID']);
    expect(a.optionalEnvVars).toEqual(['METRICOOL_BLOG_ID']);
    expect(a.envVarMeta.METRICOOL_USER_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.METRICOOL_USER_ID).toMatchObject({ kind: 'setting' });
    expect(a.envVarMeta.METRICOOL_BLOG_ID).toMatchObject({ kind: 'setting' });
    expect(a.envVarMeta.METRICOOL_BLOG_ID.secret).toBeUndefined();
    for (const name of ['METRICOOL_USER_ID', 'METRICOOL_BLOG_ID']) {
      const pattern = new RegExp(a.envVarMeta[name].pattern!);
      expect(pattern.test('678901')).toBe(true);
      expect(pattern.test('userId=678901')).toBe(false);
    }
    expect(a.probe).toEqual({ tool: 'metricool_list_brands', params: {} });
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    // The optional brand id is never part of a connector-level header.
    expect(JSON.stringify(a.connector.headers)).not.toContain('{{');
  });

  it('takes the brand from the argument or the default brand on every brand tool', () => {
    for (const entry of a.tools) {
      expect(entry.endpointMapping.queryParams?.userId).toBe('{{METRICOOL_USER_ID}}');
      if (entry.name === 'metricool_list_brands') {
        expect(entry.endpointMapping.queryParams?.blogId).toBeUndefined();
        continue;
      }
      expect([entry.name, entry.endpointMapping.queryParams?.blogId]).toEqual([entry.name, '$blog_id']);
      expect([entry.name, entry.endpointMapping.envDefaults]).toEqual([entry.name, { blog_id: 'METRICOOL_BLOG_ID' }]);
      expect(entry.parameters.required ?? []).not.toContain('blog_id');
    }
  });

  it('writes only to the planner and never offers paid promotion', () => {
    const writes = a.tools.filter((entry) => entry.endpointMapping.method !== 'GET');
    expect(writes.map((entry) => entry.name).sort()).toEqual(['metricool_delete_scheduled_post', 'metricool_schedule_post']);
    for (const entry of writes) expect(entry.endpointMapping.path).toMatch(/^\/v2\/scheduler\/posts/);
    expect(JSON.stringify(a.tools).toLowerCase()).not.toContain('boost');
    for (const entry of a.tools) if (entry.endpointMapping.path.includes('/campaigns/')) expect(entry.endpointMapping.method).toBe('GET');
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
    for (const name of mine) expect(name).toMatch(/^metricool_[a-z0-9_]+$/);
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

  it('reads posts, metrics, competitors and ads on the documented paths', async () => {
    ok({ data: [] });
    await call('metricool_list_posts', { network: 'instagram', from: '2026-10-01T00:00:00', to: '2026-10-31T23:59:59', timezone: 'Europe/Berlin', blog_id: 12345 });
    const req = sent();
    expect(req.url).toBe('https://app.metricool.com/api/v2/analytics/posts/instagram');
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'X-Mc-Auth')).toBe(ENV.METRICOOL_USER_TOKEN);
    expect(wire(req)).toBe('userId=678901&blogId=12345&from=2026-10-01T00:00:00&to=2026-10-31T23:59:59&timezone=Europe/Berlin');

    ok({ data: [] });
    await call('metricool_list_brands', {});
    expect(sent().url).toBe('https://app.metricool.com/api/v2/settings/brands');
    expect(sent().params).toEqual({ userId: '678901' });

    ok({ data: [] });
    await call('metricool_list_reels', { network: 'facebook', from: '2026-10-01T00:00:00', to: '2026-10-31T23:59:59', blog_id: 12345 });
    expect(sent().url).toBe('https://app.metricool.com/api/v2/analytics/reels/facebook');

    ok({ data: [] });
    await call('metricool_get_metric_timeline', {
      network: 'linkedin',
      metric: 'followers',
      subject: 'account',
      from: '2026-10-01T00:00:00+02:00',
      to: '2026-10-31T23:59:59+01:00',
      timezone: 'Europe/Berlin',
      blog_id: 12345,
    });
    expect(sent().url).toBe('https://app.metricool.com/api/v2/analytics/timelines');
    expect(sent().params).toEqual({
      userId: '678901',
      blogId: 12345,
      network: 'linkedin',
      metric: 'followers',
      subject: 'account',
      from: '2026-10-01T00:00:00+02:00',
      to: '2026-10-31T23:59:59+01:00',
      timezone: 'Europe/Berlin',
    });
    // The offset's plus sign must not turn into a space on the way.
    expect(sent().paramsSerializer(sent().params)).toContain('from=2026-10-01T00:00:00%2B02:00');

    ok({ data: [] });
    await call('metricool_list_competitor_posts', { network: 'twitter', from: '2026-10-01T00:00:00', to: '2026-10-31T23:59:59', timezone: 'Europe/Berlin', blog_id: 12345 });
    expect(sent().url).toBe('https://app.metricool.com/api/v2/analytics/competitors/twitter/posts');
    expect(sent().params).toMatchObject({ limit: 50, timezone: 'Europe/Berlin' });

    ok({ data: [] });
    await call('metricool_list_instagram_competitor_posts', { from: '2026-10-01T00:00:00', to: '2026-10-31T23:59:59', timezone: 'Europe/Berlin', blog_id: 12345 });
    expect(sent().url).toBe('https://app.metricool.com/api/v2/analytics/competitors/instagram/publications');

    ok({ data: [] });
    await call('metricool_list_tiktok_ads_campaigns', { from: '2026-10-01T00:00:00', to: '2026-10-31T23:59:59', blog_id: 12345 });
    expect(sent().url).toBe('https://app.metricool.com/api/v2/analytics/campaigns/tiktokads');
    expect(wire(sent())).toBe(
      'userId=678901&blogId=12345&from=2026-10-01T00:00:00&to=2026-10-31T23:59:59&metrics[]=impressions&metrics[]=cost&metrics[]=clicks&metrics[]=conversions',
    );

    ok({ data: [] });
    await call('metricool_get_best_times', { network: 'instagram', start: '2026-11-23T00:00:00', end: '2026-11-29T23:59:59', timezone: 'Europe/Berlin', blog_id: 12345 });
    expect(sent().url).toBe('https://app.metricool.com/api/v2/scheduler/besttimes/instagram');
  });

  it('schedules a post with the documented body and deletes by id', async () => {
    ok({ data: { id: 1 } }, 201);
    await call('metricool_schedule_post', {
      blog_id: 12345,
      text: 'Hello',
      publication_date_time: '2026-11-25T10:00:00',
      timezone: 'Europe/Berlin',
      providers: [{ network: 'linkedin' }],
      linkedin_data: { type: 'post' },
    });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe('https://app.metricool.com/api/v2/scheduler/posts');
    expect(sent().params).toEqual({ userId: '678901', blogId: 12345 });
    expect(sent().data).toEqual({
      text: 'Hello',
      publicationDate: { dateTime: '2026-11-25T10:00:00', timezone: 'Europe/Berlin' },
      providers: [{ network: 'linkedin' }],
      autoPublish: true,
      draft: false,
      linkedinData: { type: 'post' },
    });

    ok({});
    await call('metricool_delete_scheduled_post', { post_id: 99, blog_id: 12345 });
    expect(String(sent().method).toUpperCase()).toBe('DELETE');
    expect(sent().url).toBe('https://app.metricool.com/api/v2/scheduler/posts/99');
  });
});

// Opt-in: RUN_METRICOOL_LIVE=1. The refusal check needs no account; the read
// needs METRICOOL_USER_TOKEN and METRICOOL_USER_ID. Nothing is written.
const live = process.env.RUN_METRICOOL_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('metricool: live', () => {
  it('refuses a call without a token', async () => {
    const response = await liveFetch.get('https://app.metricool.com/api/v2/settings/brands', { params: { userId: 1 }, validateStatus: () => true });
    expect(response.status).toBe(401);
  });

  it('lists the brands', async () => {
    const token = process.env.METRICOOL_USER_TOKEN;
    const userId = process.env.METRICOOL_USER_ID;
    if (!token || !userId) return;
    const response = await liveFetch.get('https://app.metricool.com/api/v2/settings/brands', {
      params: { userId },
      headers: { 'X-Mc-Auth': token, Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
    expect(Array.isArray(response.data.data)).toBe(true);
  });
});
