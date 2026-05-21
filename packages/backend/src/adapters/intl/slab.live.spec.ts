import * as adapter from './slab.json';
const a = adapter as unknown as { connector: { baseUrl: string; type: string; authType: string } };
describe('slab adapter — static spec conformance', () => {
  it('GraphQL endpoint', () => {
    expect(a.connector.type).toBe('GRAPHQL');
    expect(a.connector.baseUrl).toBe('https://api.slab.com/v1/graphql');
  });
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
