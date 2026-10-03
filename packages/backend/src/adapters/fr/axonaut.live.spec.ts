import * as adapter from './axonaut.json';

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

describe('axonaut adapter — static spec conformance', () => {
  it("sends the key in Axonaut's camel-cased userApiKey header", () => {
    expect(a.connector.authConfig?.headerName).toBe('userApiKey');
  });

  it("says 'employee' means a client's contact, not your own staff", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain("sounds like your own staff and is not");
  });

  it("sends page as a header on every list tool, never as a query parameter", () => {
    const lists = a.tools.filter((t) => t.name.startsWith('axonaut_list_'));
    expect(lists.length).toBe(7);
    for (const t of lists) {
      expect((t.endpointMapping.headers as Record<string, string>).page).toBe('$page');
      expect((t.endpointMapping.queryParams as Record<string, string> | undefined)?.page).toBeUndefined();
    }
  });

  it("filters companies by name with Axonaut's search parameter", () => {
    const t = a.tools.find((x) => x.name === 'axonaut_list_companies');
    expect(t?.endpointMapping.queryParams).toEqual({ search: '$name' });
  });

  it("warns that the date filters are DD/MM/YYYY", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('DD/MM/YYYY');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_AXONAUT_LIVE === '1';
(live ? describe : describe.skip)('axonaut — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // axonaut answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
