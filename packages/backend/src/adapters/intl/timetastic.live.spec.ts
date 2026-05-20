import * as adapter from './timetastic.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('timetastic adapter — static spec conformance', () => {
  it('app.timetastic.co.uk/api base URL', () =>
    expect(a.connector.baseUrl).toBe('https://app.timetastic.co.uk/api'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
