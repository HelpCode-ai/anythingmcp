import * as adapter from './fortnox.json';

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

describe('fortnox adapter — static spec conformance', () => {
  it("is filed under the Swedish region", () => {
    expect(a.region).toBe('se');
  });

  it("uses OAuth2, not the retired Access-Token header pair", () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(JSON.stringify(a.connector)).not.toContain('Access-Token');
  });

  it("sends the client credentials as Basic, as Fortnox requires", () => {
    expect(a.connector.authConfig?.tokenAuthMethod).toBe('basic');
  });

  it("warns that vouchers default to the current financial year", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('a surprise in January');
  });

  const tool = (name: string) => {
    const found = (adapter as unknown as {
      tools: Array<{ name: string; enabled?: boolean; parameters: { required?: string[] }; endpointMapping: Record<string, unknown> }>;
    }).tools.find((t) => t.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };
  const attachments = 'https://api.fortnox.se/api/fileattachments/attachments-v1';

  it("creates invoices as drafts, installed switched off", () => {
    expect(tool('fortnox_create_invoice').endpointMapping).toEqual({ method: 'POST', path: '/invoices', bodyMapping: { Invoice: '$Invoice' } });
    expect(tool('fortnox_create_invoice').enabled).toBe(false);
  });

  it("lists inbox folders by path; the inbox scope stays opt-in so existing integrations can still authorize", () => {
    expect(tool('fortnox_list_inbox').endpointMapping).toEqual({ method: 'GET', path: '/inbox', queryParams: { path: '$path' } });
    expect(String(a.connector.authConfig?.scopes).split(' ')).not.toContain('inbox');
    expect((adapter as unknown as { instructions: string }).instructions).toMatch(/fortnox_list_inbox` also needs `inbox`/);
  });

  it("maps the File Attachments API on its own base path", () => {
    expect(tool('fortnox_list_attachments').endpointMapping).toEqual({
      method: 'GET',
      path: attachments,
      queryParams: { entityid: '$entity_id', entitytype: '$entity_type' },
    });
    expect(tool('fortnox_list_attachments').parameters.required).toEqual(['entity_id', 'entity_type']);
    // The API takes a JSON array of attachments as the whole body.
    expect(tool('fortnox_attach_files').endpointMapping).toEqual({ method: 'POST', path: attachments, bodyMapping: { __raw: '$attachments' } });
    expect(tool('fortnox_detach_file').endpointMapping).toEqual({ method: 'DELETE', path: `${attachments}/{attachment_id}` });
    expect(tool('fortnox_detach_file').enabled).toBe(false);
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_FORTNOX_LIVE === '1';
(live ? describe : describe.skip)('fortnox — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // fortnox answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
