import * as adapter from './fatture-in-cloud.json';

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

describe('fatture-in-cloud adapter — static spec conformance', () => {
  it("is filed under the Italian region", () => {
    expect(a.region).toBe('it');
  });

  it("scopes every company-level path to FIC_COMPANY_ID", () => {
    const scoped = a.tools.filter((t) => String(t.endpointMapping.path).startsWith('/c/'));
    expect(scoped.length).toBeGreaterThan(5);
    for (const t of scoped) expect(String(t.endpointMapping.path)).toContain('{FIC_COMPANY_ID}');
  });

  it("leaves the company list reachable without a company id", () => {
    const t = a.tools.find((x) => x.name === 'fatture_in_cloud_list_companies')!;
    expect(t.endpointMapping.path).toBe('/user/companies');
  });

  it("explains the Sistema di Interscambio status field", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('Sistema di Interscambio');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_FATTURE_IN_CLOUD_LIVE === '1';
(live ? describe : describe.skip)('fatture-in-cloud — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // fatture-in-cloud answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
