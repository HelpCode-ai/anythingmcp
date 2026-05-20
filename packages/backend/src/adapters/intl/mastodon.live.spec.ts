import * as adapter from './mastodon.json';
const a = adapter as unknown as { connector: { baseUrl: string; authType: string } };
describe('mastodon adapter — static spec conformance', () => {
  it('baseUrl is the per-instance placeholder', () =>
    expect(a.connector.baseUrl).toBe('{{MASTODON_INSTANCE_URL}}'));
  it('Bearer auth (per-instance personal access token)', () =>
    expect(a.connector.authType).toBe('BEARER_TOKEN'));
});
