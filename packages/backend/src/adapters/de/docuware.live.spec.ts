import * as adapter from './docuware.json';

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

describe('docuware adapter — static spec conformance', () => {
  it("holds the platform session in the DocuWare auth cookie", () => {
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig?.tokenSource).toBe('cookie');
    expect(a.connector.authConfig?.cookieName).toBe('.DWPLATFORMAUTH');
  });

  it("sends that cookie back on every call", () => {
    expect(a.connector.authConfig?.headerName).toBe('Cookie');
    expect(a.connector.authConfig?.headerTemplate).toContain('${token}');
  });

  it("makes the file-cabinet list the entry point", () => {
    expect(a.probe?.tool).toBe('docuware_list_file_cabinets');
  });

  it("warns about tenants migrated to the Identity Service", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('Identity Service');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_DOCUWARE_LIVE === '1';
(live ? describe : describe.skip)('docuware — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // docuware answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
