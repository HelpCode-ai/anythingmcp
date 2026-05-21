import * as adapter from './ghost.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('ghost adapter — static spec conformance', () => {
  it('per-site base URL', () => expect(a.connector.baseUrl).toBe('{{GHOST_ADMIN_API_URL}}'));
  it('Ghost auth prefix (NOT Bearer) with JWT', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.apiKey).toBe('Ghost {{GHOST_ADMIN_JWT}}');
  });
});
