import * as adapter from './revolut-business.json';

const a = adapter as unknown as {
  requiredEnvVars: string[];
  instructions: string;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, any> };
  tools: Array<{ name: string; endpointMapping: { method: string; path: string } }>;
};

// Values from developer.revolut.com, "Make your first API request" and the
// Business API reference (revolut-engineering/revolut-openapi, business.json).
describe('revolut-business adapter — static spec conformance', () => {
  it('calls the production Business API', () =>
    expect(a.connector.baseUrl).toBe('https://b2b.revolut.com/api/1.0'));

  it('is authorized in the browser through app-confirm, READ scope only', () => {
    const auth = a.connector.authConfig;
    expect(a.connector.authType).toBe('OAUTH2');
    expect(auth.authorizationUrl).toBe('https://business.revolut.com/app-confirm');
    expect(auth.tokenUrl).toBe('https://b2b.revolut.com/api/1.0/auth/token');
    expect(auth.scopes).toBe('READ');
    expect(auth.clientSecret).toBeUndefined();
  });

  // Revolut authenticates the client with a JWT signed by the key whose
  // certificate was uploaded: RS256, iss = redirect URI domain,
  // sub = client id, aud = https://revolut.com.
  it('signs a client assertion with the uploaded certificate key', () => {
    const auth = a.connector.authConfig;
    expect(auth.tokenAuthMethod).toBe('private_key_jwt');
    expect(auth.clientId).toBe('{{REVOLUT_CLIENT_ID}}');
    expect(auth.clientAssertion).toEqual({
      privateKey: '{{REVOLUT_PRIVATE_KEY}}',
      algorithm: 'RS256',
      ttlSeconds: 300,
      claims: { iss: '{{REVOLUT_REDIRECT_DOMAIN}}', aud: 'https://revolut.com' },
    });
    expect(a.requiredEnvVars).toEqual([
      'REVOLUT_CLIENT_ID',
      'REVOLUT_PRIVATE_KEY',
      'REVOLUT_REDIRECT_DOMAIN',
    ]);
  });

  it('only reads: every tool is a GET, none moves money', () => {
    for (const tool of a.tools) expect(tool.endpointMapping.method).toBe('GET');
    const paths = a.tools.map((t) => t.endpointMapping.path);
    for (const write of ['/pay', '/transfer', '/exchange', '/payment-drafts', '/payout-links']) {
      expect(paths).not.toContain(write);
    }
  });

  it('uses the documented endpoint paths', () => {
    expect(Object.fromEntries(a.tools.map((t) => [t.name, t.endpointMapping.path]))).toEqual({
      revolut_list_accounts: '/accounts',
      revolut_get_account: '/accounts/{account_id}',
      revolut_get_account_bank_details: '/accounts/{account_id}/bank-details',
      revolut_list_transactions: '/transactions',
      revolut_get_transaction: '/transaction/{id}',
      revolut_list_counterparties: '/counterparties',
      revolut_get_counterparty: '/counterparty/{counterparty_id}',
      revolut_get_exchange_rate: '/rate',
      revolut_list_expenses: '/expenses',
      revolut_get_expense: '/expenses/{expense_id}',
    });
  });

  it('probes with the account list once authorized', () =>
    expect(a.probe.tool).toBe('revolut_list_accounts'));

  it('tells users the callback URL, the certificate commands and the sandbox hosts', () => {
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toContain('openssl genrsa -out privatecert.pem 2048');
    expect(a.instructions).toContain('Authorize with Provider');
    expect(a.instructions).toContain('https://sandbox-b2b.revolut.com/api/1.0');
  });
});
