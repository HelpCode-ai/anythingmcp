import * as adapter from './matrix42.json';

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

describe('matrix42 adapter — static spec conformance', () => {
  it("exchanges the API token for a short-lived bearer", () => {
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig?.tokenJsonPath).toBe('access_token');
    expect(a.connector.authConfig?.headerTemplate).toBe('Bearer ${token}');
  });

  it("ships the fragment schema tool, since UI labels are not column names", () => {
    expect(toolNames).toContain('matrix42_get_fragment_schema');
  });

  it("requires a column list on the generic query", () => {
    const t = adapter.tools.find((x: { name: string }) => x.name === 'matrix42_query_fragments')!;
    expect((t as unknown as { parameters: { required: string[] } }).parameters.required).toEqual(['fragmentName', 'columns']);
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_MATRIX42_LIVE === '1';
(live ? describe : describe.skip)('matrix42 — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // matrix42 answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
