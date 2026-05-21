import * as adapter from './fillout.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('fillout adapter — static spec conformance', () => {
  it('api.fillout.com/v1/api', () => expect(a.connector.baseUrl).toBe('https://api.fillout.com/v1/api'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
