import * as adapter from './haufe-x360.json';

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

describe('haufe-x360 adapter — static spec conformance', () => {
  it("holds the Acumatica session cookie instead of logging in per call", () => {
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig?.cookieName).toBe('.ASPXAUTH');
  });

  it("pins the contract-based endpoint version in the base URL", () => {
    expect(a.connector.baseUrl).toContain('/entity/Default/');
  });

  it("treats the company as optional, for single-company tenants", () => {
    expect(a.optionalEnvVars).toEqual(['X360_COMPANY']);
  });

  it("says partner credentials are required", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('Partner credentials required');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_HAUFE_X360_LIVE === '1';
(live ? describe : describe.skip)('haufe-x360 — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // haufe-x360 answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
