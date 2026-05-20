import * as adapter from './buffer.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; type: string; authType: string };
};
describe('buffer adapter — static spec conformance', () => {
  it('graphql.buffer.com base URL', () =>
    expect(a.connector.baseUrl).toBe('https://graphql.buffer.com'));
  it('GraphQL connector with Bearer auth', () => {
    expect(a.connector.type).toBe('GRAPHQL');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
  });
});
