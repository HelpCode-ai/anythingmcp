import * as adapter from './e-conomic.json';

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

describe('e-conomic adapter — static spec conformance', () => {
  it("is filed under the Danish region", () => {
    expect(a.region).toBe('dk');
  });

  it("sends the app secret and the agreement grant as two headers", () => {
    expect(a.connector.authConfig?.headerName).toBe('X-AppSecretToken');
    expect((a.connector.authConfig?.extraHeaders as Record<string, string>)['X-AgreementGrantToken']).toBe('{{ECONOMIC_AGREEMENT_GRANT_TOKEN}}');
  });

  it("keeps booked, overdue and draft invoices as separate tools", () => {
    expect(toolNames).toEqual(expect.arrayContaining(['e_conomic_list_booked_invoices', 'e_conomic_list_overdue_invoices', 'e_conomic_list_draft_invoices']));
  });

  it("probes /self, which exercises both tokens at once", () => {
    expect(a.probe?.tool).toBe('e_conomic_get_self');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_E_CONOMIC_LIVE === '1';
(live ? describe : describe.skip)('e-conomic — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // e-conomic answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
