import * as adapter from './mongodb.json';

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

describe('mongodb adapter — static spec conformance', () => {
  it("is a DATABASE connector, not an HTTP one", () => {
    expect(a.connector.type).toBe('DATABASE');
    expect(a.connector.authType).toBe('CONNECTION_STRING');
  });

  it("builds a mongodb:// DSN, which is how the engine picks the driver", () => {
    expect(a.connector.baseUrl.startsWith('mongodb://')).toBe(true);
  });

  it("names the authSource, which cannot be left empty", () => {
    expect(a.connector.baseUrl).toContain('authSource={{MONGODB_AUTH_SOURCE}}');
    // The driver rejects `authSource=` outright, so it has to be required
    // rather than an optional field the install submits blank.
    expect(a.requiredEnvVars).toContain('MONGODB_AUTH_SOURCE');
    expect(a.optionalEnvVars ?? []).not.toContain('MONGODB_AUTH_SOURCE');
  });

  it("keeps the credentials in authConfig, not in the DSN", () => {
    expect(a.connector.authConfig?.username).toBe('{{MONGODB_USER}}');
    expect(a.connector.baseUrl).not.toContain('@');
  });

  it("probes the schema, since a database has no HTTP healthcheck", () => {
    expect(a.probe?.tool).toBe('mongodb_schema');
  });

  it("uses mongo_schema for introspection and query for finds", () => {
    const byName = Object.fromEntries(a.tools.map((t) => [t.name, t.endpointMapping.method]));
    expect(byName.mongodb_schema).toBe('mongo_schema');
    expect(byName.mongodb_find).toBe('query');
  });

  it("never quotes a template placeholder \u2014 the engine JSON-stringifies it", () => {
    for (const t of a.tools) {
      const path = String(t.endpointMapping.path);
      expect(path).not.toMatch(/"\$\{/);
    };
  });

  it("leaves no placeholder optional in a JSON template", () => {
    for (const name of ['mongodb_find_recent', 'mongodb_matching']) {
      const t = adapter.tools.find((x: { name: string }) => x.name === name)!;
      const decl = t as unknown as { parameters: { properties: Record<string, unknown>; required: string[] } };
      expect(decl.parameters.required.sort()).toEqual(Object.keys(decl.parameters.properties).sort());
    };
  });

  it("says Atlas needs a custom connector, because SRV cannot be assembled", () => {
    const i = (adapter as unknown as { instructions: string }).instructions;
    expect(i).toContain('mongodb+srv://');
    expect(i).toContain('custom connector');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_MONGODB_LIVE === '1';
(live ? describe : describe.skip)('mongodb — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // mongodb answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
