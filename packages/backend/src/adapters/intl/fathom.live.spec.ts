import * as adapter from './fathom.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('fathom adapter — static spec conformance', () => {
  it('api.usefathom.com/v1', () => expect(a.connector.baseUrl).toBe('https://api.usefathom.com/v1'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
