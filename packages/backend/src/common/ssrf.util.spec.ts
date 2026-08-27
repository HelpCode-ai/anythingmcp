import { extractSsrfBlockedHostname } from './ssrf.util';

describe('extractSsrfBlockedHostname', () => {
  // The allowlist is checked before the IP / loopback / DNS checks, so every
  // one of these is genuinely fixable by allowlisting the host.
  it.each([
    ["SSRF guard: address '192.168.1.50' is not a public IP", '192.168.1.50'],
    ["SSRF guard: hostname 'localhost' is loopback / local", 'localhost'],
    [
      "SSRF guard: hostname 'internal.example' resolves to non-public address '10.0.0.5'",
      'internal.example',
    ],
    [
      "SSRF guard: cannot resolve 'other-mcp-server': getaddrinfo ENOTFOUND other-mcp-server",
      'other-mcp-server',
    ],
  ])('extracts the host from %s', (message, expected) => {
    expect(extractSsrfBlockedHostname(message)).toBe(expected);
  });

  it.each([
    "SSRF guard: invalid URL 'not a url'",
    "SSRF guard: protocol 'file:' is not allowed",
    'SSRF guard: empty hostname',
    'ECONNREFUSED 127.0.0.1:3000',
    '',
  ])('returns undefined for %s (allowlisting would not help)', (message) => {
    expect(extractSsrfBlockedHostname(message)).toBeUndefined();
  });
});
