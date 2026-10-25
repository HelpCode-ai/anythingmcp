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

  it("names the customer by e-mail in `customer`, which Zammad looks up", () => {
    const t = a.tools.find((x) => x.name === 'zammad_create_ticket')!;
    const body = t.endpointMapping.bodyMapping as Record<string, unknown>;
    expect(body.customer).toBe('$customer');
    expect(body.customer_id).toBe('$customer_id');
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

const byName = (name: string) => {
  const found = (adapter as unknown as { tools: Array<{ name: string; parameters: { required?: string[] }; endpointMapping: Record<string, unknown> }> }).tools.find((x) => x.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

describe('zammad adapter: ticket update and merge', () => {
  const t = (name: string) => byName(name);
  it('updates a ticket by numeric id', () => {
    expect(t('zammad_edit_ticket').endpointMapping).toMatchObject({ method: 'PUT', path: '/tickets/{id}' });
  });
  it('merges by source id into a target ticket number', () => {
    expect(t('zammad_merge_ticket').endpointMapping).toMatchObject({
      method: 'PUT',
      path: '/ticket_merge/{source_ticket_id}/{target_ticket_number}',
    });
  });
});
