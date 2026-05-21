import * as adapter from './adyen.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('adyen adapter — static spec conformance', () => {
  it('test base URL by default', () => expect(a.connector.baseUrl).toBe('https://checkout-test.adyen.com/v71'));
  it('X-API-Key header', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('X-API-Key');
  });
});
