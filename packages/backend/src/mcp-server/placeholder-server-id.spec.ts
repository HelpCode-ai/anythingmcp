import { isPlaceholderServerId, placeholderServerIdMessage } from './placeholder-server-id';

describe('isPlaceholderServerId', () => {
  it.each([
    'YOUR_SERVER_ID',
    'your_server_id',
    'YOUR-SERVER-ID',
    'YourServerId',
    'YOUR_SERVER_ID, then click Add.',
    // Express decodes params once; a double-encoded value still matches.
    'YOUR_SERVER_ID,%20then%20click%20Add.',
    'YOUR_SERVER_ID%2C%20then%20click%20Add.',
    ' YOUR_SERVER_ID ',
    '<server-id>',
    '<serverId>',
    '{serverId}',
    '[server_id]',
    ':serverId',
  ])('recognises %p', (value) => {
    expect(isPlaceholderServerId(value)).toBe(true);
  });

  it.each([
    'cmabc123def456ghi789jkl0',
    'srv-A',
    'demo',
    'server-id-of-mine',
    'my_YOUR_SERVER_ID',
    '',
    // Malformed escape: no throw, and no match.
    '%E0%A4%A',
  ])('leaves %p alone', (value) => {
    expect(isPlaceholderServerId(value)).toBe(false);
  });

  it('ignores non-strings', () => {
    expect(isPlaceholderServerId(undefined)).toBe(false);
    expect(isPlaceholderServerId(null)).toBe(false);
    expect(isPlaceholderServerId(42)).toBe(false);
  });
});

describe('placeholderServerIdMessage', () => {
  it('names the placeholder, the dashboard page and the sign-in endpoint on the given base', () => {
    const message = placeholderServerIdMessage('https://mcp.example.test');
    expect(message).toMatch(/^MCP server not found: /);
    expect(message).toContain('Replace YOUR_SERVER_ID');
    expect(message).toContain('MCP Servers page');
    expect(message).toContain('https://mcp.example.test/mcp.');
  });
});
