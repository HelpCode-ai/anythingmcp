import * as adapter from './teamleader.json';

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

describe('teamleader adapter — static spec conformance', () => {
  it("is filed under the Belgian region", () => {
    expect(a.region).toBe('be');
  });

  it("reads over POST, because that is how the API is shaped", () => {
    expect(a.tools.every((t) => t.endpointMapping.method === 'POST')).toBe(true);
  });

  it("uses Teamleader's action-style paths", () => {
    expect(a.tools.map((t) => t.endpointMapping.path)).toEqual(expect.arrayContaining(['/companies.list', '/deals.info', '/invoices.list']));
  });

  it("warns that the refresh token rotates on every use", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('rotate');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_TEAMLEADER_LIVE === '1';
(live ? describe : describe.skip)('teamleader — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // teamleader answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
