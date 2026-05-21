import * as adapter from './harvest.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; headers: Record<string, string> };
};
describe('harvest adapter — static spec conformance', () => {
  it('api.harvestapp.com/v2 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.harvestapp.com/v2'));
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
  it('Harvest-Account-Id + User-Agent headers required', () => {
    expect(a.connector.headers['Harvest-Account-Id']).toBeDefined();
    expect(a.connector.headers['User-Agent']).toBeDefined();
  });
});
