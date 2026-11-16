import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service';
import * as adapter from './criteo.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Criteo Marketing Solutions adapter (stable API version 2026-07).
 *
 * Static checks always run: the client-credentials token request
 * (client_secret_post at api.criteo.com/oauth2/token), every tool's method
 * and path against Criteo's published OpenAPI document for 2026-07
 * (api.criteo.com/2026-07/marketingsolutions/open-api-specifications.json),
 * the search and report bodies, and which tools install switched off
 * (starting, stopping, budget and bid changes: they change ad spend).
 * https://developers.criteo.com/marketing-solutions/docs/welcome-to-criteo
 *
 * Live checks run only with RUN_CRITEO_LIVE=1. Without credentials they
 * confirm the token endpoint refuses a wrong client; with CRITEO_CLIENT_ID
 * and CRITEO_CLIENT_SECRET they read the consented advertisers. Reads only.
 * Not run for the first version: no Criteo app was available.
 *
 *   RUN_CRITEO_LIVE=1 CRITEO_CLIENT_ID=... CRITEO_CLIENT_SECRET=... \
 *     npx jest src/adapters/intl/criteo.live.spec.ts
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

type Param = { type?: string; description?: string; pattern?: string; enum?: unknown[]; default?: unknown; items?: Param };
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, Param>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: unknown;
    headers?: Record<string, string>;
    envDefaults?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  description: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string; link?: string; help?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
    headers?: Record<string, string>;
    config?: Record<string, unknown>;
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({ name: entry.name, connectorType: 'REST', endpointMapping: entry.endpointMapping, annotations: entry.annotations } as never);
const used = (entry: Tool) => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (/^\$\w+$/.test(v)) out.add(v.slice(1));
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
const outsideBackticks = (text: string) => text.replace(/`[^`]*`/g, '');

// Method and path of every tool, from the vendor's documentation (see above).
const ROUTES: Record<string, [string, string]> = {
  criteo_list_advertisers: ['GET', '/2026-07/advertisers/me'],
  criteo_get_app_info: ['GET', '/2026-07/marketing-solutions/me'],
  criteo_search_campaigns: ['POST', '/2026-07/marketing-solutions/campaigns/search'],
  criteo_get_campaign: ['GET', '/2026-07/marketing-solutions/campaigns/{campaign_id}'],
  criteo_search_ad_sets: ['POST', '/2026-07/marketing-solutions/ad-sets/search'],
  criteo_get_ad_set: ['GET', '/2026-07/marketing-solutions/ad-sets/{ad_set_id}'],
  criteo_get_category_bids: ['GET', '/2026-07/marketing-solutions/ad-sets/{ad_set_id}/category-bids'],
  criteo_get_display_multipliers: ['GET', '/2026-07/marketing-solutions/ad-sets/{ad_set_id}/display-multipliers'],
  criteo_list_ads: ['GET', '/2026-07/marketing-solutions/advertisers/{advertiser_id}/ads'],
  criteo_get_ad: ['GET', '/2026-07/marketing-solutions/ads/{ad_id}'],
  criteo_list_creatives: ['GET', '/2026-07/marketing-solutions/advertisers/{advertiser_id}/creatives'],
  criteo_list_coupons: ['GET', '/2026-07/marketing-solutions/advertisers/{advertiser_id}/coupons'],
  criteo_search_audience_segments: ['POST', '/2026-07/marketing-solutions/audience-segments/search'],
  criteo_get_statistics_report: ['POST', '/2026-07/statistics/report'],
  criteo_get_transactions_report: ['POST', '/2026-07/transactions/report'],
  criteo_get_placements_report: ['POST', '/2026-07/placements/report'],
  criteo_start_ad_set: ['POST', '/2026-07/marketing-solutions/ad-sets/start'],
  criteo_stop_ad_set: ['POST', '/2026-07/marketing-solutions/ad-sets/stop'],
  criteo_update_ad_set_budget: ['PATCH', '/2026-07/marketing-solutions/ad-sets'],
  criteo_update_ad_set_bid: ['PATCH', '/2026-07/marketing-solutions/ad-sets'],
};
// Tools that change spend, buy, cancel or delete: installed switched off.
const OFF = [
  'criteo_start_ad_set',
  'criteo_stop_ad_set',
  'criteo_update_ad_set_bid',
  'criteo_update_ad_set_budget',
];
// POST tools that only read (searches, reports, price estimates).
const READ_POSTS = [
  'criteo_get_placements_report',
  'criteo_get_statistics_report',
  'criteo_get_transactions_report',
  'criteo_search_ad_sets',
  'criteo_search_audience_segments',
  'criteo_search_campaigns',
];

// Built at runtime so no literal looks like a real credential.
const ENV: Record<string, string> = {
  CRITEO_CLIENT_ID: ['a1b2c3d4', 'e5f6a7b8', 'c9d0e1f2'].join(''),
  CRITEO_CLIENT_SECRET: ['Sx', 'y'.repeat(30), '9'].join(''),
};

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping as never,
    ENV,
  );
  const tokens = { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService;
  return new RestEngine(tokens, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig ?? {}, ENV),
      headers: cfg.headers,
      config: a.connector.config,
    } as never,
    endpointMapping as never,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (data: unknown = {}, status = 200) =>
  mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

describe('criteo adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('has the catalog envelope', () => {
    expect(a.slug).toBe('criteo');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('advertising');
    expect(a.icon).toBe('criteo');
    expect(a.docsUrl).toBe('https://developers.criteo.com/marketing-solutions/docs/welcome-to-criteo');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://api.criteo.com');
    expect(a.connector.headers).toMatchObject({ Accept: 'application/json', 'User-Agent': 'AnythingMCP' });
  });

  it('describes every variable and accepts well-formed values', () => {
    const vars = [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])];
    expect(Object.keys(a.envVarMeta).sort()).toEqual([...vars].sort());
    for (const name of vars) {
      const meta = a.envVarMeta[name];
      expect(meta.help).toBeTruthy();
      expect(meta.link).toMatch(/^https:\/\//);
      if (meta.pattern) {
        expect(new RegExp(meta.pattern).test(ENV[name])).toBe(true);
        expect(new RegExp(meta.pattern).test('')).toBe(false);
      }
    }
  });

  it('maps every tool to its documented method and path', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const entry of a.tools) {
      expect([entry.name, entry.endpointMapping.method, entry.endpointMapping.path]).toEqual([entry.name, ...ROUTES[entry.name]]);
    }
  });

  it('installs the spending, buying, cancelling and deleting tools switched off', () => {
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual([...OFF].sort());
    for (const name of OFF) expect(tool(name).endpointMapping.method).not.toBe('GET');
  });

  it('marks reads read-only and nothing else', () => {
    for (const entry of a.tools) {
      const read = entry.endpointMapping.method === 'GET' || READ_POSTS.includes(entry.name);
      expect([entry.name, annotationsOf(entry).readOnlyHint === true]).toEqual([entry.name, read]);
    }
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^criteo_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)?.tools ?? []) expect(mine.has(other.name)).toBe(false);
    }
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect([entry.name, arg, declared.has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const [param, variable] of Object.entries(entry.endpointMapping.envDefaults ?? {})) {
        expect(declared.has(param)).toBe(true);
        expect(entry.parameters.required ?? []).not.toContain(param);
        expect(a.optionalEnvVars ?? []).toContain(variable);
      }
      expect(entry.description.length).toBeGreaterThan(40);
      for (const prop of Object.values(entry.parameters.properties ?? {})) {
        expect(prop.description).toBeTruthy();
        if (prop.pattern) expect(prop.pattern).not.toMatch(/\\[1-9]/);
      }
    }
  });

  it('keeps the texts free of MDX characters and names every tool in the instructions', () => {
    expect(a.instructions.startsWith('## ')).toBe(true);
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    const texts = [a.description, a.instructions, a.prerequisites, ...Object.values(a.verifyHints)];
    for (const entry of a.tools) {
      texts.push(entry.description);
      for (const prop of Object.values(entry.parameters.properties ?? {})) texts.push(prop.description ?? '');
    }
    for (const text of texts) expect(outsideBackticks(text)).not.toMatch(/[{}<]/);
  });

  it('probes with a cheap read and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'criteo_list_advertisers', params: {} });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).enabled).not.toBe(false);
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('uses client credentials at api.criteo.com with the secret in the form body', async () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{CRITEO_CLIENT_ID}}',
      clientSecret: '{{CRITEO_CLIENT_SECRET}}',
      tokenUrl: 'https://api.criteo.com/oauth2/token',
      tokenAuthMethod: 'client_secret_post',
    });
    const service = new OAuth2TokenService(
      {} as PrismaService,
      { get: () => 'test-encryption-key-32-chars!!!!' } as unknown as ConfigService,
    );
    const post = jest
      .spyOn(mockedAxios as unknown as typeof axios, 'post')
      .mockResolvedValue({ data: { access_token: 'eyJ.token', expires_in: 900, token_type: 'Bearer' } });
    await expect(service.getAccessToken(interpolateDeep({ ...a.connector.authConfig }, ENV))).resolves.toBe('eyJ.token');
    const [url, body] = post.mock.calls[0] as unknown as [string, string];
    expect(url).toBe('https://api.criteo.com/oauth2/token');
    expect(Object.fromEntries(new URLSearchParams(body))).toMatchObject({
      grant_type: 'client_credentials',
      client_id: ENV.CRITEO_CLIENT_ID,
      client_secret: ENV.CRITEO_CLIENT_SECRET,
    });
    post.mockRestore();
  });

  it('pins every path to the 2026-07 version', () => {
    for (const entry of a.tools) expect(entry.endpointMapping.path.startsWith('/2026-07/')).toBe(true);
  });

  it('lists the consented advertisers with the bearer token', async () => {
    ok({ data: [] });
    await call('criteo_list_advertisers', {});
    const req = sent();
    expect(req.url).toBe('https://api.criteo.com/2026-07/advertisers/me');
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Authorization')).toBe('Bearer test-token');
  });

  it('sends the search filters as Criteo documents them', async () => {
    ok({ data: [] });
    await call('criteo_search_ad_sets', { advertiser_ids: ['12345'], campaign_ids: ['777'] });
    expect(sent().url).toBe('https://api.criteo.com/2026-07/marketing-solutions/ad-sets/search');
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({ filters: { advertiserIds: ['12345'], campaignIds: ['777'] } });

    ok({ data: [] });
    await call('criteo_search_audience_segments', { advertiser_ids: ['12345'], segment_types: ['Retargeting'] });
    expect(sent().data).toEqual({
      data: { type: 'AudienceSegment', attributes: { advertiserIds: ['12345'], audienceSegmentTypes: ['Retargeting'] } },
    });
    expect(sent().params).toEqual({ limit: 50, offset: 0 });
  });

  it('asks for a JSON statistics report with the chosen dimensions and metrics', async () => {
    ok([]);
    await call('criteo_get_statistics_report', {
      advertiser_ids: '12345,67890',
      start_date: '2026-11-01',
      end_date: '2026-11-14',
      dimensions: ['AdsetId', 'Day'],
      metrics: ['Displays', 'Clicks', 'AdvertiserCost'],
      currency: 'EUR',
    });
    expect(sent().url).toBe('https://api.criteo.com/2026-07/statistics/report');
    expect(sent().data).toEqual({
      advertiserIds: '12345,67890',
      startDate: '2026-11-01',
      endDate: '2026-11-14',
      dimensions: ['AdsetId', 'Day'],
      metrics: ['Displays', 'Clicks', 'AdvertiserCost'],
      currency: 'EUR',
      format: 'json',
    });

    ok([]);
    await call('criteo_get_transactions_report', { advertiser_ids: '12345', start_date: '2026-11-01', end_date: '2026-11-02', currency: 'EUR' });
    expect(sent().data).toEqual({
      data: [{ type: 'report', attributes: { advertiserIds: '12345', startDate: '2026-11-01', endDate: '2026-11-02', currency: 'EUR', format: 'json' } }],
    });
  });

  it('wraps the switched-off spend changes in the documented write models', async () => {
    ok({ data: [] });
    await call('criteo_stop_ad_set', { ad_set_id: '4242' });
    expect(sent().url).toBe('https://api.criteo.com/2026-07/marketing-solutions/ad-sets/stop');
    expect(sent().data).toEqual({ data: [{ id: '4242', type: 'AdSetId' }] });

    ok({ data: [] });
    await call('criteo_update_ad_set_budget', { ad_set_id: '4242', budget_amount: 150 });
    expect(String(sent().method).toUpperCase()).toBe('PATCH');
    expect(sent().data).toEqual({ data: [{ id: '4242', type: 'PatchAdSetV26Q1', attributes: { budget: { budgetAmount: { value: 150 } } } }] });
  });
});

// Opt-in: RUN_CRITEO_LIVE=1. The refusal check needs no account; the read
// needs CRITEO_CLIENT_ID and CRITEO_CLIENT_SECRET. Nothing is written.
const live = process.env.RUN_CRITEO_LIVE === '1';
const liveFetch = mockedAxios.__actual;
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
(live ? describe : describe.skip)('criteo: live', () => {
  it('refuses a wrong client at the token endpoint', async () => {
    const response = await liveFetch.post(
      'https://api.criteo.com/oauth2/token',
      form({ grant_type: 'client_credentials', client_id: 'not-a-client', client_secret: 'not-a-secret' }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, validateStatus: () => true },
    );
    expect([400, 401]).toContain(response.status);
  });

  it('reads the consented advertisers', async () => {
    const id = process.env.CRITEO_CLIENT_ID;
    const secret = process.env.CRITEO_CLIENT_SECRET;
    if (!id || !secret) throw new Error('Set CRITEO_CLIENT_ID and CRITEO_CLIENT_SECRET for the live check');
    const token = await liveFetch.post(
      'https://api.criteo.com/oauth2/token',
      form({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    const response = await liveFetch.get('https://api.criteo.com/2026-07/advertisers/me', {
      headers: { Authorization: `Bearer ${token.data.access_token}`, Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
    expect(Array.isArray(response.data.data)).toBe(true);
  });
});
