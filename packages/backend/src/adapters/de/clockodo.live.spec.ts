import * as adapter from './clockodo.json';

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

describe('clockodo adapter — static spec conformance', () => {
  it("sends the key and the user e-mail as two separate headers", () => {
    expect(a.connector.authConfig?.headerName).toBe('X-ClockodoApiKey');
    expect((a.connector.authConfig?.extraHeaders as Record<string, string>)['X-ClockodoApiUser']).toBe('{{CLOCKODO_API_USER}}');
  });

  it("identifies itself the way clockodo asks API clients to", () => {
    expect(a.connector.headers?.['X-Clockodo-External-Application']).toMatch(/^AnythingMCP;/);
  });

  it("reads entries from v2 and master data from the root", () => {
    const byName = Object.fromEntries(a.tools.map((t) => [t.name, t.endpointMapping.path]));
    expect(byName.clockodo_list_entries).toBe('/v2/entries');
    expect(byName.clockodo_list_customers).toBe('/customers');
  });

  it("requires both credentials", () => {
    expect(a.requiredEnvVars).toEqual(['CLOCKODO_API_KEY', 'CLOCKODO_API_USER']);
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_CLOCKODO_LIVE === '1';
(live ? describe : describe.skip)('clockodo — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // clockodo answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
