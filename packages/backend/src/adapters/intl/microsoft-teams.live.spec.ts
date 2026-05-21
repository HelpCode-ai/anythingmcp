import * as adapter from './microsoft-teams.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('microsoft-teams adapter — static spec conformance', () => {
  it('graph.microsoft.com/v1.0', () => expect(a.connector.baseUrl).toBe('https://graph.microsoft.com/v1.0'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
