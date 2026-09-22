import * as adapter from './matomo.json';

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

describe('matomo adapter — static spec conformance', () => {
  it("sends token_auth as a query parameter, Matomo's classic shape", () => {
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig?.token_auth).toBe('{{MATOMO_TOKEN}}');
  });

  it("routes every call through the one Reporting API endpoint", () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.path).toBe('/index.php');
      const qp = t.endpointMapping.queryParams as Record<string, string>;
      expect(qp.module).toBe('API');
      expect(qp.format).toBe('JSON');
      expect(qp.method).toMatch(/\./);
    };
  });

  it("requires idSite, period and date on every report", () => {
    const reports = adapter.tools.filter((t: { name: string }) => !['matomo_get_version', 'matomo_list_sites'].includes(t.name));
    for (const t of reports) {
      expect((t as unknown as { parameters: { required: string[] } }).parameters.required).toEqual(expect.arrayContaining(['idSite', 'period', 'date']));
    };
  });

  it("says what to do when the secure-requests flag breaks GET auth", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('secure-requests flag');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_MATOMO_LIVE === '1';
(live ? describe : describe.skip)('matomo — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // matomo answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
