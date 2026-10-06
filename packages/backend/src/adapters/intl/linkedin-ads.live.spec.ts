import * as adapter from './linkedin-ads.json';

type Tool = {
  name: string;
  endpointMapping: { method: string; path: string; headers?: Record<string, string>; queryParams?: Record<string, string> };
};
const a = adapter as unknown as {
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;

describe('linkedin-ads adapter: static spec conformance', () => {
  it('versioned REST base with LinkedIn OAuth2 and the read-only ads scopes', () => {
    expect(a.connector.baseUrl).toBe('https://api.linkedin.com/rest');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig.authorizationUrl).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(a.connector.authConfig.tokenUrl).toBe('https://www.linkedin.com/oauth/v2/accessToken');
    expect(a.connector.authConfig.scopes).toBe('r_ads r_ads_reporting');
  });

  it('every tool is a GET with a YYYYMM LinkedIn-Version and Rest.li 2.0', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(t.endpointMapping.headers?.['LinkedIn-Version']).toMatch(/^20\d{4}$/);
      expect(t.endpointMapping.headers?.['X-Restli-Protocol-Version']).toBe('2.0.0');
    }
  });

  it('URNs are pre-encoded in the path (the query serializer would keep ":" literal)', () => {
    expect(tool('linkedin_ads_get_account_analytics').endpointMapping.path).toContain('List(urn%3Ali%3AsponsoredAccount%3A{account_id})');
    expect(tool('linkedin_ads_get_campaign_analytics').endpointMapping.path).toContain('List(urn%3Ali%3AsponsoredCampaign%3A{campaign_id})');
    expect(tool('linkedin_ads_get_creative').endpointMapping.path).toBe('/adAccounts/{account_id}/creatives/urn%3Ali%3AsponsoredCreative%3A{creative_id}');
  });

  it('analytics date range is built in Rest.li syntax', () => {
    expect(tool('linkedin_ads_get_account_analytics').endpointMapping.queryParams!.dateRange).toBe(
      '(start:(year:${start_year},month:${start_month},day:${start_day}),end:(year:${end_year},month:${end_month},day:${end_day}))',
    );
  });

  it('probe lists the accounts of the authenticated member', () => {
    expect(tool(a.probe.tool).endpointMapping).toMatchObject({ path: '/adAccountUsers', queryParams: { q: 'authenticatedUser' } });
  });
});
