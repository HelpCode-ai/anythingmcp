import * as adapter from './reddit.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: any } };
describe('reddit adapter — static spec conformance', () => {
  it('oauth.reddit.com (NOT www.reddit.com)', () => expect(a.connector.baseUrl).toBe('https://oauth.reddit.com'));
  it('Bearer token + extraHeaders for User-Agent', () => {
    expect(a.connector.authConfig.apiKey).toBe('Bearer {{REDDIT_ACCESS_TOKEN}}');
    expect(a.connector.authConfig.extraHeaders['User-Agent']).toMatch(/AnythingMCP/);
  });
});
