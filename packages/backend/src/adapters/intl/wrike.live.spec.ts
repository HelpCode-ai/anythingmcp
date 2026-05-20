import * as adapter from './wrike.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('wrike adapter — static spec conformance', () => {
  it('www.wrike.com/api/v4 base URL (US default)', () =>
    expect(a.connector.baseUrl).toBe('https://www.wrike.com/api/v4'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
