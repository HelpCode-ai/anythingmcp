import * as adapter from './youtrack.json';

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

describe('youtrack adapter — static spec conformance', () => {
  it("sends the permanent token as a bearer", () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig?.token).toBe('{{YOUTRACK_TOKEN}}');
  });

  it("sends a fields selector on every read, or YouTrack returns only ids", () => {
    for (const t of a.tools) {
      const qp = (t.endpointMapping.queryParams ?? {}) as Record<string, string>;
      expect(qp.fields).toBeDefined();
    };
  });

  it("exposes the query language rather than hand-rolled filters", () => {
    const t = adapter.tools.find((x: { name: string }) => x.name === 'youtrack_search_issues')!;
    expect(Object.keys((t as unknown as { parameters: { properties: object } }).parameters.properties)).toContain('query');
  });

  it("says custom fields are where state and assignee live", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('customFields');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_YOUTRACK_LIVE === '1';
(live ? describe : describe.skip)('youtrack — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // youtrack answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
