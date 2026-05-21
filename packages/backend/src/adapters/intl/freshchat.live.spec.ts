import * as adapter from './freshchat.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('freshchat adapter — static spec conformance', () => {
  it('api.freshchat.com/v2 base URL (US region default)', () =>
    expect(a.connector.baseUrl).toBe('https://api.freshchat.com/v2'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
