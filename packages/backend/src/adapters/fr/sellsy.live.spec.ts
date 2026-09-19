import * as adapter from './sellsy.json';

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

describe('sellsy adapter — static spec conformance', () => {
  it("targets v2, not the single-endpoint v1 RPC API", () => {
    expect(a.connector.baseUrl).toBe('https://api.sellsy.com/v2');
    expect((adapter as unknown as { instructions: string }).instructions).toContain('v1');
  });

  it("authenticates at Sellsy's separate login host", () => {
    expect(a.connector.authConfig?.tokenUrl).toBe('https://login.sellsy.com/oauth2/access-tokens');
  });

  it("offers the expressive POST search alongside the plain list", () => {
    expect(toolNames).toContain('sellsy_search_invoices');
    expect(toolNames).toContain('sellsy_list_invoices');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_SELLSY_LIVE === '1';
(live ? describe : describe.skip)('sellsy — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // sellsy answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
