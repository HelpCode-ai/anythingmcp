import * as adapter from './activecampaign.json';

const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Array<{ name: string; endpointMapping: { method: string; path: string } }>;
};

describe('activecampaign adapter — static spec conformance', () => {
  it('uses account-templated base URL', () => {
    expect(a.connector.baseUrl).toBe('{{ACTIVECAMPAIGN_API_URL}}/api/3');
  });
  it('uses Api-Token header (not Bearer)', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('Api-Token');
    expect(a.connector.authConfig.apiKey).toBe('{{ACTIVECAMPAIGN_API_KEY}}');
  });
  it('sync-contact uses POST /contact/sync (singular path) — ActiveCampaign-specific upsert', () => {
    const t = a.tools.find((x) => x.name === 'activecampaign_sync_contact')!;
    expect(t.endpointMapping.method).toBe('POST');
    expect(t.endpointMapping.path).toBe('/contact/sync');
  });
});
