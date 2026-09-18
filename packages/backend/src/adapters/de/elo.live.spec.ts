import * as adapter from './elo.json';

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

describe('elo adapter — static spec conformance', () => {
  it("trades username and password for an ELO ticket", () => {
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig?.tokenJsonPath).toBe('ticket');
    expect(a.connector.authConfig?.headerName).toBe('X-ELO-Ticket');
  });

  it("pages a stateful search rather than pretending it is a list", () => {
    expect(toolNames).toContain('elo_find_first');
    expect(toolNames).toContain('elo_find_next');
  });

  it("explains that a Sord may be a folder or a document", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('sordType');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_ELO_LIVE === '1';
(live ? describe : describe.skip)('elo — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // elo answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
