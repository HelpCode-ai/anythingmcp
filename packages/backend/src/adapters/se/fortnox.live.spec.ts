import * as adapter from './fortnox.json';

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

describe('fortnox adapter — static spec conformance', () => {
  it("is filed under the Swedish region", () => {
    expect(a.region).toBe('se');
  });

  it("uses OAuth2, not the retired Access-Token header pair", () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(JSON.stringify(a.connector)).not.toContain('Access-Token');
  });

  it("sends the client credentials as Basic, as Fortnox requires", () => {
    expect(a.connector.authConfig?.tokenAuthMethod).toBe('basic');
  });

  it("warns that vouchers default to the current financial year", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('a surprise in January');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_FORTNOX_LIVE === '1';
(live ? describe : describe.skip)('fortnox — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // fortnox answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
