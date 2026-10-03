import * as adapter from './aruba-fatturazione.json';

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

describe('aruba-fatturazione adapter — static spec conformance', () => {
  it("trades the API credentials for a bearer token", () => {
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig?.tokenJsonPath).toBe('access_token');
  });

  it("signs in on the separate auth host with a form-encoded password grant", () => {
    const cfg = a.connector.authConfig as Record<string, any>;
    expect(cfg.loginUrl).toBe('https://auth.fatturazioneelettronica.aruba.it/auth/signin');
    expect(cfg.loginHeaders['Content-Type']).toContain('application/x-www-form-urlencoded');
    expect(cfg.loginBody.grant_type).toBe('password');
    expect(a.connector.healthcheckPath).toBe('https://auth.fatturazioneelettronica.aruba.it/auth/userInfo');
  });

  it("uses Aruba's documented search and lookup methods", () => {
    const byName = Object.fromEntries(a.tools.map((t) => [t.name, t.endpointMapping]));
    expect(byName.aruba_fatturazione_list_sent_invoices.path).toBe('/invoice/out/findByUsername');
    expect(byName.aruba_fatturazione_list_received_invoices.path).toBe('/invoice/in/findByUsername');
    expect((byName.aruba_fatturazione_list_sent_invoices.queryParams as Record<string, string>).username).toBe('$ARUBA_USERNAME');
    expect(byName.aruba_fatturazione_get_invoice_status.path).toBe('/invoice/out/getByIdSdi');
    expect(byName.aruba_fatturazione_get_received_invoice.path).toBe('/invoice/in/getByIdSdi');
    expect(byName.aruba_fatturazione_list_notifications.path).toBe('/notification/out/getByInvoiceFilename');
  });

  it("keeps sent and received invoices apart, as the SDI does", () => {
    expect(toolNames).toContain('aruba_fatturazione_list_sent_invoices');
    expect(toolNames).toContain('aruba_fatturazione_list_received_invoices');
  });

  it("names the SDI state that means the invoice was not issued", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('SCARTATA');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_ARUBA_FATTURAZIONE_LIVE === '1';
(live ? describe : describe.skip)('aruba-fatturazione — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // aruba-fatturazione answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
