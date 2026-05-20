import * as adapter from './gitbook.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('gitbook adapter — static spec conformance', () => {
  it('api.gitbook.com/v1', () => expect(a.connector.baseUrl).toBe('https://api.gitbook.com/v1'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
