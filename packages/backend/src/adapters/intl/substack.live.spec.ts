import * as adapter from './substack.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('substack adapter — static spec conformance', () => {
  it('per-publication base URL', () => expect(a.connector.baseUrl).toBe('{{SUBSTACK_PUBLICATION_URL}}'));
  it('public — no auth', () => expect(a.connector.authType).toBe('NONE'));
});
