import * as adapter from './etsy.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: any } };
describe('etsy adapter — static spec conformance', () => {
  it('openapi.etsy.com/v3/application', () => expect(a.connector.baseUrl).toBe('https://openapi.etsy.com/v3/application'));
  it('x-api-key header + extraHeaders for Bearer', () => {
    expect(a.connector.authConfig.headerName).toBe('x-api-key');
    expect(a.connector.authConfig.extraHeaders.Authorization).toBe('Bearer {{ETSY_ACCESS_TOKEN}}');
  });
});
