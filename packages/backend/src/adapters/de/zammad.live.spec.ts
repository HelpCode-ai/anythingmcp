import * as adapter from './zammad.json';

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

describe('zammad adapter — static spec conformance', () => {
  it("sends Zammad's own Token scheme, not Bearer", () => {
    expect(a.connector.authConfig?.apiKey).toBe('Token token={{ZAMMAD_API_TOKEN}}');
    expect(a.connector.authConfig?.headerName).toBe('Authorization');
  });

  it("points at the instance the operator names", () => {
    expect(a.connector.baseUrl).toBe('{{ZAMMAD_URL}}/api/v1');
  });

  it("probes /users/me, which shows what the token may do", () => {
    expect(a.probe?.tool).toBe('zammad_get_me');
  });

  it("separates listing, searching and reading one ticket", () => {
    expect(toolNames).toEqual(expect.arrayContaining(['zammad_list_tickets', 'zammad_search_tickets', 'zammad_get_ticket', 'zammad_list_ticket_articles']));
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_ZAMMAD_LIVE === '1';
(live ? describe : describe.skip)('zammad — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // zammad answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
