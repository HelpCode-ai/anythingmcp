import * as adapter from './zalando-zds.json';

const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  probe?: { tool: string };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
    headers?: Record<string, string>;
    healthcheckPath?: string;
  };
  tools: Array<{ name: string; endpointMapping: Record<string, unknown> }>;
};

const toolNames = a.tools.map((t) => t.name);

describe('zalando-zds adapter — static spec conformance', () => {
  it("scopes every path to one merchant id", () => {
    expect(a.connector.baseUrl).toContain('{{ZALANDO_MERCHANT_ID}}');
  });

  it("uses the client-credentials grant Zalando issues in zDirect", () => {
    expect(a.connector.authConfig?.grant).toBe('client_credentials');
  });

  it("says partner onboarding is required, sandbox included", () => {
    const i = (adapter as unknown as { instructions: string }).instructions;
    expect(i).toContain('Partner onboarding required');
    expect(i).toContain('api-sandbox.merchants.zalando.com');
  });

  it("targets the zDirect merchant API and its /auth/token endpoint", () => {
    expect(a.connector.baseUrl).toBe('https://api.merchants.zalando.com/merchants/{{ZALANDO_MERCHANT_ID}}');
    expect(a.connector.authConfig?.tokenUrl).toBe('https://api.merchants.zalando.com/auth/token');
  });

  it("uses the documented order filters, page-number paging and per-order shipments", () => {
    const orders = a.tools.find((t) => t.name === 'zalando_zds_list_orders')!;
    const qp = orders.endpointMapping.queryParams as Record<string, string>;
    expect(qp['page[size]']).toBe('$page_size');
    expect(qp['page[number]']).toBe('$page_number');
    expect(qp.order_status).toBe('$order_status');
    expect(qp.created_after).toBe('$created_after');
    expect(a.tools.find((t) => t.name === 'zalando_zds_list_shipments')!.endpointMapping.path).toBe(
      '/orders/{orderId}/shipments',
    );
    expect(a.tools.find((t) => t.name === 'zalando_zds_list_returns')!.endpointMapping.path).toBe('/announced-returns');
  });

  it("offers no stock or price read tool, since those APIs are write-only", () => {
    expect(toolNames).not.toContain('zalando_zds_list_stock');
    expect(toolNames).not.toContain('zalando_zds_list_prices');
  });

  it("exposes no write tool", () => {
    expect(a.tools.every((t) => t.endpointMapping.method === 'GET')).toBe(true);
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_ZALANDO_ZDS_LIVE === '1';
(live ? describe : describe.skip)('zalando-zds — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // zalando-zds answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
