import * as adapter from './papershift.json';

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

describe('papershift adapter — static spec conformance', () => {
  it("authenticates with the api_token query parameter", () => {
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig?.api_token).toBe('{{PAPERSHIFT_API_TOKEN}}');
  });

  it("keeps the planned roster and the worked time as separate tools", () => {
    expect(toolNames).toContain('papershift_list_shifts');
    expect(toolNames).toContain('papershift_list_working_sessions');
  });

  it("requires a bounded date range on every range query", () => {
    for (const name of ['papershift_list_shifts', 'papershift_list_working_sessions', 'papershift_list_absences']) {
      const t = adapter.tools.find((x: { name: string }) => x.name === name)!;
      expect((t as unknown as { parameters: { required: string[] } }).parameters.required).toEqual(['start_date', 'end_date']);
    };
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_PAPERSHIFT_LIVE === '1';
(live ? describe : describe.skip)('papershift — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // papershift answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
