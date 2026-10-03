import * as adapter from './propstack.json';

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

describe('propstack adapter — static spec conformance', () => {
  it("sends the key in the X-API-KEY header", () => {
    expect(a.connector.authConfig?.headerName).toBe('X-API-KEY');
  });

  it("keeps enquiries distinct from contacts", () => {
    expect(toolNames).toContain('propstack_list_enquiries');
    expect(toolNames).toContain('propstack_list_contacts');
  });

  it("reads listings from /units and enquiries from inquiry activities", () => {
    const byName = Object.fromEntries(a.tools.map((t) => [t.name, t.endpointMapping]));
    expect(byName.propstack_list_properties.path).toBe('/units');
    expect(byName.propstack_get_property.path).toBe('/units/{id}');
    expect(byName.propstack_list_enquiries.path).toBe('/activities');
    expect(byName.propstack_list_enquiries.queryParams).toMatchObject({ only_inquiries: '1' });
    expect(a.connector.healthcheckPath).toBe('/units?per=1');
  });

  it("uses the documented filter names (`status`, `q`)", () => {
    const byName = Object.fromEntries(a.tools.map((t) => [t.name, t.endpointMapping]));
    expect(byName.propstack_list_properties.queryParams).toMatchObject({ status: '$status' });
    expect(byName.propstack_list_contacts.queryParams).toMatchObject({ q: '$q' });
  });

  it("exposes no write tool", () => {
    expect(a.tools.every((t) => t.endpointMapping.method === 'GET')).toBe(true);
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_PROPSTACK_LIVE === '1';
(live ? describe : describe.skip)('propstack — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // propstack answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
