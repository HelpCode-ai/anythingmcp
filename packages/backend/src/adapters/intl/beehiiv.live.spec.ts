import * as adapter from './beehiiv.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string; authConfig: Record<string,string> } };
describe('beehiiv adapter — static spec conformance', () => {
  it('publication-templated base URL', () => {
    expect(a.connector.baseUrl).toBe('https://api.beehiiv.com/v2/publications/{{BEEHIIV_PUBLICATION_ID}}');
  });
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
