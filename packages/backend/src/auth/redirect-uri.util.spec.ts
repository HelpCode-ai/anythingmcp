import { validateRedirectUri, validateRedirectUris } from './redirect-uri.util';

describe('validateRedirectUri', () => {
  const accepted = (uri: string) => expect(validateRedirectUri(uri)).toBeNull();
  const rejected = (uri: string) => expect(validateRedirectUri(uri)).not.toBeNull();

  describe('real MCP clients must keep working', () => {
    // Breaking any of these locks users out of the product, so they are
    // asserted explicitly rather than left to the general rules.
    it.each([
      ['claude.ai', 'https://claude.ai/api/mcp/auth_callback'],
      ['Claude Desktop loopback', 'http://localhost:33418/callback'],
      ['loopback by IP', 'http://127.0.0.1:8080/oauth/callback'],
      ['IPv6 loopback', 'http://[::1]:8080/cb'],
      ['VS Code private-use scheme', 'vscode://anthropic.claude/authenticate'],
      ['Cursor private-use scheme', 'cursor://anysphere.cursor-mcp/callback'],
      ['https with query', 'https://app.example.com/cb?tenant=acme'],
    ])('accepts %s', (_label, uri) => accepted(uri));
  });

  describe('rejects URIs where the URI itself is the weapon', () => {
    it('rejects wildcards', () => {
      rejected('https://*.evil.tld/cb');
      rejected('https://example.com/*');
    });

    it('rejects path traversal', () => {
      rejected('https://example.com/cb/../../admin');
    });

    it('rejects fragments (RFC 6749 §3.1.2)', () => {
      rejected('https://example.com/cb#token');
    });

    it('rejects cleartext http to a non-loopback host', () => {
      // The authorization code would cross the network in the clear.
      expect(validateRedirectUri('http://example.com/cb')).toMatch(/loopback/);
      expect(validateRedirectUri('http://192.168.1.10/cb')).toMatch(/loopback/);
    });

    it('rejects non-absolute or empty values', () => {
      rejected('/callback');
      rejected('');
      rejected('   ');
      rejected(undefined as unknown as string);
      rejected(42 as unknown as string);
    });
  });

  describe('scope: what this deliberately does NOT block', () => {
    it('accepts an attacker-controlled https host', () => {
      // Registration is open, so this cannot be stopped here. The consent
      // screen — which shows the destination host before a code is issued —
      // is the control for this case. Asserted so nobody mistakes this
      // validator for protection it does not provide.
      accepted('https://evil.tld/steal');
    });
  });

  describe('validateRedirectUris', () => {
    it('returns no rejections when every URI is fine', () => {
      expect(
        validateRedirectUris(['https://a.example/cb', 'http://localhost:1/cb']),
      ).toEqual([]);
    });

    it('collects every offending URI, not just the first', () => {
      const rejections = validateRedirectUris([
        'https://ok.example/cb',
        'https://*.bad.tld/cb',
        'http://plain.tld/cb',
      ]);

      expect(rejections).toHaveLength(2);
      expect(rejections.map((r) => r.uri)).toEqual([
        'https://*.bad.tld/cb',
        'http://plain.tld/cb',
      ]);
    });
  });
});
