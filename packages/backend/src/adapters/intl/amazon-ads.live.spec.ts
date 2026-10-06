import * as adapter from './amazon-ads.json';

type Tool = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  parameters?: { properties?: Record<string, { default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
};
const a = adapter as unknown as {
  probe: { tool: string };
  envVarMeta: Record<string, { pattern?: string }>;
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;
const matches = (v: string, s: string) => new RegExp(a.envVarMeta[v].pattern!).test(s);

describe('amazon-ads adapter: static spec conformance', () => {
  it('LWA OAuth2 with the campaign management scope and the client id header', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig.scopes).toBe('advertising::campaign_management');
    expect(a.connector.headers['Amazon-Advertising-API-ClientId']).toBe('{{AMAZON_ADS_CLIENT_ID}}');
  });

  it('region patterns accept exactly the documented hosts', () => {
    for (const h of ['https://advertising-api.amazon.com', 'https://advertising-api-eu.amazon.com', 'https://advertising-api-fe.amazon.com'])
      expect(matches('AMAZON_ADS_API_URL', h)).toBe(true);
    expect(matches('AMAZON_ADS_API_URL', 'https://advertising-api-na.amazon.com')).toBe(false);
    expect(matches('AMAZON_ADS_AUTHORIZATION_URL', 'https://eu.account.amazon.com/ap/oa')).toBe(true);
    expect(matches('AMAZON_ADS_TOKEN_URL', 'https://api.amazon.co.uk/auth/o2/token')).toBe(true);
  });

  it('profiles list is the probe and needs no scope header', () => {
    expect(a.probe.tool).toBe('amazon_ads_list_profiles');
    expect(tool('amazon_ads_list_profiles').endpointMapping).toMatchObject({ method: 'GET', path: '/v2/profiles' });
    expect(tool('amazon_ads_list_profiles').endpointMapping.headers).toBeUndefined();
  });

  it('SP list calls are POST /list with the v3 media type, marked read-only, scoped by profile', () => {
    const lists = a.tools.filter((t) => t.endpointMapping.path.startsWith('/sp/'));
    expect(lists.length).toBe(6);
    for (const t of lists) {
      expect(t.endpointMapping.path).toMatch(/^\/sp\/\w+\/list$/);
      expect(t.endpointMapping.headers!['Content-Type']).toMatch(/^application\/vnd\.sp\w+\.v3\+json$/);
      expect(t.endpointMapping.headers!.Accept).toBe(t.endpointMapping.headers!['Content-Type']);
      expect(t.endpointMapping.headers!['Amazon-Advertising-API-Scope']).toBe('$profile_id');
      expect(t.annotations?.readOnlyHint).toBe(true);
      // stateFilter.include is required by the API, so the parameter has a default.
      expect(t.parameters!.properties!.state_filter.default).toEqual(['ENABLED', 'PAUSED']);
    }
  });

  it('report creation is a write (not read-only) that always asks for GZIP_JSON', () => {
    const t = tool('amazon_ads_create_report');
    expect(t.annotations?.readOnlyHint).toBeUndefined();
    expect(t.endpointMapping.headers!['Content-Type']).toBe('application/vnd.createasyncreportrequest.v3+json');
    expect((t.endpointMapping.bodyMapping!.configuration as Record<string, unknown>).format).toBe('GZIP_JSON');
  });
});
