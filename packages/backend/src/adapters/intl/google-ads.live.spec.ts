import * as adapter from './google-ads.json';
import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { DynamicMcpTools } from '../../mcp-server/dynamic-mcp-tools';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';

/**
 * Two layers of verification for the Google Ads adapter:
 *
 *   1. Static — always runs. Every report tool is a GAQL query assembled from
 *      its arguments inside `bodyMapping.query`. The engine drops a string
 *      whose `${placeholder}` has no value, which here would send Google a
 *      request with no query at all. So every placeholder must be required,
 *      carry a JSON-Schema default, or be the optional login-customer-id
 *      variable (which lives in a header, where "drop when empty" is exactly
 *      what we want). The calls go through the same env-var and default
 *      filling the MCP layer applies before the engine runs.
 *
 *   2. Live — skipped unless RUN_GOOGLE_ADS_LIVE is set. Needs an access token
 *      with the adwords scope, minted by an OAuth client of a Google Cloud
 *      project that has Google Ads API access (Explorer or above for
 *      production accounts, Test access for test accounts), and an account id:
 *
 *        RUN_GOOGLE_ADS_LIVE=1 GOOGLE_ADS_ACCESS_TOKEN=ya29... \
 *          GOOGLE_ADS_CUSTOMER_ID=1234567890 [GOOGLE_ADS_LOGIN_CUSTOMER_ID=...] \
 *          npx jest src/adapters/intl/google-ads.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Prop = { type?: string; default?: unknown; pattern?: string };
type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, Prop>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    bodyMapping?: Record<string, string>;
    headers?: Record<string, string>;
    staticResponse?: string;
  };
  annotations?: Record<string, unknown>;
};

const a = adapter as unknown as {
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    healthcheckPath: string;
  };
  tools: Tool[];
};

const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const gaqlTools = a.tools.filter((t) => t.endpointMapping.path.endsWith('googleAds:search'));
const fixedQueryTools = gaqlTools.filter((t) => t.endpointMapping.bodyMapping?.query !== '$query');

const newEngine = () =>
  new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  );

const connectorConfig = () => ({
  baseUrl: a.connector.baseUrl,
  authType: a.connector.authType,
  authConfig: { ...a.connector.authConfig },
});

// What the MCP layer does to the arguments before the engine sees them:
// connector env vars fill parameters of the same name, then schema defaults.
const proto = DynamicMcpTools.prototype as any;
const prepare = (t: Tool, args: Record<string, unknown>, env: Record<string, string> = {}) =>
  proto.applyDefaults(t.parameters, proto.injectEnvVars(args, env)) as Record<string, unknown>;

const call = async (
  name: string,
  args: Record<string, unknown>,
  env: Record<string, string> = {},
) => {
  mockedAxios.mockResolvedValue({ data: { results: [] } });
  const t = tool(name);
  await newEngine().execute(connectorConfig(), t.endpointMapping as any, prepare(t, args, env));
  return mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0];
};

const DATES = { start_date: '2026-08-01', end_date: '2026-08-31' };
const ID = '1234567890';

describe('google-ads adapter — static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('authorises in the browser with the adwords scope and asks for a refresh token', () => {
    const auth = a.connector.authConfig;
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.requiredEnvVars).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(a.optionalEnvVars).toEqual(['GOOGLE_ADS_LOGIN_CUSTOMER_ID']);
    const url = new URL(auth.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(auth.tokenUrl).toBe('https://oauth2.googleapis.com/token');
    expect(auth.scopes).toBe('https://www.googleapis.com/auth/adwords');
    expect(auth.refreshToken).toBeUndefined();
  });

  it('needs no developer token: access has belonged to the Cloud project since September 2026', () => {
    const everything = JSON.stringify(a);
    expect(everything).not.toMatch(/developer-token|DEVELOPER_TOKEN/i);
  });

  it('pins one API version, in the base URL only', () => {
    expect(a.connector.baseUrl).toBe('https://googleads.googleapis.com/v25');
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/\/v\d+\//);
  });

  it('fills every query placeholder: required, defaulted, or never empty', () => {
    for (const t of fixedQueryTools) {
      const query = t.endpointMapping.bodyMapping!.query;
      const props = t.parameters.properties ?? {};
      const required = new Set(t.parameters.required ?? []);
      for (const [, name] of query.matchAll(/\$\{(\w+)\}/g)) {
        expect({ tool: t.name, name, declared: name in props }).toEqual({
          tool: t.name,
          name,
          declared: true,
        });
        const covered = required.has(name) || props[name].default !== undefined;
        expect({ tool: t.name, name, covered }).toEqual({ tool: t.name, name, covered: true });
      }
    }
  });

  it('declares nothing it does not use', () => {
    for (const t of gaqlTools) {
      const mapping = JSON.stringify(t.endpointMapping);
      for (const name of Object.keys(t.parameters.properties ?? {})) {
        if (name === 'customer_id') continue;
        expect({ tool: t.name, name, used: mapping.includes(name) }).toEqual({
          tool: t.name,
          name,
          used: true,
        });
      }
    }
  });

  it('takes customer_id as ten digits on every account-scoped tool', () => {
    for (const t of gaqlTools) {
      expect(t.parameters.required).toContain('customer_id');
      expect(t.parameters.properties!.customer_id.pattern).toBe('^[0-9]{10}$');
    }
  });

  it('sends login-customer-id only when the manager id is configured', async () => {
    for (const t of gaqlTools) {
      expect(t.endpointMapping.headers).toEqual({
        'login-customer-id': '${GOOGLE_ADS_LOGIN_CUSTOMER_ID}',
      });
    }
    const without = await call('gads_get_customer', { customer_id: ID });
    expect(Object.keys(without.headers).map((h) => h.toLowerCase())).not.toContain(
      'login-customer-id',
    );
    const empty = await call('gads_get_customer', { customer_id: ID }, {
      GOOGLE_ADS_LOGIN_CUSTOMER_ID: '',
    });
    expect(Object.keys(empty.headers).map((h) => h.toLowerCase())).not.toContain(
      'login-customer-id',
    );
    const withMcc = await call('gads_get_customer', { customer_id: ID }, {
      GOOGLE_ADS_LOGIN_CUSTOMER_ID: '9876543210',
    });
    expect(withMcc.headers).toMatchObject({
      'login-customer-id': '9876543210',
      Authorization: 'Bearer test-token',
    });
  });

  it('lists accessible customers with a GET and no account', async () => {
    const req = await call('gads_list_accessible_customers', {});
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://googleads.googleapis.com/v25/customers:listAccessibleCustomers');
    expect(a.connector.healthcheckPath).toBe('/customers:listAccessibleCustomers');
  });

  it('queries the field catalog without an account', async () => {
    const q = "SELECT name, data_type WHERE name LIKE 'campaign.%'";
    const req = await call('gads_query_field_catalog', { query: q });
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://googleads.googleapis.com/v25/googleAdsFields:search');
    expect(req.data).toEqual({ query: q });
  });

  it('passes a raw GAQL query and the page token through untouched', async () => {
    const q = "SELECT campaign.name FROM campaign WHERE campaign.name LIKE '%Brand%'";
    const first = await call('gads_run_gaql', { customer_id: ID, query: q });
    expect(first.url).toBe(`https://googleads.googleapis.com/v25/customers/${ID}/googleAds:search`);
    expect(first.data).toEqual({ query: q });
    const next = await call('gads_run_gaql', { customer_id: ID, query: q, page_token: 'tok' });
    expect(next.data).toEqual({ query: q, pageToken: 'tok' });
  });

  it.each(fixedQueryTools.map((t) => t.name))(
    '%s builds a complete GAQL query from the minimum arguments',
    async (name) => {
      const t = tool(name);
      const args: Record<string, unknown> = { customer_id: ID };
      if (t.parameters.required?.includes('start_date')) Object.assign(args, DATES);
      const req = await call(name, args);
      expect(req.method).toBe('POST');
      expect(req.url).toBe(
        `https://googleads.googleapis.com/v25/customers/${ID}/googleAds:search`,
      );
      expect(Object.keys(req.data)).toEqual(['query']);
      const query: string = req.data.query;
      expect(query).toMatch(/^SELECT [a-z_.,\s]+ FROM [a-z_]+( WHERE | ORDER BY | LIMIT |$)/);
      expect(query).not.toMatch(/\$\{|\{\{|undefined|null/);
      expect(query).not.toMatch(/\s{2,}/);
      if (/segments\.date|change_date_time/.test(t.endpointMapping.bodyMapping!.query)) {
        expect(query).toContain("'2026-08-01'");
        expect(query).toContain("'2026-08-31'");
      }
    },
  );

  it('matches every campaign by default and narrows when asked', async () => {
    const all = await call('gads_campaign_performance', { customer_id: ID, ...DATES });
    expect(all.data.query).toBe(
      "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.cost_per_conversion FROM campaign WHERE segments.date BETWEEN '2026-08-01' AND '2026-08-31' AND campaign.name LIKE '%' ORDER BY metrics.cost_micros DESC LIMIT 200",
    );
    const some = await call('gads_search_terms', {
      customer_id: ID,
      ...DATES,
      campaign_name: 'Brand%',
      limit: 1000,
    });
    expect(some.data.query).toContain("AND campaign.name LIKE 'Brand%'");
    expect(some.data.query).toMatch(/LIMIT 1000$/);
  });

  it('bounds change history by the window and by a LIMIT, as Google requires', async () => {
    const req = await call('gads_change_history', {
      customer_id: ID,
      start_date: '2026-09-01',
      end_date: '2026-09-27 23:59:59',
    });
    expect(req.data.query).toContain(
      "WHERE change_event.change_date_time >= '2026-09-01' AND change_event.change_date_time <= '2026-09-27 23:59:59'",
    );
    expect(req.data.query).toMatch(/LIMIT 200$/);
  });

  it('advertises every tool as read-only', () => {
    for (const t of a.tools) {
      const ann = deriveToolAnnotations({
        name: t.name,
        connectorType: 'REST',
        endpointMapping: t.endpointMapping,
        annotations: t.annotations,
      });
      expect({ tool: t.name, readOnly: ann.readOnlyHint }).toEqual({ tool: t.name, readOnly: true });
    }
  });

  it('only points the model at tools that exist', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bgads_[a-z_]+/g),
      ...tool('gads_playbook').endpointMapping.staticResponse!.matchAll(/\bgads_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgads_[a-z_]+/g)]),
      ...a.tools.flatMap((t) => [...JSON.stringify(t.parameters).matchAll(/\bgads_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(20);
    for (const name of mentioned) expect(names).toContain(name);
  });

  it('states the tool count it actually has', () => {
    expect(a.tools).toHaveLength(17);
    expect(a.instructions).toContain('17 tools');
    expect((adapter as any).description).toContain('17 read-only tools');
  });
});

const live = process.env.RUN_GOOGLE_ADS_LIVE ? describe : describe.skip;

live('google-ads adapter — live API', () => {
  const token = process.env.GOOGLE_ADS_ACCESS_TOKEN ?? '';
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID ?? '';
  const env: Record<string, string> = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
    ? { GOOGLE_ADS_LOGIN_CUSTOMER_ID: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID }
    : {};
  const liveConfig = () => ({
    baseUrl: a.connector.baseUrl,
    authType: 'BEARER_TOKEN',
    authConfig: { token },
  });
  const isoDaysAgo = (n: number) =>
    new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const window = { start_date: isoDaysAgo(30), end_date: isoDaysAgo(1) };

  beforeAll(() => {
    if (!token || !customerId) {
      throw new Error('Set GOOGLE_ADS_ACCESS_TOKEN and GOOGLE_ADS_CUSTOMER_ID');
    }
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  const run = (name: string, args: Record<string, unknown>) => {
    const t = tool(name);
    return newEngine().execute(liveConfig(), t.endpointMapping as any, prepare(t, args, env)) as Promise<any>;
  };

  it('lists the accessible accounts', async () => {
    const out = await run('gads_list_accessible_customers', {});
    expect(Array.isArray(out.resourceNames)).toBe(true);
  }, 30_000);

  it('reads the account settings', async () => {
    const out = await run('gads_get_customer', { customer_id: customerId });
    expect(out.results[0].customer.id).toBe(customerId);
    expect(out.results[0].customer.currencyCode).toMatch(/^[A-Z]{3}$/);
  }, 30_000);

  it('looks fields up in the catalog', async () => {
    const out = await run('gads_query_field_catalog', {
      query: "SELECT name, data_type WHERE name LIKE 'campaign.name'",
    });
    expect(out.results[0].name).toBe('campaign.name');
  }, 30_000);

  it('runs a raw GAQL query', async () => {
    const out = await run('gads_run_gaql', {
      customer_id: customerId,
      query: 'SELECT campaign.id, campaign.name FROM campaign LIMIT 5',
    });
    expect(out.fieldMask).toContain('campaign.id');
  }, 30_000);

  // Every fixed query must be accepted by Google: this is the check the
  // static tests cannot make (field names, compatibility, required filters).
  it.each(
    a.tools
      .filter((t) => t.endpointMapping.path.endsWith('googleAds:search'))
      .filter((t) => t.endpointMapping.bodyMapping?.query !== '$query')
      .map((t) => t.name),
  )('%s is accepted by Google', async (name) => {
    const t = tool(name);
    const args: Record<string, unknown> = { customer_id: customerId };
    if (t.parameters.required?.includes('start_date')) Object.assign(args, window);
    if (name === 'gads_change_history') {
      Object.assign(args, { start_date: isoDaysAgo(29), end_date: `${isoDaysAgo(0)} 23:59:59` });
    }
    const out = await run(name, args);
    expect(out.fieldMask).toBeDefined();
  }, 30_000);
});
