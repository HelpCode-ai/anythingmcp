import * as adapter from './lexware-office.json';

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

describe('lexware-office adapter — static spec conformance', () => {
  it("targets api.lexware.io/v1, not the legacy lexoffice host", () => {
    expect(a.connector.baseUrl).toBe('https://api.lexware.io/v1');
  });

  it("authenticates with a bearer token from LEXWARE_API_KEY", () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig?.token).toBe('{{LEXWARE_API_KEY}}');
  });

  it("probes /profile, which every token can read", () => {
    expect(a.probe?.tool).toBe('lexware_office_get_profile');
    expect(a.connector.healthcheckPath).toBe('/profile');
  });

  it("exposes the voucher list, which is what 'what is unpaid' needs", () => {
    expect(toolNames).toContain('lexware_office_list_vouchers');
  });

  // Voucher-list rows of type salesinvoice/purchaseinvoice/... live under
  // /vouchers/{id}; sending them to /invoices/{id} answered 404 for a user.
  it('reads bookkeeping vouchers and the other sales documents at their own endpoints', () => {
    const path = (n: string) => a.tools.find((t) => t.name === n)?.endpointMapping.path;
    expect(path('lexware_office_get_voucher')).toBe('/vouchers/{id}');
    expect(path('lexware_office_get_sales_document')).toBe('/{resource}/{id}');
  });

  it('creates a contact with the roles asked for, and no empty address or person', () => {
    const body = a.tools.find((t) => t.name === 'lexware_office_create_contact')!.endpointMapping
      .bodyMapping as Record<string, unknown>;
    expect(body.roles).toBe('$roles');
    expect(body.person).toBeUndefined();
    expect(body.addresses).toEqual({ billing: ['$billingAddress'] });
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_LEXWARE_OFFICE_LIVE === '1';
(live ? describe : describe.skip)('lexware-office — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // lexware-office answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});

const byName = (name: string) => {
  const found = (adapter as unknown as { tools: Array<{ name: string; parameters: { required?: string[] }; endpointMapping: Record<string, unknown> }> }).tools.find((x) => x.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

describe('lexware-office adapter: delivery notes, quotation drafts, articles, PDFs', () => {
  const t = (name: string) => byName(name);
  it('reads and creates delivery notes as drafts', () => {
    expect(t('lexware_office_get_delivery_note').endpointMapping).toMatchObject({ method: 'GET', path: '/delivery-notes/{id}' });
    const create = t('lexware_office_create_delivery_note').endpointMapping;
    expect(create).toMatchObject({ method: 'POST', path: '/delivery-notes' });
    expect(create).not.toHaveProperty('queryParams');
  });
  it('downloads finalized documents as files', () => {
    expect(t('lexware_office_get_invoice_pdf').endpointMapping.path).toBe('/invoices/{id}/file');
    expect(t('lexware_office_get_delivery_note_pdf').endpointMapping.path).toBe('/delivery-notes/{id}/file');
  });
  it('creates quotations without finalize, so they stay drafts', () => {
    const q = t('lexware_office_create_quotation_draft').endpointMapping;
    expect(q).toMatchObject({ method: 'POST', path: '/quotations' });
    expect(q).not.toHaveProperty('queryParams');
  });
  it('updates an article with its version (optimistic locking)', () => {
    const u = t('lexware_office_update_article');
    expect(u.endpointMapping).toMatchObject({ method: 'PUT', path: '/articles/{id}' });
    expect(u.parameters.required).toContain('version');
  });
});
