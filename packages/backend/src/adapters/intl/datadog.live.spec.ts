import * as adapter from './datadog.json';
const a = adapter as unknown as {
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: { headerName: string; extraHeaders: Record<string, string> };
  };
};
describe('datadog adapter — static spec conformance', () => {
  it('api.datadoghq.com base URL (US1 default)', () =>
    expect(a.connector.baseUrl).toBe('https://api.datadoghq.com'));
  it('dual-header auth: DD-API-KEY + DD-APPLICATION-KEY', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('DD-API-KEY');
    expect(Object.keys(a.connector.authConfig.extraHeaders)).toContain('DD-APPLICATION-KEY');
  });
});
