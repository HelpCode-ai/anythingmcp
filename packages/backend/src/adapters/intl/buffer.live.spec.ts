import * as adapter from './buffer.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; type: string; authType: string };
};
describe('buffer adapter — static spec conformance', () => {
  // Was graphql.buffer.com, which has no DNS record at all — every call died
  // in the SSRF guard with "cannot resolve 'graphql.buffer.com'". This test
  // pinned the broken value, so it passed throughout. api.buffer.com/graphql
  // answers with a well-formed GraphQL auth error, which is the shape the
  // other GraphQL adapters point at.
  it('api.buffer.com/graphql base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.buffer.com/graphql'));
  it('GraphQL connector with Bearer auth', () => {
    expect(a.connector.type).toBe('GRAPHQL');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
  });
});
