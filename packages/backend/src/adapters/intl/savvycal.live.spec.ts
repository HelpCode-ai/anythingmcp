import * as adapter from './savvycal.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('savvycal adapter — static spec conformance', () => {
  it('api.savvycal.com/v1', () => expect(a.connector.baseUrl).toBe('https://api.savvycal.com/v1'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
