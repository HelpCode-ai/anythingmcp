import axios from 'axios';
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

  it('keeps the original 6 tools first, with mapped query params', () => {
    const names = a.tools.map((t) => t.name);
    expect(names.slice(0, 6)).toEqual([
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

describe('sumup adapter: read-only merchant API', () => {
  const tool = (name: string) => {
    const t = a.tools.find((x) => x.name === name);
    if (!t) throw new Error(`missing tool ${name}`);
    return t;
  };

  it('maps the current merchant-scoped reads', () => {
    const paths: Record<string, string> = {
      sumup_list_memberships: '/v0.1/memberships',
      sumup_get_merchant: '/v1/merchants/{merchant_code}',
      sumup_list_merchant_payouts: '/v1.0/merchants/{merchant_code}/payouts',
      sumup_list_merchant_transactions: '/v2.1/merchants/{merchant_code}/transactions/history',
      sumup_get_merchant_transaction: '/v2.1/merchants/{merchant_code}/transactions',
      sumup_get_receipt: '/v1.1/receipts/{transaction_id}',
      sumup_get_checkout: '/v0.1/checkouts/{checkout_id}',
      sumup_get_customer: '/v0.1/customers/{customer_id}',
      sumup_list_payment_instruments: '/v0.1/customers/{customer_id}/payment-instruments',
      sumup_list_payment_methods: '/v0.1/merchants/{merchant_code}/payment-methods',
      sumup_list_members: '/v0.1/merchants/{merchant_code}/members',
      sumup_get_member: '/v0.1/merchants/{merchant_code}/members/{member_id}',
      sumup_list_roles: '/v0.1/merchants/{merchant_code}/roles',
      sumup_get_role: '/v0.1/merchants/{merchant_code}/roles/{role_id}',
      sumup_list_persons: '/v1/merchants/{merchant_code}/persons',
      sumup_get_person: '/v1/merchants/{merchant_code}/persons/{person_id}',
      sumup_list_readers: '/v0.1/merchants/{merchant_code}/readers',
      sumup_get_reader: '/v0.1/merchants/{merchant_code}/readers/{reader_id}',
      sumup_get_reader_status: '/v0.1/merchants/{merchant_code}/readers/{reader_id}/status',
      sumup_get_reader_checkout: '/v0.1/merchants/{merchant_code}/readers/{reader_id}/checkout/{checkout_id}',
    };
    for (const [name, path] of Object.entries(paths)) expect(tool(name).endpointMapping.path).toBe(path);
    expect(tool('sumup_list_merchant_payouts').endpointMapping.queryParams).toMatchObject({ start_date: '$start_date', end_date: '$end_date' });
    expect(tool('sumup_list_merchant_transactions').endpointMapping.queryParams).toMatchObject({ 'statuses[]': '$statuses', oldest_time: '$oldest_time' });
    expect(tool('sumup_get_receipt').endpointMapping.queryParams).toMatchObject({ mid: '$merchant_code' });
  });

  it('only reads: every tool is a GET, nothing refunds, charges or creates checkouts', () => {
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/refund|terminate|go-checkout|apple-pay/);
  });
});

describe('sumup adapter — live integration', () => {
  const live = process.env.RUN_SUMUP_LIVE === '1' && process.env.SUMUP_API_KEY ? it : it.skip;

  live('GET https://api.sumup.com/v0.1/me returns merchant_profile', async () => {
    const response = await axios.get('https://api.sumup.com/v0.1/me', {
      headers: {
        Authorization: `Bearer ${process.env.SUMUP_API_KEY}`,
        Accept: 'application/json',
      },
      timeout: 15000,
    });
    expect(response.status).toBe(200);
    expect(response.data).toHaveProperty('merchant_profile');
  });
});
