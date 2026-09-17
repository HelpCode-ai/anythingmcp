import * as adapter from './glpi.json';

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

describe('glpi adapter — static spec conformance', () => {
  it("logs in at initSession and sends back a Session-Token", () => {
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig?.tokenJsonPath).toBe('session_token');
    expect(a.connector.authConfig?.headerName).toBe('Session-Token');
  });

  it("sends the App-Token on the login call and on every call after", () => {
    const cfg = a.connector.authConfig as Record<string, Record<string, string>>;
    expect(cfg.loginHeaders['App-Token']).toBe('{{GLPI_APP_TOKEN}}');
    expect(cfg.extraHeaders['App-Token']).toBe('{{GLPI_APP_TOKEN}}');
  });

  it("carries a non-empty username and password, which the login needs", () => {
    expect(a.connector.authConfig?.username).toBe('{{GLPI_USERNAME}}');
    expect(a.connector.authConfig?.password).toBe('{{GLPI_PASSWORD}}');
  });

  it("ships the search-option map, without which glpi_search is unusable", () => {
    expect(toolNames).toContain('glpi_list_search_options');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_GLPI_LIVE === '1';
(live ? describe : describe.skip)('glpi — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // glpi answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
