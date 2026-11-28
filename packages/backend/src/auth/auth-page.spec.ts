import {
  directoryBadgeHtml,
  directoryBadgesFor,
  isRaycastClient,
  knownClientFor,
  signupClientFor,
} from './auth-page';

describe('directory badges on the authorization page', () => {
  it("shows each assistant only its own listing, Muse neither, and anyone else both", () => {
    expect(directoryBadgesFor('claude')).toEqual(['claude']);
    expect(directoryBadgesFor('chatgpt')).toEqual(['chatgpt']);
    expect(directoryBadgesFor('muse')).toEqual([]);
    expect(directoryBadgesFor('other')).toEqual(['claude', 'chatgpt']);
  });

  it('judges Claude and ChatGPT by the redirect host, not the name', () => {
    expect(directoryBadgesFor(signupClientFor('Claude', 'claude.ai'))).toEqual(['claude']);
    expect(directoryBadgesFor(signupClientFor('ChatGPT', 'chatgpt.com'))).toEqual(['chatgpt']);
    // A client that only calls itself ChatGPT is just another client.
    expect(directoryBadgesFor(signupClientFor('ChatGPT', 'evil.example'))).toEqual(['claude', 'chatgpt']);
  });

  it('renders one pill: the listing shown, or a neutral one naming both', () => {
    const claude = directoryBadgeHtml(['claude']);
    expect(claude).toContain('Listed in Anthropic&#39;s Claude Directory');
    expect(claude).toContain('fill="#D97757"');
    expect(claude).not.toContain('ChatGPT');

    const chatgpt = directoryBadgeHtml(['chatgpt']);
    expect(chatgpt).toContain('Listed in OpenAI&#39;s ChatGPT Plugin Directory');
    expect(chatgpt).toContain('class="verified verified-chatgpt"');
    expect(chatgpt).toContain('fill="#10A37F"');
    expect(chatgpt).not.toContain('Claude');

    const both = directoryBadgeHtml(['claude', 'chatgpt']);
    expect(both).toContain('Listed in the Claude and ChatGPT directories');
    expect(both).toContain('fill="#D97757"');
    expect(both).toContain('fill="#10A37F"');

    expect(directoryBadgeHtml([])).toBe('');
  });
});

describe('Raycast on the authorization page', () => {
  it('is recognised by its name, its raycast:// redirect or a raycast.com redirect', () => {
    expect(signupClientFor('Raycast', 'localhost:1234')).toBe('raycast');
    expect(signupClientFor('Raycast AI (MCP)', '')).toBe('raycast');
    expect(signupClientFor('My app', 'oauth', 'raycast://oauth?package_name=Extension')).toBe('raycast');
    expect(signupClientFor('My app', 'raycast.com', 'https://raycast.com/redirect?packageName=Extension')).toBe('raycast');
    expect(isRaycastClient('raycast', '', '')).toBe(true);
  });

  it('does not take a lookalike for Raycast', () => {
    expect(signupClientFor('Raycaster', 'example.com')).toBe('other');
    expect(signupClientFor('My app', 'raycast.com.evil.example', 'https://raycast.com.evil.example/cb')).toBe('other');
    expect(signupClientFor('My app', 'evil.example', 'https://evil.example/raycast://')).toBe('other');
  });

  it('never outranks a client judged by its redirect host', () => {
    // A code sent to claude.ai goes to Claude, whatever the client calls itself.
    expect(signupClientFor('Raycast', 'claude.ai', 'https://claude.ai/api/mcp/auth_callback')).toBe('claude');
    expect(signupClientFor('Raycast', 'chatgpt.com', 'https://chatgpt.com/connector_platform_oauth_redirect')).toBe('chatgpt');
  });

  it('only labels the client: Raycast sees the same badges as any other client', () => {
    expect(directoryBadgesFor('raycast')).toEqual(directoryBadgesFor('other'));
    expect(knownClientFor('raycast.com')).toBeNull();
  });
});
