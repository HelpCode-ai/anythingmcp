import * as adapter from './qonto.json';

const a = adapter as unknown as {
  category: string;
  requiredEnvVars: string[];
  instructions: string;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Array<{ name: string; description: string; endpointMapping: { method: string; path: string } }>;
};

// Values from docs.qonto.com: "API key" authentication page, "Pagination",
// "Accessing the Sandbox environment" and the Business API v2 reference.
describe('qonto adapter — static spec conformance', () => {
  it('calls the production Business API v2', () =>
    expect(a.connector.baseUrl).toBe('https://thirdparty.qonto.com/v2'));

  it('sends login:secret-key in Authorization, no Bearer, no Base64', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('Authorization');
    expect(a.connector.authConfig.apiKey).toBe('{{QONTO_LOGIN}}:{{QONTO_SECRET_KEY}}');
    expect(a.connector.authConfig.apiKey).toContain(':');
    expect(a.connector.authConfig.apiKey).not.toMatch(/bearer|basic/i);
    expect(a.requiredEnvVars).toEqual(['QONTO_LOGIN', 'QONTO_SECRET_KEY']);
  });

  it('only reads: every tool is a GET', () => {
    for (const tool of a.tools) {
      expect(['POST', 'PUT', 'PATCH', 'DELETE']).not.toContain(tool.endpointMapping.method);
      expect(tool.endpointMapping.method).toBe('GET');
    }
  });

  it('uses the documented endpoint paths', () => {
    expect(Object.fromEntries(a.tools.map((t) => [t.name, t.endpointMapping.path]))).toEqual({
      qonto_get_organization: '/organization',
      qonto_list_transactions: '/transactions',
      qonto_get_transaction: '/transactions/{id}',
      qonto_list_client_invoices: '/client_invoices',
      qonto_list_supplier_invoices: '/supplier_invoices',
      qonto_list_clients: '/clients',
      qonto_list_quotes: '/quotes',
    });
  });

  it('is a banking adapter probed with the organization', () => {
    expect(a.category).toBe('banking');
    expect(a.probe.tool).toBe('qonto_get_organization');
  });

  it('tells the agent to fetch a bank account before listing transactions', () => {
    const tx = a.tools.find((t) => t.name === 'qonto_list_transactions')!;
    expect(tx.description).toContain('qonto_get_organization');
    expect(tx.description).toContain('only completed');
  });

  it('does not suggest the deprecated to_pay supplier invoice status as a filter', () => {
    const si = a.tools.find((t) => t.name === 'qonto_list_supplier_invoices')!;
    expect(JSON.stringify(si)).toContain('to_review');
    expect(JSON.stringify(si)).toContain('query_fields');
  });

  it('documents the sandbox host and staging header', () => {
    expect(a.instructions).toContain('https://thirdparty-sandbox.staging.qonto.co/v2');
    expect(a.instructions).toContain('X-Qonto-Staging-Token');
  });
});

// Opt-in live check against the Qonto sandbox. Needs QONTO_LOGIN,
// QONTO_SECRET_KEY and QONTO_STAGING_TOKEN; QONTO_BASE_URL overrides the host.
const live = process.env.RUN_QONTO_LIVE === '1';
(live ? describe : describe.skip)('qonto — live (sandbox)', () => {
  const base = process.env.QONTO_BASE_URL ?? 'https://thirdparty-sandbox.staging.qonto.co/v2';
  const headers: Record<string, string> = {
    Authorization: `${process.env.QONTO_LOGIN}:${process.env.QONTO_SECRET_KEY}`,
    Accept: 'application/json',
  };
  if (process.env.QONTO_STAGING_TOKEN) headers['X-Qonto-Staging-Token'] = process.env.QONTO_STAGING_TOKEN;

  let accountId: string | undefined;

  it('reads the organization and its bank accounts', async () => {
    const res = await fetch(`${base}/organization`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { organization: { bank_accounts: Array<{ id: string }> } };
    accountId = body.organization.bank_accounts[0]?.id;
    expect(accountId).toBeTruthy();
  });

  it('lists transactions of the first bank account', async () => {
    const res = await fetch(`${base}/transactions?bank_account_id=${accountId}&per_page=5`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { transactions: unknown[]; meta: { current_page: number } };
    expect(Array.isArray(body.transactions)).toBe(true);
    expect(body.meta.current_page).toBe(1);
  });
});
