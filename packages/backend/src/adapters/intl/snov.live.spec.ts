import * as adapter from './snov.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('snov adapter — static spec conformance', () => {
  it('api.snov.io/v1', () => expect(a.connector.baseUrl).toBe('https://api.snov.io/v1'));
  it('Bearer (OAuth2 client-credentials access token)', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
