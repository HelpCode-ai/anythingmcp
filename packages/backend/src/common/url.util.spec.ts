import { BadRequestException } from '@nestjs/common';
import { normalizeConnectorBaseUrl, resolveMcpEndpointUrl } from './url.util';

describe('normalizeConnectorBaseUrl', () => {
  it('keeps a well-formed https URL untouched', () => {
    expect(
      normalizeConnectorBaseUrl('https://api.example.com/v1', 'REST'),
    ).toBe('https://api.example.com/v1');
  });

  it('prepends https:// when the scheme is missing', () => {
    expect(normalizeConnectorBaseUrl('api.na1.insightly.com/v3.1', 'REST')).toBe(
      'https://api.na1.insightly.com/v3.1',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeConnectorBaseUrl('  https://api.example.com  ', 'REST')).toBe(
      'https://api.example.com',
    );
  });

  it('rejects a malformed scheme like "api.https://…" (the production mangling)', () => {
    expect(() =>
      normalizeConnectorBaseUrl('api.https://na1.insightly.com', 'REST'),
    ).toThrow(BadRequestException);
  });

  it('rejects an empty base URL', () => {
    expect(() => normalizeConnectorBaseUrl('   ', 'REST')).toThrow(
      BadRequestException,
    );
  });

  it('rejects a non-http scheme for HTTP connectors', () => {
    expect(() =>
      normalizeConnectorBaseUrl('ftp://files.example.com', 'REST'),
    ).toThrow(BadRequestException);
  });

  it('leaves DATABASE connector URLs untouched (own scheme)', () => {
    expect(
      normalizeConnectorBaseUrl('mysql://user:pass@db.example.com:3306/app', 'DATABASE'),
    ).toBe('mysql://user:pass@db.example.com:3306/app');
  });

  it('defaults to HTTP normalization when type is omitted', () => {
    expect(normalizeConnectorBaseUrl('api.example.com')).toBe(
      'https://api.example.com',
    );
  });
});

describe('resolveMcpEndpointUrl', () => {
  const resolve = (base: string, path?: string) =>
    resolveMcpEndpointUrl(base, path).toString();

  it('defaults a bare origin to /mcp', () => {
    expect(resolve('https://mcp.example.com', '/mcp')).toBe(
      'https://mcp.example.com/mcp',
    );
    expect(resolve('https://mcp.example.com')).toBe(
      'https://mcp.example.com/mcp',
    );
  });

  it('treats a root path as a bare origin', () => {
    expect(resolve('https://chat.z.ai/', '/mcp')).toBe('https://chat.z.ai/mcp');
  });

  it('leaves the common "<origin>/mcp" base URL untouched', () => {
    expect(resolve('http://other-mcp-server:3000/mcp', '/mcp')).toBe(
      'http://other-mcp-server:3000/mcp',
    );
  });

  it('preserves a deep path — Snowflake managed MCP servers (#501)', () => {
    const base =
      'https://acct.snowflakecomputing.com/api/v2/databases/mydb/schemas/public/mcp-servers/my-server';
    expect(resolve(base, '/mcp')).toBe(base);
  });

  it('preserves an AnythingMCP Cloud per-tenant endpoint', () => {
    expect(resolve('https://cloud.anythingmcp.com/mcp/srv_123', '/mcp')).toBe(
      'https://cloud.anythingmcp.com/mcp/srv_123',
    );
  });

  it('drops a trailing slash instead of emitting a double slash', () => {
    expect(resolve('https://mcp.example.com/api/mcp/', '/mcp')).toBe(
      'https://mcp.example.com/api/mcp',
    );
  });

  it('keeps a query string carried by the base URL', () => {
    expect(resolve('https://gw.example.com/mcp?key=abc', '/mcp')).toBe(
      'https://gw.example.com/mcp?key=abc',
    );
  });

  it('resolves an explicit root-absolute override against the origin', () => {
    expect(resolve('https://mcp.example.com', '/sse')).toBe(
      'https://mcp.example.com/sse',
    );
    expect(resolve('https://mcp.example.com/ignored', '/sse')).toBe(
      'https://mcp.example.com/sse',
    );
  });

  it('joins a relative override onto the base path', () => {
    expect(resolve('https://mcp.example.com/base', 'sub/mcp')).toBe(
      'https://mcp.example.com/base/sub/mcp',
    );
  });

  it('honours an absolute http(s) override verbatim', () => {
    expect(
      resolve('https://mcp.example.com', 'https://other.example.com/mcp'),
    ).toBe('https://other.example.com/mcp');
  });

  it('rejects an unparseable base URL', () => {
    expect(() => resolveMcpEndpointUrl('not a url', '/mcp')).toThrow(
      BadRequestException,
    );
  });
});
