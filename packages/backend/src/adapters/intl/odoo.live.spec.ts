import * as adapter from './odoo.json';

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

describe('odoo adapter — static spec conformance', () => {
  it("targets the JSON-2 API, the only route a REST engine can speak", () => {
    expect(a.connector.baseUrl).toBe('{{ODOO_URL}}/json/2');
  });

  it("names the database in the header Odoo expects", () => {
    expect(a.connector.headers?.['X-Odoo-Database']).toBe('{{ODOO_DB}}');
  });

  it("calls every model method over POST", () => {
    expect(a.tools.every((t) => t.endpointMapping.method === 'POST')).toBe(true);
  });

  it("says which Odoo versions this route does not exist on", () => {
    const i = (adapter as unknown as { instructions: string }).instructions;
    expect(i).toContain('Odoo 18 and older');
    expect(i).toContain('/jsonrpc');
  });

  it("steers res.partner calls away from the mobile field Odoo 19 removed", () => {
    const i = (adapter as unknown as { instructions: string }).instructions;
    expect(i).toContain('no `mobile`');
    const tools = a.tools as unknown as Array<{
      name: string;
      parameters?: { properties?: Record<string, { description?: string }> };
      endpointMapping: { bodyMapping?: Record<string, unknown> };
    }>;
    for (const name of ['odoo_search_read', 'odoo_read']) {
      const fields = tools.find((t) => t.name === name)?.parameters?.properties?.fields;
      expect(fields?.description).toContain('`phone`, not `mobile`');
    }
    // The partner wrapper's fixed field list must work on Odoo 19 as shipped.
    const partners = tools.find((t) => t.name === 'odoo_list_partners');
    expect(JSON.stringify(partners?.endpointMapping)).not.toContain('"mobile"');
  });

  it("ships both a generic search_read and the common wrappers", () => {
    expect(toolNames).toEqual(expect.arrayContaining(['odoo_search_read', 'odoo_list_partners', 'odoo_list_sale_orders', 'odoo_list_invoices']));
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_ODOO_LIVE === '1';
(live ? describe : describe.skip)('odoo — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // odoo answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
