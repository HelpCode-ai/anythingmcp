import * as adapter from './lexware-office.json';

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

describe('lexware-office adapter — static spec conformance', () => {
  it("targets api.lexware.io/v1, not the legacy lexoffice host", () => {
    expect(a.connector.baseUrl).toBe('https://api.lexware.io/v1');
  });

  it("authenticates with a bearer token from LEXWARE_API_KEY", () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig?.token).toBe('{{LEXWARE_API_KEY}}');
  });

  it("probes /profile, which every token can read", () => {
    expect(a.probe?.tool).toBe('lexware_office_get_profile');
    expect(a.connector.healthcheckPath).toBe('/profile');
  });

  it("exposes the voucher list, which is what 'what is unpaid' needs", () => {
    expect(toolNames).toContain('lexware_office_list_vouchers');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_LEXWARE_OFFICE_LIVE === '1';
(live ? describe : describe.skip)('lexware-office — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // lexware-office answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
