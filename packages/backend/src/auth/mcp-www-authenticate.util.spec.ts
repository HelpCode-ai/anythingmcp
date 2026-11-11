import { mcpWwwAuthenticate } from './mcp-www-authenticate.util';

describe('mcpWwwAuthenticate', () => {
  const withToken = {
    headers: { host: 'cloud.example.com', 'x-forwarded-proto': 'https', authorization: 'Bearer tok' },
  };
  const probe = { headers: { host: 'cloud.example.com', 'x-forwarded-proto': 'https' } };
  const META = 'resource_metadata="https://cloud.example.com/.well-known/oauth-protected-resource/mcp/srv"';

  it('adds error_description after invalid_token', () => {
    expect(mcpWwwAuthenticate(withToken, '/mcp/srv', 'http://x', 'Not a member')).toBe(
      `Bearer realm="AnythingMCP MCP Server", error="invalid_token", error_description="Not a member", ${META}`,
    );
  });

  it('keeps the header unchanged without a description', () => {
    expect(mcpWwwAuthenticate(withToken, '/mcp/srv', 'http://x')).toBe(
      `Bearer realm="AnythingMCP MCP Server", error="invalid_token", ${META}`,
    );
  });

  it('never adds a description to an unauthenticated probe', () => {
    expect(mcpWwwAuthenticate(probe, '/mcp/srv', 'http://x', 'Not a member')).toBe(
      `Bearer realm="AnythingMCP MCP Server", ${META}`,
    );
  });

  it.each(['say "hi"', 'back\\slash', 'non-ASCII é', 'line\nbreak'])(
    'leaves out a description the RFC does not allow: %p',
    (description) => {
      expect(mcpWwwAuthenticate(withToken, '/mcp/srv', 'http://x', description)).toBe(
        `Bearer realm="AnythingMCP MCP Server", error="invalid_token", ${META}`,
      );
    },
  );
});
