import * as adapter from './trello.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
};
describe('trello adapter — static spec conformance', () => {
  it('api.trello.com/1', () => expect(a.connector.baseUrl).toBe('https://api.trello.com/1'));
  it('QUERY_AUTH with key + token', () => {
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig.key).toBe('{{TRELLO_API_KEY}}');
    expect(a.connector.authConfig.token).toBe('{{TRELLO_TOKEN}}');
  });
});
