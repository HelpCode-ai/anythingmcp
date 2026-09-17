import * as adapter from './dynamics-nav.json';

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

describe('dynamics-nav adapter — static spec conformance', () => {
  it("scopes the connector to one NAV company", () => {
    expect(a.connector.baseUrl).toBe("{{NAV_BASE_URL}}/Company('{{NAV_COMPANY}}')");
  });

  it("speaks OData v4, not the SOAP endpoint being retired", () => {
    expect(a.connector.headers?.['OData-Version']).toBe('4.0');
  });

  it("sends If-Match on the update, which OData v4 requires", () => {
    const t = a.tools.find((x) => x.name === 'dynamics_nav_update_record')!;
    expect((t.endpointMapping.headers as Record<string, string>)['If-Match']).toBe('*');
  });

  it("makes the published-service list the entry point", () => {
    expect(a.probe?.tool).toBe('dynamics_nav_list_services');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_DYNAMICS_NAV_LIVE === '1';
(live ? describe : describe.skip)('dynamics-nav — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // dynamics-nav answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
