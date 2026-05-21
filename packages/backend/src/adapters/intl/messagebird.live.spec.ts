import * as adapter from './messagebird.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('messagebird adapter — static spec conformance', () => {
  it('rest.messagebird.com', () => expect(a.connector.baseUrl).toBe('https://rest.messagebird.com'));
  it('AccessKey prefix (NOT Bearer)', () => expect(a.connector.authConfig.apiKey).toBe('AccessKey {{MESSAGEBIRD_ACCESS_KEY}}'));
});
