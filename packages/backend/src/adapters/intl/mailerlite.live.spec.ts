import * as adapter from './mailerlite.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('mailerlite adapter — static spec conformance', () => {
  it('connect.mailerlite.com/api base URL', () =>
    expect(a.connector.baseUrl).toBe('https://connect.mailerlite.com/api'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
