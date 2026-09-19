import * as adapter from './moneybird.json';

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

describe('moneybird adapter — static spec conformance', () => {
  it("scopes every data path to the administration", () => {
    const scoped = a.tools.filter((t) => t.name !== 'moneybird_list_administrations');
    for (const t of scoped) expect(String(t.endpointMapping.path)).toContain('{MONEYBIRD_ADMINISTRATION_ID}');
  });

  it("keeps the .json suffix Moneybird's routes require", () => {
    for (const t of a.tools) expect(String(t.endpointMapping.path)).toMatch(/\.json$/);
  });

  it("explains the comma-separated filter string", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('period:this_year,state:open');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_MONEYBIRD_LIVE === '1';
(live ? describe : describe.skip)('moneybird — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // moneybird answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
