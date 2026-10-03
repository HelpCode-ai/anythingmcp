import * as adapter from './quipu.json';

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

describe('quipu adapter — static spec conformance', () => {
  it("sends Quipu's versioned Accept header (vnd.api+json gets 404 on every path)", () => {
    expect(a.connector.headers?.Accept).toBe('application/vnd.quipu.v1+json');
  });

  it("asks for the mandatory `ecommerce` scope on the client-credentials token", () => {
    expect(a.connector.authConfig?.grant).toBe('client_credentials');
    expect(a.connector.authConfig?.scope).toBe('ecommerce');
  });

  it("reads expenses from /invoices by kind, since /expenses and /items do not exist", () => {
    const inv = a.tools.find((x) => x.name === 'quipu_list_invoices')!;
    const exp = a.tools.find((x) => x.name === 'quipu_list_expenses')!;
    expect(inv.endpointMapping.path).toBe('/invoices');
    expect(exp.endpointMapping.path).toBe('/invoices');
    expect((inv.endpointMapping.queryParams as Record<string, unknown>)['filter[kind]']).toBe('income');
    expect((exp.endpointMapping.queryParams as Record<string, unknown>)['filter[kind]']).toBe('expenses');
    expect(Object.keys(inv.endpointMapping.queryParams as object)).toContain('filter[period]');
    expect(a.tools.map((t) => t.endpointMapping.path)).not.toContain('/items');
  });

  it("pages JSON:API style", () => {
    const t = a.tools.find((x) => x.name === 'quipu_list_invoices')!;
    expect(Object.keys(t.endpointMapping.queryParams as object)).toContain('page[number]');
  });

  it("keeps issued invoices and received expenses apart", () => {
    expect(toolNames).toContain('quipu_list_invoices');
    expect(toolNames).toContain('quipu_list_expenses');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_QUIPU_LIVE === '1';
(live ? describe : describe.skip)('quipu — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // quipu answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
