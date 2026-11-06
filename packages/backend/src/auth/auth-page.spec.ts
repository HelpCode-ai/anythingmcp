import { directoryBadgeHtml, directoryBadgesFor, signupClientFor } from './auth-page';

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
    expect(chatgpt).toContain('Listed in OpenAI&#39;s ChatGPT plugin directory');
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
