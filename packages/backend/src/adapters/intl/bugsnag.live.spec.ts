import * as adapter from './bugsnag.json';
const a = adapter as unknown as {
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: { headerName: string; extraHeaders: Record<string, string> };
  };
};
describe('bugsnag adapter — static spec conformance', () => {
  it('api.bugsnag.com base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.bugsnag.com'));
  it('Authorization header + X-Version: 2', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('Authorization');
    expect(a.connector.authConfig.extraHeaders['X-Version']).toBe('2');
  });
});
