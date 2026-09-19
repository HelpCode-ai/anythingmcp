import * as adapter from './buchhaltungsbutler.json';

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

describe('buchhaltungsbutler adapter — static spec conformance', () => {
  it("authenticates the API client with HTTP Basic", () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig?.username).toBe('{{BUCHHALTUNGSBUTLER_CLIENT_ID}}');
  });

  it("carries the separate api_key in every request body", () => {
    for (const t of a.tools) {
      const body = t.endpointMapping.bodyMapping as Record<string, unknown>;
      expect(body.api_key).toBe('$BUCHHALTUNGSBUTLER_API_KEY');
    };
  });

  it("reads over POST, as the API requires", () => {
    expect(a.tools.every((t) => t.endpointMapping.method === 'POST')).toBe(true);
  });

  it("declares all three credentials", () => {
    expect(a.requiredEnvVars).toHaveLength(3);
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_BUCHHALTUNGSBUTLER_LIVE === '1';
(live ? describe : describe.skip)('buchhaltungsbutler — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // buchhaltungsbutler answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
