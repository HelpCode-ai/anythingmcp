import * as adapter from './mintlify.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
};
describe('mintlify adapter — static spec conformance', () => {
  it('api.mintlify.com/v1', () => expect(a.connector.baseUrl).toBe('https://api.mintlify.com/v1'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
