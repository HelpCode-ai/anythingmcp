import * as adapter from './medium.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('medium adapter — static spec conformance', () => {
  it('api.medium.com/v1', () => expect(a.connector.baseUrl).toBe('https://api.medium.com/v1'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
