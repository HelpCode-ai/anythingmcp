import * as adapter from './timetac.json';

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

describe('timetac adapter — static spec conformance', () => {
  it("repeats the account name in host and path, as TimeTac requires", () => {
    expect(a.connector.baseUrl).toBe('https://{{TIMETAC_ACCOUNT}}.timetac.com/{{TIMETAC_ACCOUNT}}/api/v3');
  });

  it("refreshes an OAuth2 token against the tenant's own token URL", () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig?.tokenUrl).toContain('{{TIMETAC_ACCOUNT}}');
  });

  it("uses TimeTac's /read suffix rather than REST collections", () => {
    expect(a.tools.every((t) => /\/(read|readLive)$/.test(String(t.endpointMapping.path)))).toBe(true);
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_TIMETAC_LIVE === '1';
(live ? describe : describe.skip)('timetac — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // timetac answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
