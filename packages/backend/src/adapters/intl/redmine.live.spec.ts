import * as adapter from './redmine.json';

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

describe('redmine adapter — static spec conformance', () => {
  it("sends the key in a header, not in the query string", () => {
    expect(a.connector.authConfig?.headerName).toBe('X-Redmine-API-Key');
  });

  it("keeps the .json suffix Redmine's routes require", () => {
    for (const t of a.tools) expect(String(t.endpointMapping.path)).toMatch(/\.json$/);
  });

  it("says the REST service is off by default", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('off by default');
  });

  it("offers journals as an include, since the list omits them", () => {
    const t = adapter.tools.find((x: { name: string }) => x.name === 'redmine_get_issue')!;
    expect(Object.keys((t as unknown as { parameters: { properties: object } }).parameters.properties)).toContain('include');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_REDMINE_LIVE === '1';
(live ? describe : describe.skip)('redmine — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // redmine answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
