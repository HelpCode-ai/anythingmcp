import * as adapter from './todoist.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
};
describe('todoist adapter — static spec conformance', () => {
  it('api.todoist.com/api/v1 (rest/v2 is deprecated)', () => expect(a.connector.baseUrl).toBe('https://api.todoist.com/api/v1'));
  it('Bearer auth', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{TODOIST_API_TOKEN}}');
  });
});
