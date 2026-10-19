import * as adapter from './snov.json';

/**
 * Static checks for the Snov.io adapter, pinned against snov.io/api
 * (checked 19 Oct 2026) and the errors a live Cloud connector logged:
 *
 *   - The access token lives one hour. The adapter used to ask for it as a
 *     variable, so a connector stopped working an hour after setup (401
 *     Unauthenticated). It now signs in with the API User ID and Secret
 *     (OAuth 2.0 client credentials) and renews the token itself.
 *   - Check user balance is GET; POST answered 403.
 *   - v1 get-domain-emails-with-info is gone (404); domain search is the v2
 *     start + result pair.
 *   - Creating a list is POST /v1/lists.
 */
type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyMapping?: Record<string, string>; bodyEncoding?: string };
  annotations?: { readOnlyHint?: boolean };
};
const a = adapter as unknown as {
  requiredEnvVars: string[];
  envVarMeta: Record<string, { secret?: boolean }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

describe('snov adapter: static spec conformance', () => {
  it('api.snov.io/v1 as the base', () => expect(a.connector.baseUrl).toBe('https://api.snov.io/v1'));

  it('signs in with client credentials and renews the hourly token itself', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{SNOV_CLIENT_ID}}',
      clientSecret: '{{SNOV_CLIENT_SECRET}}',
      tokenUrl: 'https://api.snov.io/v1/oauth/access_token',
      tokenAuthMethod: 'client_secret_post',
    });
    expect(a.requiredEnvVars).toEqual(['SNOV_CLIENT_ID', 'SNOV_CLIENT_SECRET']);
    expect(a.envVarMeta.SNOV_CLIENT_SECRET.secret).toBe(true);
    expect(JSON.stringify(a)).not.toContain('SNOV_ACCESS_TOKEN');
  });

  it('balance is a free GET and the probe', () => {
    expect(tool('snov_balance').endpointMapping).toEqual({ method: 'GET', path: '/get-balance' });
    expect(a.probe.tool).toBe('snov_balance');
  });

  it('domain search is the v2 start + result pair', () => {
    const start = tool('snov_domain_search');
    expect(start.endpointMapping.method).toBe('POST');
    expect(start.endpointMapping.path).toBe('https://api.snov.io/v2/domain-search/domain-emails/start');
    expect(start.endpointMapping.bodyMapping).toEqual({ domain: '$domain', next: '$next' });
    const result = tool('snov_get_domain_search_result');
    expect(result.endpointMapping.method).toBe('GET');
    expect(result.endpointMapping.path).toBe(
      'https://api.snov.io/v2/domain-search/domain-emails/result/{task_hash}',
    );
    expect(result.parameters.required).toEqual(['task_hash']);
    expect(JSON.stringify(a.tools)).not.toContain('get-domain-emails-with-info');
  });

  it('the free count is a read-only POST', () => {
    const t = tool('snov_get_domain_emails_count');
    expect(t.endpointMapping).toMatchObject({ method: 'POST', path: '/get-domain-emails-count' });
    expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it('creating a list is POST /lists', () => {
    expect(tool('snov_create_prospect_list').endpointMapping).toMatchObject({ method: 'POST', path: '/lists' });
  });

  it('every tool that spends credits says so', () => {
    for (const n of ['snov_domain_search', 'snov_email_finder', 'snov_email_verifier', 'snov_email_finder_by_url']) {
      expect(tool(n).description).toMatch(/credit/i);
    }
  });
});
