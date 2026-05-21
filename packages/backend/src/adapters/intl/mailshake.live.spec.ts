import * as adapter from './mailshake.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('mailshake adapter — static spec conformance', () => {
  it('api.mailshake.com/2017-04-01', () => expect(a.connector.baseUrl).toBe('https://api.mailshake.com/2017-04-01'));
  it('Basic auth with key as user', () => {
    expect(a.connector.authConfig.username).toBe('{{MAILSHAKE_API_KEY}}');
    expect(a.connector.authConfig.password).toBe('');
  });
});
