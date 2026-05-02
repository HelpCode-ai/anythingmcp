import { promises as dns } from 'dns';
import { isIP } from 'net';

/**
 * SSRF guard for outbound HTTP/S calls performed on behalf of users.
 *
 * Users can configure connectors with arbitrary baseUrls and tokenUrls,
 * which means our backend will resolve and call any host they want. Without
 * a guard this becomes a confused deputy: an attacker uses our backend to
 * read AWS/GCP/Azure metadata, scan internal services, or reach databases
 * exposed only on the internal network.
 *
 * Behavior: resolve the hostname to all A/AAAA records and reject the
 * request if ANY resolved IP falls into a blocked range. Public DNS that
 * happens to point at a private IP (DNS rebinding / pinning trick) is also
 * caught because we check the resolved IPs, not the hostname.
 *
 * Configuration via env:
 *   - SSRF_GUARD=disabled            disable the check entirely (NOT recommended)
 *   - SSRF_ALLOW_LOCALHOST=true      allow loopback (only useful in dev / e2e)
 *   - SSRF_ALLOW_PRIVATE=true        allow RFC1918 ranges (NOT recommended; use
 *                                    SSRF_ALLOWED_HOSTS for specific hosts)
 *   - SSRF_ALLOWED_HOSTS=a,b,c       comma-separated hostname allowlist
 *                                    (exact match or *.suffix)
 */

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

interface SsrfPolicy {
  enabled: boolean;
  allowLoopback: boolean;
  allowPrivate: boolean;
  allowedHosts: string[];
}

function readPolicy(env: NodeJS.ProcessEnv = process.env): SsrfPolicy {
  // The guard performs real DNS resolution and would make most unit tests
  // depend on the network. Disable it under jest unless the test explicitly
  // opts in by setting SSRF_GUARD=enabled.
  const isTest = env.NODE_ENV === 'test' || !!env.JEST_WORKER_ID;
  const disabled =
    env.SSRF_GUARD === 'disabled' ||
    (isTest && env.SSRF_GUARD !== 'enabled');
  return {
    enabled: !disabled,
    allowLoopback: env.SSRF_ALLOW_LOCALHOST === 'true',
    allowPrivate: env.SSRF_ALLOW_PRIVATE === 'true',
    allowedHosts: (env.SSRF_ALLOWED_HOSTS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}

function hostMatchesAllowlist(hostname: string, allowed: string[]): boolean {
  const lower = hostname.toLowerCase();
  for (const entry of allowed) {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1);
      if (lower.endsWith(suffix)) return true;
    } else if (entry === lower) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true if `ip` is a routable public address — i.e. NOT loopback,
 * link-local, RFC1918 private, CGNAT, multicast, broadcast, or
 * IPv6-mapped private equivalents.
 */
function isPublicIp(ip: string, policy: SsrfPolicy): boolean {
  const family = isIP(ip);
  if (family === 0) return false;

  if (family === 4) {
    const parts = ip.split('.').map((p) => parseInt(p, 10));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
    const [a, b] = parts;

    // Loopback 127.0.0.0/8
    if (a === 127) return policy.allowLoopback;
    // RFC1918 private
    if (a === 10) return policy.allowPrivate;
    if (a === 172 && b >= 16 && b <= 31) return policy.allowPrivate;
    if (a === 192 && b === 168) return policy.allowPrivate;
    // Link-local 169.254.0.0/16 (incl. cloud metadata 169.254.169.254)
    if (a === 169 && b === 254) return false;
    // CGNAT 100.64.0.0/10
    if (a === 100 && b >= 64 && b <= 127) return policy.allowPrivate;
    // 0.0.0.0/8
    if (a === 0) return false;
    // Multicast 224.0.0.0/4
    if (a >= 224 && a <= 239) return false;
    // Reserved 240.0.0.0/4 + broadcast
    if (a >= 240) return false;
    return true;
  }

  // IPv6
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return policy.allowLoopback;
  if (lower.startsWith('fe80:') || lower.startsWith('fe80::')) return false; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return policy.allowPrivate; // ULA
  if (lower.startsWith('ff')) return false; // multicast
  // IPv4-mapped (::ffff:a.b.c.d)
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIp(mapped[1], policy);
  return true;
}

/**
 * Throws SsrfBlockedError if the URL's hostname resolves to a blocked
 * address. Resolves DNS so that public hostnames pointing at private IPs
 * (rebinding) are also caught.
 *
 * Returns silently when the request is permitted.
 */
export async function assertSafeOutboundUrl(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const policy = readPolicy(env);
  if (!policy.enabled) return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError(`SSRF guard: invalid URL '${url}'`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(
      `SSRF guard: protocol '${parsed.protocol}' is not allowed`,
    );
  }

  const hostname = parsed.hostname;

  if (hostMatchesAllowlist(hostname, policy.allowedHosts)) return;

  // If the host is already a literal IP, check it directly.
  if (isIP(hostname)) {
    if (!isPublicIp(hostname, policy)) {
      throw new SsrfBlockedError(
        `SSRF guard: address '${hostname}' is not a public IP`,
      );
    }
    return;
  }

  // Block 'localhost' and friends explicitly — DNS may not resolve them
  // consistently across environments.
  const lowerHost = hostname.toLowerCase();
  if (
    !policy.allowLoopback &&
    (lowerHost === 'localhost' ||
      lowerHost.endsWith('.localhost') ||
      lowerHost.endsWith('.local'))
  ) {
    throw new SsrfBlockedError(
      `SSRF guard: hostname '${hostname}' is loopback / local`,
    );
  }

  let resolved: { address: string; family: number }[];
  try {
    resolved = await dns.lookup(hostname, { all: true });
  } catch (e: any) {
    throw new SsrfBlockedError(
      `SSRF guard: cannot resolve '${hostname}': ${e?.message || e}`,
    );
  }

  for (const { address } of resolved) {
    if (!isPublicIp(address, policy)) {
      throw new SsrfBlockedError(
        `SSRF guard: hostname '${hostname}' resolves to non-public address '${address}'`,
      );
    }
  }
}

// Exposed for unit tests.
export const __test = { isPublicIp, hostMatchesAllowlist, readPolicy };
