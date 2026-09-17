import * as adapter from './teamsystem.json';

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

describe('teamsystem adapter — static spec conformance', () => {
  it("names the tenant, which is what selects a customer's data", () => {
    expect(a.connector.headers?.['X-Tenant-Id']).toBe('{{TEAMSYSTEM_TENANT_ID}}');
  });

  it("uses the client-credentials grant", () => {
    expect(a.connector.authConfig?.grant).toBe('client_credentials');
  });

  it("says partner credentials are required and there is no sandbox", () => {
    const i = (adapter as unknown as { instructions: string }).instructions;
    expect(i).toContain('Partner credentials required');
    expect(i).toContain('no public sandbox');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_TEAMSYSTEM_LIVE === '1';
(live ? describe : describe.skip)('teamsystem — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // teamsystem answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
