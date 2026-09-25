import * as adapter from './reddit.json';
const a = adapter as unknown as {
  requiredEnvVars: string[];
  connector: { baseUrl: string; authType: string; authConfig: any };
  tools: { name: string; endpointMapping: { method: string } }[];
  probe?: { tool: string; params?: Record<string, unknown> };
};
describe('reddit adapter — static spec conformance', () => {
  it('reads via oauth.reddit.com (NOT www.reddit.com)', () =>
    expect(a.connector.baseUrl).toBe('https://oauth.reddit.com'));

  it('uses OAuth2 app-only (client_credentials) with auto-refresh', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig.grant).toBe('client_credentials');
    expect(a.connector.authConfig.tokenUrl).toBe(
      'https://www.reddit.com/api/v1/access_token',
    );
    expect(a.connector.authConfig.clientId).toBe('{{REDDIT_CLIENT_ID}}');
    expect(a.connector.authConfig.clientSecret).toBe('{{REDDIT_CLIENT_SECRET}}');
    expect(a.requiredEnvVars).toEqual(['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET']);
  });

  it("pins a User-Agent in Reddit's <platform>:<app id>:<version> (by /u/<name>) format", () => {
    // Reddit throttles generic agents; the token service forwards this same
    // header to the token request, so it identifies both legs.
    expect(a.connector.authConfig.extraHeaders['User-Agent']).toMatch(
      /^[a-z]+:[\w.-]+:v?[\w.]+ \(by \/u\/[\w-]+\)$/,
    );
  });

  it('probes a public read at install, so a wrong client ID/secret shows on the form', () => {
    expect(a.probe?.tool).toBe('reddit_get_subreddit_about');
    expect(a.tools.map((t) => t.name)).toContain(a.probe!.tool);
  });

  it('exposes read-only tools only (app-only cannot post/vote/whoami)', () => {
    const names = a.tools.map((t) => t.name);
    // No user-context tools that app-only auth cannot perform.
    for (const forbidden of [
      'reddit_me',
      'reddit_submit_post',
      'reddit_post_comment',
      'reddit_vote',
      'reddit_save',
      'reddit_my_subreddits',
    ]) {
      expect(names).not.toContain(forbidden);
    }
    // Every remaining tool is a GET read.
    expect(a.tools.every((t) => t.endpointMapping.method === 'GET')).toBe(true);
  });
});
