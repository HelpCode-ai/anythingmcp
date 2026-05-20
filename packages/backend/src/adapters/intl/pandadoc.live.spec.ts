import * as adapter from './pandadoc.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('pandadoc adapter — static spec conformance', () => {
  it('api.pandadoc.com/public/v1', () => expect(a.connector.baseUrl).toBe('https://api.pandadoc.com/public/v1'));
  it('API-Key prefix (NOT Bearer)', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('Authorization');
    expect(a.connector.authConfig.apiKey).toBe('API-Key {{PANDADOC_API_KEY}}');
  });
});
