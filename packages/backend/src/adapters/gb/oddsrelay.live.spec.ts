import * as adapter from './oddsrelay.json';
const a = adapter as unknown as {
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
  };
  probe: { tool: string };
  tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
};
describe('oddsrelay adapter — static spec conformance', () => {
  it('api.oddsrelay.io, /v2 routes', () => expect(a.connector.baseUrl).toBe('https://api.oddsrelay.io'));
  it('Bearer auth', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{ODDSRELAY_KEY}}');
  });
  it('asks for gzip, which some boards require', () => {
    expect(a.connector.headers['Accept-Encoding']).toBe('gzip');
  });
  it('checks the connection with the usage call, which spends no tokens', () => {
    expect(a.probe.tool).toBe('oddsrelay_get_usage');
    expect(a.connector.healthcheckPath).toBe('/v2/usage');
  });
  it('marks only the two tools that spend tokens as not read-only', () => {
    const spending = a.tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name);
    expect(spending.sort()).toEqual(['oddsrelay_get_board', 'oddsrelay_get_event_odds']);
  });
});
