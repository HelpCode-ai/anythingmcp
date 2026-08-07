/**
 * Validation for OAuth `redirect_uri` values accepted through Dynamic Client
 * Registration.
 *
 * SCOPE — be honest about what this does and does not buy:
 *
 * DCR on this server is open, so an attacker can always register a client
 * pointing at a host they control (`https://evil.tld/cb`) and these rules will
 * ALLOW it. The defence against that is the consent screen, which shows the
 * user the destination host before any code is issued — not URI syntax.
 *
 * What this closes is the narrower set where the URI itself is the weapon:
 *   - wildcards, which turn one registration into a family of destinations
 *   - path traversal, which can escape a vetted callback path
 *   - fragments, which OAuth forbids on a redirect target
 *   - cleartext http to a non-loopback host, where the code is interceptable
 *
 * Private-use schemes (`vscode://`, `cursor://`, …) are permitted on purpose:
 * RFC 8252 §7.1 makes them the standard mechanism for native clients, and
 * rejecting them would lock out real MCP clients.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

export interface RedirectUriRejection {
  uri: string;
  reason: string;
}

/**
 * Returns a rejection reason, or null when the URI is acceptable.
 */
export function validateRedirectUri(uri: unknown): string | null {
  if (typeof uri !== 'string' || uri.trim() === '') {
    return 'must be a non-empty string';
  }

  // Checked on the RAW string: a wildcard can sit in a position the URL parser
  // would silently normalise or accept.
  if (uri.includes('*')) {
    return 'must not contain a wildcard';
  }
  if (uri.includes('..')) {
    return 'must not contain a path traversal segment';
  }
  if (uri.includes('#')) {
    return 'must not contain a fragment (RFC 6749 §3.1.2)';
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return 'must be an absolute URI';
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();

  if (scheme === 'https') return null;

  if (scheme === 'http') {
    // RFC 8252 §7.3: cleartext loopback is the sanctioned native-client
    // pattern. Anywhere else the authorization code crosses the network in
    // the clear and is interceptable.
    const host = parsed.hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host)
      ? null
      : 'http is only allowed for loopback hosts (RFC 8252 §7.3); use https';
  }

  // Private-use scheme for a native client (RFC 8252 §7.1). Require it to look
  // like a real scheme so a typo does not register something unusable.
  if (/^[a-z][a-z0-9+.-]*$/.test(scheme)) return null;

  return `unsupported URI scheme '${scheme}'`;
}

/** Validates a whole `redirect_uris` array, collecting every rejection. */
export function validateRedirectUris(uris: unknown[]): RedirectUriRejection[] {
  const rejections: RedirectUriRejection[] = [];
  for (const uri of uris) {
    const reason = validateRedirectUri(uri);
    if (reason) {
      rejections.push({ uri: typeof uri === 'string' ? uri : String(uri), reason });
    }
  }
  return rejections;
}
