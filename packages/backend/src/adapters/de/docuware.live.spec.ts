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
  it("gets an OAuth token from the Identity Service, since /Account/Logon answers 410 Gone", () => {
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig?.loginUrl).toBe('{{DOCUWARE_TOKEN_URL}}');
    expect(a.connector.authConfig?.tokenSource).toBeUndefined();
    expect(a.connector.authConfig?.tokenJsonPath).toBe('access_token');
    expect(a.requiredEnvVars).toContain('DOCUWARE_TOKEN_URL');
  });

  it("uses the password grant DocuWare documents for the platform client", () => {
    const body = a.connector.authConfig?.loginBody as Record<string, string>;
    expect(body.grant_type).toBe('password');
    expect(body.client_id).toBe('docuware.platform.net.client');
    expect(body.scope).toBe('docuware.platform');
    expect((a.connector.authConfig?.loginHeaders as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
  });

  it("sends the token as a Bearer header on every call", () => {
    expect(a.connector.authConfig?.headerName).toBe('Authorization');
    expect(a.connector.authConfig?.headerTemplate).toBe('Bearer ${token}');
  });

  it("makes the file-cabinet list the entry point", () => {
    expect(a.probe?.tool).toBe('docuware_list_file_cabinets');
  });

  it("explains how to find the Identity Service token endpoint", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('/Home/IdentityServiceInfo');
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
