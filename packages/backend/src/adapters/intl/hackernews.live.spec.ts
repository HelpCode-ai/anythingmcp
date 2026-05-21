import * as adapter from './hackernews.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('hackernews adapter — static spec conformance', () => {
  it('hacker-news.firebaseio.com/v0 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://hacker-news.firebaseio.com/v0'));
  it('no auth (public API)', () => expect(a.connector.authType).toBe('NONE'));
});
