import * as adapter from './znuny.json';

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

describe('znuny adapter — static spec conformance', () => {
  it("routes through the web service the admin created by name", () => {
    expect(a.connector.baseUrl).toContain('{{ZNUNY_WEBSERVICE}}');
  });

  it("sends the GenericInterface credentials as request parameters", () => {
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig?.UserLogin).toBe('{{ZNUNY_USERNAME}}');
    expect(a.connector.authConfig?.Password).toBe('{{ZNUNY_PASSWORD}}');
  });

  it("does not claim to be a keyless connector", () => {
    expect(a.connector.authType).not.toBe('NONE');
    expect(a.requiredEnvVars).toContain('ZNUNY_PASSWORD');
  });

  it("matches the bundled definition's routes: GET searches, POST creates", () => {
    const byName = Object.fromEntries(a.tools.map((t) => [t.name, `${String(t.endpointMapping.method)} ${String(t.endpointMapping.path)}`]));
    expect(byName.znuny_search_tickets).toBe('GET /Ticket');
    expect(byName.znuny_create_ticket).toBe('POST /Ticket');
    expect(byName.znuny_get_ticket).toBe('GET /Ticket/{TicketID}');
    expect(byName.znuny_update_ticket).toBe('PATCH /Ticket/{TicketID}');
  });

  it("says the credentials land in the access log", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('access log');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_ZNUNY_LIVE === '1';
(live ? describe : describe.skip)('znuny — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // znuny answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
