import * as adapter from './coda.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
};
describe('coda adapter — static spec conformance', () => {
  it('coda.io/apis/v1', () => expect(a.connector.baseUrl).toBe('https://coda.io/apis/v1'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
