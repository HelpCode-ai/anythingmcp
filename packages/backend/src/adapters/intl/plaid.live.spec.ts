import * as adapter from './plaid.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string };
  tools: Array<{ endpointMapping: { bodyMapping?: Record<string, unknown> } }>;
};
describe('plaid adapter — static spec conformance', () => {
  it('sandbox.plaid.com base URL (safe default)', () =>
    expect(a.connector.baseUrl).toBe('https://sandbox.plaid.com'));
  it('every tool injects client_id + secret into the body', () => {
    for (const t of a.tools) {
      const body = t.endpointMapping.bodyMapping ?? {};
      expect(body.client_id).toBe('$PLAID_CLIENT_ID');
      expect(body.secret).toBe('$PLAID_SECRET');
    }
  });
});
