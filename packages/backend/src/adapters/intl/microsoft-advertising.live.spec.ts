import axios from 'axios';
import * as adapter from './microsoft-advertising.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Microsoft Advertising (Bing Ads API v13) adapter, JSON REST endpoints.
 *
 * Static checks always run: the Microsoft identity platform sign-in (common
 * tenant, msads.manage scope), the DeveloperToken header, the service host of
 * every tool (Customer Management and Customer Billing on clientcenter,
 * Campaign Management on campaign, Ad Insight on adinsight), the CustomerId
 * and CustomerAccountId headers, the request bodies as the v13 REST reference
 * documents them (ids as strings, flags as comma-separated strings, search
 * parameters with their Type), and that every tool only reads.
 * https://learn.microsoft.com/en-us/advertising/guides/?view=bingads-13
 *
 * Live checks run only with RUN_MICROSOFT_ADVERTISING_LIVE=1. Without
 * credentials they confirm the API refuses a made-up token; with
 * MICROSOFT_ADS_ACCESS_TOKEN (an OAuth access token for msads.manage) and
 * MICROSOFT_ADS_DEVELOPER_TOKEN they read the user and the account list.
 * Reads only.
 *
 *   RUN_MICROSOFT_ADVERTISING_LIVE=1 MICROSOFT_ADS_ACCESS_TOKEN=... \
 *     MICROSOFT_ADS_DEVELOPER_TOKEN=... \
 *     npx jest src/adapters/intl/microsoft-advertising.live.spec.ts
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
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
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
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean; example?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === `microsoft_advertising_${name}`);
  if (!found) throw new Error(`missing tool microsoft_advertising_${name}`);
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
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};

const CM = 'https://clientcenter.api.bingads.microsoft.com/CustomerManagement/v13';
const CB = 'https://clientcenter.api.bingads.microsoft.com/CustomerBilling/v13';
const CAMPAIGN = 'https://campaign.api.bingads.microsoft.com/CampaignManagement/v13';
const AI = 'https://adinsight.api.bingads.microsoft.com/AdInsight/v13';

const ENV: Record<string, string> = {
  MICROSOFT_ADS_CLIENT_ID: '00001111-aaaa-2222-bbbb-3333cccc4444',
  MICROSOFT_ADS_CLIENT_SECRET: 'Abc8Q~test-secret-value-0123456789abcdef',
  MICROSOFT_ADS_DEVELOPER_TOKEN: '1A2B3C4D5E6F7G8H',
};
const SCOPE = { customer_id: '21000001', account_id: '180012345' };

const call = (name: string, params: Record<string, unknown>) => {
  const entry = tool(name);
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    entry.endpointMapping,
    ENV,
  );
  const tokens = { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService;
  return new RestEngine(tokens, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: cfg.headers,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(entry.parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = () => mockedAxios.mockResolvedValueOnce({ status: 200, data: {}, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

// Tools by service: the header set each one needs follows from it.
const CUSTOMER = ['get_user', 'list_accounts', 'search_accounts', 'get_account'];
const BILLING = ['get_monthly_spend'];
const CAMPAIGN_TOOLS = [
  'list_campaigns',
  'get_campaigns',
  'list_ad_groups',
  'list_ads',
  'list_keywords',
  'get_budgets',
  'list_negative_keywords',
  'list_campaign_criterions',
  'list_conversion_goals',
  'list_uet_tags',
];
const INSIGHT = [
  'get_budget_opportunities',
  'get_bid_opportunities',
  'get_keyword_opportunities',
  'get_auction_insights',
  'get_performance_insights',
  'get_historical_search_counts',
  'get_keyword_ideas',
];

describe('microsoft-advertising adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in with the Microsoft identity platform (common tenant, msads.manage) and sends the developer token', () => {
    expect(a.slug).toBe('microsoft-advertising');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('advertising');
    expect(a.icon).toBe('microsoft-advertising');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(CAMPAIGN);
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{MICROSOFT_ADS_CLIENT_ID}}',
      clientSecret: '{{MICROSOFT_ADS_CLIENT_SECRET}}',
      authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scopes: 'https://ads.microsoft.com/msads.manage offline_access',
    });
    expect(a.connector.headers).toMatchObject({ DeveloperToken: '{{MICROSOFT_ADS_DEVELOPER_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['MICROSOFT_ADS_CLIENT_ID', 'MICROSOFT_ADS_CLIENT_SECRET', 'MICROSOFT_ADS_DEVELOPER_TOKEN']);
    expect(a.optionalEnvVars).toBeUndefined();
    expect(a.envVarMeta.MICROSOFT_ADS_CLIENT_SECRET).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.MICROSOFT_ADS_DEVELOPER_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    for (const name of a.requiredEnvVars) {
      expect(new RegExp(a.envVarMeta[name].pattern!).test(ENV[name])).toBe(true);
      expect(new RegExp(a.envVarMeta[name].pattern!).test('has a space in it 0123456789')).toBe(false);
    }
    expect(new RegExp(a.envVarMeta.MICROSOFT_ADS_DEVELOPER_TOKEN.pattern!).test('BBD37VB98')).toBe(true);
  });

  it('probes the signed-in user and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'microsoft_advertising_get_user', params: {} });
    expect(tool('get_user').parameters.required ?? []).toEqual([]);
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    expect(a.tools).toHaveLength(CUSTOMER.length + BILLING.length + CAMPAIGN_TOOLS.length + INSIGHT.length);
    for (const name of mine) expect(name).toMatch(/^microsoft_advertising_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(declared.has(arg) || envNames.has(arg)).toBe(true);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(60);
      for (const [, prop] of Object.entries(entry.parameters.properties ?? {})) expect(prop.description).toBeTruthy();
    }
  });

  it('only reads: every tool is a documented POST query, marked read-only and installed on', () => {
    for (const entry of a.tools) {
      expect(entry.endpointMapping.method).toBe('POST');
      expect(annotationsOf(entry).readOnlyHint).toBe(true);
      expect(entry.enabled).not.toBe(false);
      // v13 REST reads end in /Query, /QueryBy..., or /Search; writes are POST/PUT/DELETE on the bare entity path.
      expect(entry.endpointMapping.path).toMatch(/\/(Query|QueryBy[A-Za-z]+|Search)$/);
      expect(entry.endpointMapping.path).not.toMatch(/Reporting|Bulk|GenerateReport/);
    }
  });

  it('sends each tool to its service host with the headers that service needs', () => {
    for (const name of CUSTOMER) {
      expect(tool(name).endpointMapping.path.startsWith(`${CM}/`)).toBe(true);
      expect(tool(name).endpointMapping.headers).toBeUndefined();
    }
    for (const name of BILLING) {
      expect(tool(name).endpointMapping.path.startsWith(`${CB}/`)).toBe(true);
      expect(tool(name).endpointMapping.headers).toBeUndefined();
    }
    for (const name of [...CAMPAIGN_TOOLS, ...INSIGHT]) {
      const entry = tool(name);
      if (CAMPAIGN_TOOLS.includes(name)) expect(entry.endpointMapping.path).toMatch(/^\/[A-Z]/);
      else expect(entry.endpointMapping.path.startsWith(`${AI}/`)).toBe(true);
      expect(entry.endpointMapping.headers).toEqual({ CustomerId: '$customer_id', CustomerAccountId: '$account_id' });
      expect(entry.parameters.required).toEqual(expect.arrayContaining(['customer_id', 'account_id']));
    }
  });

  it('names every tool in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('reads the signed-in user with an empty body, the bearer token and the developer token', async () => {
    ok();
    await call('get_user', {});
    const req = sent();
    expect(req.url).toBe(`${CM}/User/Query`);
    expect(String(req.method).toUpperCase()).toBe('POST');
    expect(header(req, 'Authorization')).toBe('Bearer test-token');
    expect(header(req, 'DeveloperToken')).toBe(ENV.MICROSOFT_ADS_DEVELOPER_TOKEN);
    expect(header(req, 'CustomerId')).toBeUndefined();
    expect(req.data).toEqual({});
  });

  it('builds the account discovery bodies', async () => {
    ok();
    await call('list_accounts', {});
    expect(sent().url).toBe(`${CM}/AccountsInfo/Query`);
    expect(sent().data).toEqual({});

    ok();
    await call('search_accounts', { field: 'UserId', value: '123456' });
    expect(sent().url).toBe(`${CM}/Accounts/Search`);
    expect(sent().data).toEqual({
      Predicates: [{ Field: 'UserId', Operator: 'Equals', Value: '123456' }],
      PageInfo: { Index: 0, Size: 100 },
    });

    ok();
    await call('get_account', { account_id: '180012345' });
    expect(sent().url).toBe(`${CM}/Account/Query`);
    expect(sent().data).toEqual({ AccountId: '180012345' });

    ok();
    await call('get_monthly_spend', { account_id: '180012345', month: '2026-10' });
    expect(sent().url).toBe(`${CB}/AccountMonthlySpend/Query`);
    expect(sent().data).toEqual({ AccountId: '180012345', MonthYear: '2026-10' });
  });

  it('lists campaigns with the account headers, the account id in the body and the common campaign types', async () => {
    ok();
    await call('list_campaigns', SCOPE);
    const req = sent();
    expect(req.url).toBe(`${CAMPAIGN}/Campaigns/QueryByAccountId`);
    expect(header(req, 'CustomerId')).toBe('21000001');
    expect(header(req, 'CustomerAccountId')).toBe('180012345');
    expect(header(req, 'DeveloperToken')).toBe(ENV.MICROSOFT_ADS_DEVELOPER_TOKEN);
    expect(req.data).toEqual({ AccountId: '180012345', CampaignType: 'Search, Shopping, Audience, PerformanceMax' });
  });

  it('builds the campaign structure bodies', async () => {
    ok();
    await call('list_ads', { ...SCOPE, ad_group_id: '1300000001', ad_types: ['ResponsiveSearch'] });
    expect(sent().url).toBe(`${CAMPAIGN}/Ads/QueryByAdGroupId`);
    expect(sent().data).toEqual({ AdGroupId: '1300000001', AdTypes: ['ResponsiveSearch'] });

    ok();
    await call('get_budgets', SCOPE);
    expect(sent().url).toBe(`${CAMPAIGN}/Budgets/QueryByIds`);
    expect(sent().data).toEqual({});

    ok();
    await call('list_negative_keywords', { ...SCOPE, entity_type: 'AdGroup', entity_id: '1300000001', campaign_id: '500000001' });
    expect(sent().url).toBe(`${CAMPAIGN}/NegativeKeywords/QueryByEntityIds`);
    expect(sent().data).toEqual({ EntityIds: ['1300000001'], EntityType: 'AdGroup', ParentEntityId: '500000001' });

    ok();
    await call('list_campaign_criterions', { ...SCOPE, campaign_id: '500000001' });
    expect(sent().url).toBe(`${CAMPAIGN}/CampaignCriterions/QueryByIds`);
    expect(sent().data).toEqual({ CampaignId: '500000001', CriterionType: 'Location' });
  });

  it('builds the Ad Insight bodies with typed search parameters and numeric dates', async () => {
    ok();
    await call('get_auction_insights', {
      ...SCOPE,
      start_year: 2026, start_month: 10, start_day: 1,
      end_year: 2026, end_month: 10, end_day: 31,
    });
    expect(sent().url).toBe(`${AI}/AuctionInsightData/Query`);
    expect(header(sent(), 'CustomerAccountId')).toBe('180012345');
    expect(sent().data).toEqual({
      EntityType: 'Account',
      SearchParameters: [
        {
          Type: 'DateRangeSearchParameter',
          StartDate: { Day: 1, Month: 10, Year: 2026 },
          EndDate: { Day: 31, Month: 10, Year: 2026 },
        },
      ],
    });

    ok();
    await call('get_keyword_ideas', { ...SCOPE, queries: ['trail running shoes'] });
    expect(sent().url).toBe(`${AI}/KeywordIdeas/Query`);
    expect(sent().data).toEqual({
      ExpandIdeas: true,
      IdeaAttributes: ['Keyword', 'Competition', 'MonthlySearchCounts', 'SuggestedBid', 'AdImpressionShare', 'Relevance'],
      SearchParameters: [
        { Type: 'QuerySearchParameter', Queries: ['trail running shoes'] },
        { Type: 'LanguageSearchParameter', Languages: [{ Type: 'LanguageCriterion', Language: 'English' }] },
        { Type: 'LocationSearchParameter', Locations: [{ Type: 'LocationCriterion', LocationId: '190' }] },
        { Type: 'NetworkSearchParameter', Network: { Type: 'NetworkCriterion', Network: 'OwnedAndOperatedAndSyndicatedSearch' } },
      ],
    });

    ok();
    await call('get_historical_search_counts', {
      ...SCOPE,
      keywords: ['running shoes'],
      countries: ['US'],
      start_year: 2025, start_month: 11, start_day: 1,
      end_year: 2026, end_month: 10, end_day: 31,
    });
    expect(sent().url).toBe(`${AI}/HistoricalSearchCount/Query`);
    expect(sent().data).toEqual({
      Keywords: ['running shoes'],
      Language: 'English',
      PublisherCountries: ['US'],
      StartDate: { Day: 1, Month: 11, Year: 2025 },
      EndDate: { Day: 31, Month: 10, Year: 2026 },
      TimePeriodRollup: 'Monthly',
      Devices: ['Computers', 'Smartphones', 'Tablets'],
    });

    ok();
    await call('get_budget_opportunities', SCOPE);
    expect(sent().url).toBe(`${AI}/BudgetOpportunities/Query`);
    expect(sent().data).toEqual({});
  });
});

// Opt-in: RUN_MICROSOFT_ADVERTISING_LIVE=1. The refusal check needs no
// account; the reads need MICROSOFT_ADS_ACCESS_TOKEN and
// MICROSOFT_ADS_DEVELOPER_TOKEN. Nothing is written.
const live = process.env.RUN_MICROSOFT_ADVERTISING_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('Microsoft Advertising: live', () => {
  it('refuses a made-up access token', async () => {
    const response = await liveFetch.post(`${CM}/User/Query`, {}, {
      headers: { Authorization: 'Bearer not-a-token', DeveloperToken: 'NOTATOKEN1', 'Content-Type': 'application/json' },
      validateStatus: () => true,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('reads the signed-in user and the account list', async () => {
    const token = process.env.MICROSOFT_ADS_ACCESS_TOKEN;
    const developerToken = process.env.MICROSOFT_ADS_DEVELOPER_TOKEN;
    if (!token || !developerToken) throw new Error('Set MICROSOFT_ADS_ACCESS_TOKEN and MICROSOFT_ADS_DEVELOPER_TOKEN for the live check');
    const headers = { Authorization: `Bearer ${token}`, DeveloperToken: developerToken, 'Content-Type': 'application/json' };
    const user = await liveFetch.post(`${CM}/User/Query`, {}, { headers, validateStatus: () => true });
    expect(user.status).toBe(200);
    expect(user.data.User).toBeTruthy();
    const accounts = await liveFetch.post(`${CM}/AccountsInfo/Query`, {}, { headers, validateStatus: () => true });
    expect(accounts.status).toBe(200);
    expect(Array.isArray(accounts.data.AccountsInfo)).toBe(true);
  });
});
