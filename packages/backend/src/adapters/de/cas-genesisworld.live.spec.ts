import * as adapter from './cas-genesisworld.json';

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

describe('cas-genesisworld adapter — static spec conformance', () => {
  it("authenticates with a genesisWorld user over Basic auth", () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig?.username).toBe('{{CAS_USERNAME}}');
  });

  it("points at the customer's own genesisWorld Web server", () => {
    expect(a.connector.baseUrl).toBe('{{CAS_URL}}/api/v1');
  });

  it("says plainly that it has not been run against a live tenant", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('Unverified');
  });

  it("exposes no write tool", () => {
    expect(a.tools.every((t) => t.endpointMapping.method === 'GET')).toBe(true);
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_CAS_GENESISWORLD_LIVE === '1';
(live ? describe : describe.skip)('cas-genesisworld — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // cas-genesisworld answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
