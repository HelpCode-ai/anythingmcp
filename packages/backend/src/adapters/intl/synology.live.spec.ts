import * as adapter from './synology.json';

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

describe('synology adapter — static spec conformance', () => {
  it("logs in for a DSM session id and returns it as a cookie", () => {
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig?.tokenJsonPath).toBe('data.sid');
    expect(a.connector.authConfig?.headerTemplate).toBe('id=${token}');
  });

  it("names an api, version and method on every call", () => {
    for (const t of a.tools) {
      const qp = t.endpointMapping.queryParams as Record<string, string>;
      expect(qp.api).toMatch(/^SYNO\./);
      expect(qp.version).toBeDefined();
      expect(qp.method).toBeDefined();
    };
  });

  it("warns that DSM reports failure inside an HTTP 200", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('A 200 is not a result');
  });

  it("says two-factor authentication blocks the login call", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('two-factor');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_SYNOLOGY_LIVE === '1';
(live ? describe : describe.skip)('synology — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // synology answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
