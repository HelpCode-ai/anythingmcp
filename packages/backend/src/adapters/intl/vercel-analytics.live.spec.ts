import * as adapter from './vercel-analytics.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('vercel-analytics adapter — static spec conformance', () => {
  it('api.vercel.com', () => expect(a.connector.baseUrl).toBe('https://api.vercel.com'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
