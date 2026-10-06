import * as adapter from './reddit-ads.json';

type Tool = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
};
const a = adapter as unknown as {
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;

describe('reddit-ads adapter: static spec conformance', () => {
  it('Ads API v3 base URL', () => expect(a.connector.baseUrl).toBe('https://ads-api.reddit.com/api/v3'));

  it('Reddit OAuth2: permanent duration (refresh token), Basic client auth, adsread, custom User-Agent', () => {
    const c = a.connector.authConfig;
    expect(a.connector.authType).toBe('OAUTH2');
    expect(c.authorizationUrl).toBe('https://www.reddit.com/api/v1/authorize?duration=permanent');
    expect(c.tokenUrl).toBe('https://www.reddit.com/api/v1/access_token');
    expect(c.tokenAuthMethod).toBe('client_secret_basic');
    expect(c.scopes).toBe('adsread');
    expect((c.extraHeaders as Record<string, string>)['User-Agent']).toMatch(/^web:anythingmcp:/);
  });

  it('probe is GET /me', () => expect(tool(a.probe.tool).endpointMapping).toMatchObject({ method: 'GET', path: '/me' }));

  it('every tool reads: GETs, plus the POST report marked read-only', () => {
    for (const t of a.tools) {
      if (t.endpointMapping.method !== 'GET') {
        expect(t.name).toBe('reddit_ads_get_report');
        expect(t.annotations?.readOnlyHint).toBe(true);
      }
    }
  });

  it('pagination uses the dotted page.size / page.token query names', () => {
    expect(tool('reddit_ads_list_campaigns').endpointMapping.queryParams).toMatchObject({ 'page.size': '$page_size', 'page.token': '$page_token' });
  });

  it('report body is wrapped in data', () => {
    const body = tool('reddit_ads_get_report').endpointMapping.bodyMapping as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ starts_at: '$starts_at', ends_at: '$ends_at', fields: '$fields' });
  });
});
