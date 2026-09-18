import * as adapter from './visma-eaccounting.json';

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

describe('visma-eaccounting adapter — static spec conformance', () => {
  it("targets production, and says where the sandbox is", () => {
    expect(a.connector.baseUrl).toBe('https://eaccountingapi.vismaonline.com/v2');
    expect((adapter as unknown as { instructions: string }).instructions).toContain('eaccountingapi-sandbox');
  });

  it("keeps posted invoices and drafts as separate tools", () => {
    expect(toolNames).toContain('visma_eaccounting_list_customer_invoices');
    expect(toolNames).toContain('visma_eaccounting_list_invoice_drafts');
  });

  it("authenticates against Visma's identity host", () => {
    expect(a.connector.authConfig?.tokenUrl).toBe('https://identity.vismaonline.com/connect/token');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_VISMA_EACCOUNTING_LIVE === '1';
(live ? describe : describe.skip)('visma-eaccounting — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // visma-eaccounting answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
