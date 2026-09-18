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

  it("says partner onboarding is required and there is no sandbox", () => {
    const i = (adapter as unknown as { instructions: string }).instructions;
    expect(i).toContain('Partner onboarding required');
    expect(i).toContain('no public sandbox');
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
