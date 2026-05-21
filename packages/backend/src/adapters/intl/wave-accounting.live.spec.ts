import * as adapter from './wave-accounting.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; type: string; authType: string };
};
describe('wave-accounting adapter — static spec conformance', () => {
  it('gql.waveapps.com/graphql/public base URL', () =>
    expect(a.connector.baseUrl).toBe('https://gql.waveapps.com/graphql/public'));
  it('GraphQL connector with Bearer auth', () => {
    expect(a.connector.type).toBe('GRAPHQL');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
  });
});
