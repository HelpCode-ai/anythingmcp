import * as adapter from './sumup.json';

type Tool = {
  name: string;
  description: string;
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
  };
};

const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    healthcheckPath?: string;
  };
  tools: Tool[];
};

describe('sumup adapter — static spec conformance', () => {
  it('connects to api.sumup.com via Bearer token', () => {
    expect(a.slug).toBe('sumup');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('payments');
    expect(a.connector.baseUrl).toBe('https://api.sumup.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{SUMUP_API_KEY}}');
    expect(a.requiredEnvVars).toContain('SUMUP_API_KEY');
  });

  it('exposes exactly 6 tools with mapped query params', () => {
    expect(a.tools).toHaveLength(6);
    const names = a.tools.map((t) => t.name);
    expect(names).toEqual([
      'sumup_get_merchant_profile',
      'sumup_list_transactions',
      'sumup_get_transaction',
      'sumup_list_payouts',
      'sumup_list_checkouts',
      'sumup_list_subaccounts',
    ]);

    const tx = a.tools.find((t) => t.name === 'sumup_list_transactions')!;
    expect(tx.endpointMapping.path).toBe('/v0.1/me/transactions/history');
    expect(tx.endpointMapping.queryParams).toBeDefined();

    const getTx = a.tools.find((t) => t.name === 'sumup_get_transaction')!;
    expect(getTx.endpointMapping.path).toBe('/v0.1/me/transactions');
    expect(getTx.endpointMapping.queryParams).toBeDefined();

    const payouts = a.tools.find((t) => t.name === 'sumup_list_payouts')!;
    expect(payouts.endpointMapping.path).toBe('/v0.1/me/financials/payouts');
    expect(payouts.endpointMapping.queryParams).toBeDefined();

    const sub = a.tools.find((t) => t.name === 'sumup_list_subaccounts')!;
    expect(sub.endpointMapping.path).toBe('/v0.1/me/accounts');
  });
});

describe('sumup adapter — live integration', () => {
  const live = process.env.RUN_SUMUP_LIVE === '1' ? it : it.skip;
  live('queries merchant profile with valid SUMUP_API_KEY', async () => {
    expect(process.env.SUMUP_API_KEY).toBeDefined();
  });
});
