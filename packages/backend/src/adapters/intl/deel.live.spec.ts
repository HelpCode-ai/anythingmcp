import * as adapter from './deel.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('deel adapter — static spec conformance', () => {
  it('api.letsdeel.com/rest/v2 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.letsdeel.com/rest/v2'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
