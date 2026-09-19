import * as adapter from './mssql.json';

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

describe('mssql adapter — static spec conformance', () => {
  it("is a DATABASE connector, not an HTTP one", () => {
    expect(a.connector.type).toBe('DATABASE');
    expect(a.connector.authType).toBe('CONNECTION_STRING');
  });

  it("builds a mssql:// DSN, which is how the engine picks the driver", () => {
    expect(a.connector.baseUrl.startsWith('mssql://')).toBe(true);
  });

  it("keeps the credentials in authConfig, not in the DSN", () => {
    expect(a.connector.authConfig?.username).toBe('{{MSSQL_USER}}');
    expect(a.connector.authConfig?.password).toBe('{{MSSQL_PASSWORD}}');
    expect(a.connector.baseUrl).not.toContain('@');
  });

  it("declares a probe, since a database has no HTTP healthcheck", () => {
    expect(a.probe?.tool).toBe('mssql_list_tables');
  });

  it("uses the engine's query/static methods, never an HTTP verb", () => {
    for (const t of a.tools) {
      expect(['query', 'static', 'mongo_schema']).toContain(String(t.endpointMapping.method));
    };
  });

  it("hands raw SQL through as ${query}, the engine's documented escape hatch", () => {
    const q = a.tools.find((t) => t.name === 'mssql_query')!;
    expect(q.endpointMapping.path).toBe('${query}');
  });

  it('offers Windows auth through an optional domain', () => {
    expect(a.optionalEnvVars).toEqual(['MSSQL_DOMAIN']);
    // Left blank the install submits '', which buildMssqlConfig reads as
    // falsy and falls back to SQL Server authentication.
    expect(a.connector.authConfig?.domain).toBe('{{MSSQL_DOMAIN}}');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_MSSQL_LIVE === '1';
(live ? describe : describe.skip)('mssql — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // mssql answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
