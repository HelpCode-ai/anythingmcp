import * as adapter from './otto-ads.json';
import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

type Tool = {
  name: string;
  enabled?: boolean;
  annotations?: Record<string, unknown>;
  parameters: { required?: string[]; properties: Record<string, unknown> };
  endpointMapping: Record<string, any>;
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

/**
 * OTTO Sponsored Product Ads + SPA reporting. The read paths were checked
 * against a live advertiser account (campaigns, targets, keywords, campaign
 * and product KPIs, report status); the writes follow OTTO's documentation
 * and a production integration that made thousands of successful calls with
 * the same paths and bodies.
 */
describe('otto-ads adapter: static spec conformance', () => {
  it('uses the OTTO token endpoint with the advertising scope, not the partner API scopes', () => {
    expect(a.connector.baseUrl).toBe('https://api.otto.market');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig.grant).toBe('client_credentials');
    expect(a.connector.authConfig.tokenUrl).toBe('https://api.otto.market/v1/token');
    expect(a.connector.authConfig.tokenAuthMethod).toBe('client_secret_post');
    expect(a.connector.authConfig.scope).toBe('advertising-services');
    expect(a.requiredEnvVars).toEqual(['OTTO_ADS_CLIENT_ID', 'OTTO_ADS_CLIENT_SECRET']);
  });

  it('does not pin Accept to application/json (OTTO answers hal+json and refuses that header with 400)', () => {
    expect(a.connector.headers.Accept).toBeUndefined();
  });

  it('every path placeholder is a required parameter', () => {
    for (const t of a.tools) {
      const names = [...String(t.endpointMapping.path).matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
      for (const n of names) expect({ tool: t.name, required: t.parameters.required ?? [] }).toEqual({
        tool: t.name,
        required: expect.arrayContaining([n]),
      });
    }
  });

  it('report requests are POSTs marked read-only; deleting keywords is installed switched off', () => {
    for (const n of ['otto_ads_request_campaign_report', 'otto_ads_request_keyword_report', 'otto_ads_request_product_report']) {
      expect(tool(n).endpointMapping.method).toBe('POST');
      expect(tool(n).annotations).toEqual({ readOnlyHint: true });
    }
    expect(tool('otto_ads_delete_keywords').enabled).toBe(false);
  });

  it('the probe is a cheap campaign list', () => expect(a.probe.tool).toBe('otto_ads_list_campaigns'));
});

describe('otto-ads adapter: requests', () => {
  const engine = new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue('tok'), refreshToken: jest.fn() } as any,
    { getToken: jest.fn(), forceRelogin: jest.fn() } as any,
  );
  const base = 'https://api.otto.market';
  const config = {
    baseUrl: base,
    authType: 'OAUTH2' as const,
    authConfig: { ...a.connector.authConfig, clientId: 'id', clientSecret: 'secret' },
    headers: a.connector.headers,
  };
  const run = (name: string, params: Record<string, unknown>) =>
    engine.execute(config, tool(name).endpointMapping as any, params);
  const sent = () => mockedAxios.mock.calls[0][0] as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.mockResolvedValue({ status: 200, data: { ok: true }, headers: {} });
  });

  it('lists keywords of a target with the cursor', async () => {
    await run('otto_ads_list_keywords', { campaign_id: 'c1', target_id: 't1', limit: 100, cursor: 'abc' });
    expect(sent().method).toBe('GET');
    expect(sent().url).toBe(`${base}/v1/sponsored-product-ads/campaigns/c1/targets/t1/keywords`);
    expect(sent().params).toEqual({ limit: 100, cursor: 'abc' });
    expect(sent().headers.Authorization).toBe('Bearer tok');
  });

  it('reads campaign KPIs with OTTO parameter names', async () => {
    await run('otto_ads_get_campaign_kpis', { campaign_id: 'c1', from_date: '2026-10-01', to_date: '2026-10-21' });
    expect(sent().url).toBe(`${base}/v1/spa-reporting/campaign-performance`);
    expect(sent().params).toEqual({ campaignId: 'c1', fromDate: '2026-10-01', toDate: '2026-10-21' });
  });

  it('builds the report status path from the report type', async () => {
    await run('otto_ads_get_report_status', { report_type: 'keyword', report_id: 'r1' });
    expect(sent().url).toBe(`${base}/v1/spa-reporting/keyword-performance/status`);
    expect(sent().params).toEqual({ reportId: 'r1' });
  });

  it('requests a keyword report with a CSV configuration', async () => {
    await run('otto_ads_request_keyword_report', {
      name: 'kw',
      from_date: '2026-10-01',
      to_date: '2026-10-21',
      columns: ['SEARCHTERM', 'TOTAL_CLICKS'],
      group_by: ['SEARCHTERM'],
    });
    expect(sent().method).toBe('POST');
    expect(sent().data).toEqual({
      name: 'kw',
      fromDate: '2026-10-01',
      toDate: '2026-10-21',
      configuration: { format: 'CSV', columns: ['SEARCHTERM', 'TOTAL_CLICKS'], groupBy: ['SEARCHTERM'] },
    });
  });

  it('pauses a campaign with a JSON merge patch', async () => {
    await run('otto_ads_update_campaign', { campaign_id: 'c1', status: 'PAUSED' });
    expect(sent().method).toBe('PATCH');
    expect(sent().url).toBe(`${base}/v1/sponsored-product-ads/campaigns/c1`);
    expect(sent().headers['Content-Type']).toBe('application/merge-patch+json');
    expect(sent().data).toEqual({ status: 'PAUSED' });
  });

  it('adds negative keywords to a target', async () => {
    const keywords = [{ keyword: 'gratis', matchType: 'PHRASE', keywordType: 'NEGATIVE' }];
    await run('otto_ads_add_keywords', { campaign_id: 'c1', target_id: 't1', keywords });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe(`${base}/v1/sponsored-product-ads/campaigns/c1/targets/t1/keywords`);
    expect(sent().data).toEqual({ keywords });
  });

  it('deletes keywords by repeated keywordIds query parameters', async () => {
    await run('otto_ads_delete_keywords', { campaign_id: 'c1', target_id: 't1', keyword_ids: ['k1', 'k2'] });
    expect(sent().method).toBe('DELETE');
    expect(sent().params).toEqual({ keywordIds: ['k1', 'k2'] });
    expect(sent().paramsSerializer({ keywordIds: ['k1', 'k2'] })).toBe('keywordIds=k1&keywordIds=k2');
  });
});

// Opt-in live check with an advertiser's own app: read-only calls only.
const live = process.env.RUN_OTTO_ADS_LIVE === '1';
(live ? describe : describe.skip)('otto-ads: live (read-only)', () => {
  const realAxios = jest.requireActual('axios').default;
  let token = '';

  beforeAll(async () => {
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'advertising-services',
      client_id: process.env.OTTO_ADS_CLIENT_ID ?? '',
      client_secret: process.env.OTTO_ADS_CLIENT_SECRET ?? '',
    });
    const res = await realAxios.post('https://api.otto.market/v1/token', form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    token = res.data.access_token;
  });

  it('lists campaigns with a cursor', async () => {
    const res = await realAxios.get('https://api.otto.market/v1/sponsored-product-ads/campaigns', {
      params: { limit: 1 },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.campaigns)).toBe(true);
    expect(res.data).toHaveProperty('nextCursor');
  });
});
