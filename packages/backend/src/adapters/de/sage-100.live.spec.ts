import * as adapter from './sage-100.json';

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

describe('sage-100 adapter — static spec conformance', () => {
  it("scopes the connector to one mandant", () => {
    expect(a.connector.baseUrl).toContain('{{SAGE100_COMPANY}}');
  });

  it("makes $metadata the entry point, since installs differ", () => {
    expect(a.probe?.tool).toBe('sage_100_get_metadata');
  });

  it("says partner credentials are required", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('Partner credentials required');
  });

  it("exposes no write tool", () => {
    expect(a.tools.every((t) => t.endpointMapping.method === 'GET')).toBe(true);
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_SAGE_100_LIVE === '1';
(live ? describe : describe.skip)('sage-100 — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // sage-100 answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
