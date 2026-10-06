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
    [
      "Host not found: 'nina.api.proxy.bund.dev' could not be resolved (ENOTFOUND). Check the address in the connector settings.",
      'nina.api.proxy.bund.dev',
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

describe('assertSafeOutboundHost on a name that does not resolve', () => {
  it('says the host was not found instead of reporting a policy block', async () => {
    const { assertSafeOutboundHost } = await import('./ssrf.util');
    await expect(
      assertSafeOutboundHost('no-such-host.invalid', { SSRF_GUARD: 'enabled' } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/^Host not found: 'no-such-host\.invalid' could not be resolved \(ENOTFOUND\)/);
  });
});

describe('the public-address rule', () => {
  const env = { SSRF_GUARD: 'enabled' } as NodeJS.ProcessEnv;

  it.each([
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.1.2.3/',
    'http://[::1]/',
    'http://[::]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[0:0:0:0:0:ffff:a00:1]/',
    'http://[::a9fe:a9fe]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://[2002:a9fe:a9fe::1]/',
    'http://[fe80::1]/',
    'http://[febf::1]/',
    'http://[fd00::1]/',
    'http://[ff02::1]/',
  ])('blocks %s', async (url) => {
    const { assertSafeOutboundUrl, SsrfBlockedError } = await import('./ssrf.util');
    await expect(assertSafeOutboundUrl(url, env)).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertSafeOutboundUrl(url, env)).rejects.toThrow(/is not a public IP/);
  });

  it.each(['http://93.184.216.34/', 'http://[2606:2800:220:1:248:1893:25c8:1946]/'])(
    'allows %s',
    async (url) => {
      const { assertSafeOutboundUrl } = await import('./ssrf.util');
      await expect(assertSafeOutboundUrl(url, env)).resolves.toBeUndefined();
    },
  );

  it('lets the allowlist through for an IPv6 literal', async () => {
    const { assertSafeOutboundUrl } = await import('./ssrf.util');
    await expect(
      assertSafeOutboundUrl('http://[fd00::1]/', { ...env, SSRF_ALLOWED_HOSTS: 'fd00::1' }),
    ).resolves.toBeUndefined();
  });
});
