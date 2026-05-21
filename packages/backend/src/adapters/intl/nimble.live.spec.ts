import * as adapter from './nimble.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: { tokenUrl: string } };
};
describe('nimble adapter — static spec conformance', () => {
  it('app.nimble.com/api/v1 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://app.nimble.com/api/v1'));
  it('OAuth2 refresh-token flow', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig.tokenUrl).toBe('https://app.nimble.com/oauth/token');
  });
});
