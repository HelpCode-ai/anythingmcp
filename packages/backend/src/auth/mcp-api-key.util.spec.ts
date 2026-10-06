import { presentedMcpApiKey } from './mcp-api-key.util';

describe('presentedMcpApiKey', () => {
  it('reads a per-user key from X-API-Key', () => {
    expect(presentedMcpApiKey({ 'x-api-key': 'mcp_abc' })).toBe('mcp_abc');
  });

  it('reads a per-user key sent as Authorization: Bearer', () => {
    expect(presentedMcpApiKey({ authorization: 'Bearer mcp_abc' })).toBe('mcp_abc');
    expect(presentedMcpApiKey({ authorization: 'bearer mcp_abc' })).toBe('mcp_abc');
  });

  it('prefers X-API-Key when both carry a key', () => {
    expect(
      presentedMcpApiKey({ 'x-api-key': 'mcp_header', authorization: 'Bearer mcp_bearer' }),
    ).toBe('mcp_header');
  });

  it('ignores OAuth access tokens (JWTs) and other schemes', () => {
    expect(presentedMcpApiKey({ authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x' })).toBeUndefined();
    expect(presentedMcpApiKey({ authorization: 'Basic bWNwX2FiYzo=' })).toBeUndefined();
    expect(presentedMcpApiKey({ authorization: 'mcp_abc' })).toBeUndefined();
    expect(presentedMcpApiKey({ 'x-api-key': 'static-key' })).toBeUndefined();
    expect(presentedMcpApiKey({})).toBeUndefined();
  });

  it("leaves a self-hosted operator's static MCP_BEARER_TOKEN to the static check, even with an mcp_ prefix", () => {
    expect(presentedMcpApiKey({ authorization: 'Bearer mcp_static' }, 'mcp_static')).toBeUndefined();
    expect(presentedMcpApiKey({ authorization: 'Bearer mcp_user' }, 'mcp_static')).toBe('mcp_user');
  });

  it('ignores a repeated header delivered as an array', () => {
    expect(presentedMcpApiKey({ 'x-api-key': ['mcp_a', 'mcp_b'] })).toBeUndefined();
  });
});
