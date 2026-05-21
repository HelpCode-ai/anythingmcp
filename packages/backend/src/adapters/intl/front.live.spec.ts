import * as adapter from './front.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('front adapter — static spec conformance', () => {
  it('api2.frontapp.com', () => expect(a.connector.baseUrl).toBe('https://api2.frontapp.com'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
