import * as adapter from './ticktick.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('ticktick adapter — static spec conformance', () => {
  it('api.ticktick.com/open/v1', () => expect(a.connector.baseUrl).toBe('https://api.ticktick.com/open/v1'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
