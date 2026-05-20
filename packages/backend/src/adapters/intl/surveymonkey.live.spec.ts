import * as adapter from './surveymonkey.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('surveymonkey adapter — static spec conformance', () => {
  it('api.surveymonkey.com/v3', () => expect(a.connector.baseUrl).toBe('https://api.surveymonkey.com/v3'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
