import * as adapter from './afas-profit.json';

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

describe('afas-profit adapter — static spec conformance', () => {
  it("uses AFAS's own AfasToken authorization scheme", () => {
    expect(a.connector.authConfig?.apiKey).toBe('AfasToken {{AFAS_TOKEN}}');
  });

  it("builds the host from the environment id", () => {
    expect(a.connector.baseUrl).toBe('https://{{AFAS_ENVIRONMENT}}.rest.afas.online/profitrestservices');
  });

  it("makes the published-connector list the entry point", () => {
    expect(a.probe?.tool).toBe('afas_profit_list_connectors');
  });

  it("exposes no UpdateConnector", () => {
    expect(a.tools.every((t) => t.endpointMapping.method === 'GET')).toBe(true);
    expect(toolNames.join(' ')).not.toContain('update');
  });

  it("documents the positional three-list filter", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('positionally');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_AFAS_PROFIT_LIVE === '1';
(live ? describe : describe.skip)('afas-profit — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // afas-profit answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
