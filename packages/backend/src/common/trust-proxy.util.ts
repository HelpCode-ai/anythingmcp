import express from 'express';

/**
 * Which reverse proxies Express may believe about the client address.
 *
 * Express turns `X-Forwarded-For` into `req.ip`, and `req.ip` keys the
 * per-IP rate limits (ThrottlerGuard) and the request log. With
 * `trust proxy = true` Express takes the LEFTMOST entry of the header, which
 * is whatever the client sent: a client could put a different address in
 * every request and never be rate limited.
 *
 * The default trusts only proxies on private networks (loopback, link-local
 * and unique-local / RFC 1918 ranges): Express walks the header from the
 * right, skips every hop on such a network and stops at the first public
 * address, the one the outermost proxy actually saw. That fits the bundled
 * setups (Caddy or the frontend in front of the backend on a Docker network)
 * and any LAN proxy, however many hops there are, while an address a client
 * injects stays to the left of its real one and is never reached.
 *
 * `TRUST_PROXY` overrides it:
 *   - unset or empty        → `loopback, linklocal, uniquelocal` (default)
 *   - a whole number n      → trust the n hops closest to the backend
 *   - `false` / `0`         → trust no proxy (the backend faces clients directly)
 *   - `true`                → trust every hop: the client's own header wins (unsafe)
 *   - a comma-separated list of addresses, CIDR ranges and the names
 *     `loopback`, `linklocal`, `uniquelocal` (e.g. a proxy on a public address)
 */
export const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal';

export interface TrustProxySetting {
  /** The value handed to `app.set('trust proxy', …)`. */
  value: boolean | number | string;
  /** A short description for the boot log. */
  description: string;
  /** True when a client can choose its own address (`true`). */
  unsafe: boolean;
}

export function resolveTrustProxy(raw: string | undefined): TrustProxySetting {
  const input = (raw ?? '').trim();
  if (!input) {
    return {
      value: DEFAULT_TRUST_PROXY,
      description: `private-network proxies (${DEFAULT_TRUST_PROXY})`,
      unsafe: false,
    };
  }

  const lower = input.toLowerCase();
  if (lower === 'true') {
    return {
      value: true,
      description: 'every proxy (TRUST_PROXY=true): the client controls its address',
      unsafe: true,
    };
  }
  if (lower === 'false') {
    return { value: false, description: 'no proxy (TRUST_PROXY=false)', unsafe: false };
  }

  if (/^\d+$/.test(input)) {
    const hops = Number(input);
    if (!Number.isSafeInteger(hops)) {
      throw new Error(`TRUST_PROXY: "${input}" is not a valid number of hops`);
    }
    return hops === 0
      ? { value: false, description: 'no proxy (TRUST_PROXY=0)', unsafe: false }
      : {
          value: hops,
          description: `${hops} proxy hop${hops === 1 ? '' : 's'} (TRUST_PROXY=${hops})`,
          unsafe: false,
        };
  }

  const entries = input
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const value = entries.join(', ');
  try {
    // Express compiles the list (proxy-addr) when it is set; doing it here
    // turns a typo into a boot error with a clear message.
    express().set('trust proxy', value);
  } catch (err) {
    throw new Error(
      `TRUST_PROXY: "${input}" is not a number, true/false, or a list of addresses, ` +
        `CIDR ranges and loopback/linklocal/uniquelocal (${(err as Error).message})`,
    );
  }
  return { value, description: `the listed proxies (${value})`, unsafe: false };
}
