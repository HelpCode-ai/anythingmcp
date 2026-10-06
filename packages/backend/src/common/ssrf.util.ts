import { promises as dns, LookupAddress } from 'dns';
import * as http from 'http';
import * as https from 'https';
import { isIP, LookupFunction } from 'net';

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

/**
 * Hook point that lets the DB-backed admin allowlist contribute extra hosts
 * to the policy. Set by SsrfPolicyService at module init; falls back to a
 * no-op when the service isn't wired (unit tests, scripts).
 */
let dbAllowedHostsProvider: (() => Promise<string[]>) | null = null;

/**
 * Wire a DB-backed list provider into the guard. Called once by
 * SsrfPolicyService.onModuleInit. The provider may return a cached list so it
 * is cheap to call on every outbound URL.
 */
export function setDbAllowedHostsProvider(
  provider: () => Promise<string[]>,
): void {
  dbAllowedHostsProvider = provider;
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

  // IPv6, on the eight 16-bit groups so that every spelling of an address
  // (`::ffff:7f00:1`, `::ffff:127.0.0.1`, `0:0:0:0:0:ffff:7f00:1`) is judged
  // the same.
  const g = ipv6Groups(ip);
  if (!g) return false;
  const embeddedV4 = (hi: number, lo: number) =>
    `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  // :: (unspecified) and ::1 (loopback)
  if (zeroUpTo(7) && (g[7] === 0 || g[7] === 1)) return policy.allowLoopback;
  // IPv4-mapped ::ffff:a.b.c.d
  if (zeroUpTo(5) && g[5] === 0xffff) return isPublicIp(embeddedV4(g[6], g[7]), policy);
  // IPv4-compatible ::a.b.c.d (deprecated, still routed by some stacks)
  if (zeroUpTo(6)) return isPublicIp(embeddedV4(g[6], g[7]), policy);
  // NAT64 64:ff9b::a.b.c.d reaches the embedded IPv4 address
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isPublicIp(embeddedV4(g[6], g[7]), policy);
  }
  // 6to4 2002:AABB:CCDD::/48 embeds a.b.c.d
  if (g[0] === 0x2002) return isPublicIp(embeddedV4(g[1], g[2]), policy);
  if ((g[0] & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g[0] & 0xfe00) === 0xfc00) return policy.allowPrivate; // ULA fc00::/7
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  return true;
}

/** The eight 16-bit groups of an IPv6 address, or null when it does not parse. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().split('%')[0];
  // A trailing dotted IPv4 part stands for the last two groups.
  const v4 = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const parts = v4[2].split('.').map((p) => parseInt(p, 10));
    if (parts.some((p) => Number.isNaN(p) || p > 255)) return null;
    text =
      v4[1] +
      ((parts[0] << 8) | parts[1]).toString(16) +
      ':' +
      ((parts[2] << 8) | parts[3]).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map(
    (h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN),
  );
  return groups.some((x) => Number.isNaN(x)) ? null : groups;
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

  // An IPv6 literal comes back bracketed ("[::1]"); the checks want the address.
  await assertSafeOutboundHost(parsed.hostname.replace(/^\[|\]$/g, ''), env);
}

/**
 * Protocol-agnostic SSRF guard for a bare hostname / IP literal. Same policy and
 * checks as {@link assertSafeOutboundUrl} (env + DB allowlists, literal-IP check,
 * loopback/local block, DNS resolution against blocked ranges) — but without the
 * http(s) URL assumption, so it also guards non-HTTP outbound connections such as
 * database drivers (Postgres, MySQL, MSSQL, Oracle, SAP HANA, MongoDB).
 *
 * Returns silently when the host is permitted.
 */
export async function assertSafeOutboundHost(
  hostname: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const policy = readPolicy(env);
  if (!policy.enabled) return;
  await vetHost(hostname, policy);
}

/**
 * Apply the policy to `hostname`. Returns null when the host is allowlisted
 * (env or DB), otherwise the addresses it resolves to, every one of them
 * checked. Throws SsrfBlockedError when the host is not allowed.
 */
async function vetHost(
  hostname: string,
  policy: SsrfPolicy,
): Promise<LookupAddress[] | null> {
  if (!hostname) {
    throw new SsrfBlockedError('SSRF guard: empty hostname');
  }

  // Env-driven allowlist (synchronous).
  if (hostMatchesAllowlist(hostname, policy.allowedHosts)) return null;

  // DB-driven allowlist (admin-configured, async). The provider caches
  // internally so this is effectively a Map lookup after the first call.
  if (dbAllowedHostsProvider) {
    try {
      const dbHosts = await dbAllowedHostsProvider();
      if (hostMatchesAllowlist(hostname, dbHosts)) return null;
    } catch {
      // Provider failure: fall through to IP-based checks rather than
      // hard-failing every outbound call.
    }
  }

  // If the host is already a literal IP, check it directly.
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (!isPublicIp(hostname, policy)) {
      throw new SsrfBlockedError(
        `SSRF guard: address '${hostname}' is not a public IP`,
      );
    }
    return [{ address: hostname, family: literalFamily }];
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

  let resolved: LookupAddress[];
  try {
    resolved = await dns.lookup(hostname, { all: true });
  } catch (e: any) {
    // Not a policy decision: the name simply has no address (a typo, a
    // retired API, a DNS hiccup). Worded as such, because "SSRF guard" made
    // users and the model read a security block into a wrong host name.
    const temporary = e?.code === 'EAI_AGAIN';
    throw new SsrfBlockedError(
      `Host not found: '${hostname}' could not be resolved (${e?.code || e?.message || e}). ` +
        (temporary
          ? 'This is usually a temporary DNS failure; try again.'
          : 'Check the address in the connector settings.'),
    );
  }

  for (const { address } of resolved) {
    if (!isPublicIp(address, policy)) {
      throw new SsrfBlockedError(
        `SSRF guard: hostname '${hostname}' resolves to non-public address '${address}'`,
      );
    }
  }
  return resolved;
}

/**
 * A `lookup` for http(s).Agent that applies the guard when the socket
 * connects, and connects only to the addresses it checked.
 *
 * {@link assertSafeOutboundUrl} on its own checks the URL once, before the
 * request: the HTTP client then resolves the name again, and a DNS answer can
 * change in between. With this lookup the check and the connection use the
 * same answer.
 *
 * Node does not call `lookup` for a literal IP, so callers must still run
 * {@link assertSafeOutboundUrl} on each URL they request (including every
 * redirect target): that is what covers `http://169.254.169.254/`. The
 * helpers in outbound-http.ts do both.
 */
export function ssrfGuardedLookup(
  env: NodeJS.ProcessEnv = process.env,
): LookupFunction {
  return (hostname, options, callback) => {
    const policy = readPolicy(env);
    // The operator's own HTTP(S)_PROXY usually sits on a private address;
    // when it is in use the proxy resolves the target, not us.
    const vetted =
      policy.enabled && !envProxyHosts(env).has(hostname.toLowerCase())
        ? vetHost(hostname, policy)
        : Promise.resolve(null);
    vetted
      .then((addrs) => addrs ?? dns.lookup(hostname, { all: true }))
      .then((addrs) => {
        const wanted =
          options?.family === 4 || options?.family === 'IPv4'
            ? 4
            : options?.family === 6 || options?.family === 'IPv6'
              ? 6
              : 0;
        const usable = wanted
          ? addrs.filter((a) => a.family === wanted)
          : addrs;
        if (usable.length === 0) {
          const err: NodeJS.ErrnoException = new Error(
            `getaddrinfo ENOTFOUND ${hostname}`,
          );
          err.code = 'ENOTFOUND';
          throw err;
        }
        if (options?.all) callback(null, usable);
        else callback(null, usable[0].address, usable[0].family);
      })
      .catch((err) => callback(err, '', 0));
  };
}

function envProxyHosts(env: NodeJS.ProcessEnv): Set<string> {
  const hosts = new Set<string>();
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    const value = env[key];
    if (!value) continue;
    try {
      hosts.add(new URL(value).hostname.toLowerCase());
    } catch {
      /* not a URL: axios ignores it too */
    }
  }
  return hosts;
}

/**
 * http and https agents whose connections go through {@link ssrfGuardedLookup}.
 * Pass both to axios (`httpAgent`, `httpsAgent`) together with `proxy: false`:
 * an env proxy would make the agent resolve the proxy, not the target.
 */
export function createSsrfGuardedAgents(env: NodeJS.ProcessEnv = process.env): {
  httpAgent: http.Agent;
  httpsAgent: https.Agent;
} {
  const lookup = ssrfGuardedLookup(env);
  // Same socket reuse as Node's global agents, which these replace.
  const options = { lookup, keepAlive: true, scheduling: 'lifo' as const, timeout: 5000 };
  return {
    httpAgent: new http.Agent(options),
    httpsAgent: new https.Agent(options),
  };
}

/**
 * Pull the blocked host out of an SSRF guard message, when adding that host to
 * the allowlist would actually unblock the request.
 *
 * The allowlist is consulted before the literal-IP, loopback and DNS checks
 * (see assertSafeOutboundHost), so every "this address/hostname is not public"
 * variant is fixable that way — including a Docker service name that does not
 * resolve from outside its network. `invalid URL` and `protocol not allowed`
 * are not: those are malformed input, so they return undefined and the caller
 * shows the plain error.
 */
export function extractSsrfBlockedHostname(
  message: string,
): string | undefined {
  const match =
    /SSRF guard:\s*(?:address|hostname|cannot resolve)\s*'([^']+)'/.exec(message || '') ??
    /Host not found:\s*'([^']+)'/.exec(message || '');
  return match?.[1];
}

// Exposed for unit tests.
export const __test = { isPublicIp, hostMatchesAllowlist, readPolicy };
