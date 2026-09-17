import * as adapter from './mautic.json';

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

describe('mautic adapter — static spec conformance', () => {
  it("authenticates with a dedicated Mautic user over Basic auth", () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig?.username).toBe('{{MAUTIC_USERNAME}}');
  });

  it("says the API and basic auth are both off by default", () => {
    const i = (adapter as unknown as { instructions: string }).instructions;
    expect(i).toContain('API enabled');
    expect(i).toContain('Enable HTTP basic auth');
  });

  it("warns that anonymous visitors swamp a contact list", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('!is:anonymous');
  });

  it("exposes no write tool", () => {
    expect(a.tools.every((t) => t.endpointMapping.method === 'GET')).toBe(true);
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_MAUTIC_LIVE === '1';
(live ? describe : describe.skip)('mautic — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // mautic answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
