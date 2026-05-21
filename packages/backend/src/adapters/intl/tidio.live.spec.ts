import * as adapter from './tidio.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; type: string; authConfig: { headerName: string } };
};
describe('tidio adapter — static spec conformance', () => {
  it('api.tidio.co/v1/graphql base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.tidio.co/v1/graphql'));
  it('GraphQL connector with custom header auth', () => {
    expect(a.connector.type).toBe('GRAPHQL');
    expect(a.connector.authConfig.headerName).toBe('X-Tidio-Openapi-Token');
  });
});
