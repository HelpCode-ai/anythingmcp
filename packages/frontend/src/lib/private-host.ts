/**
 * Recognises addresses that only work inside the user's own network, so the
 * File Search wizard on Cloud can explain before (and after) the connection
 * test why such a NAS cannot be reached and what to do instead.
 *
 * This is a hint, not a guard: the backend's SSRF check decides what may be
 * connected to.
 */

/** The host of a host name, `host:port` or URL ("https://192.168.1.5:5006/x" → "192.168.1.5"). */
export function hostOf(value: string): string {
  let v = value.trim().toLowerCase();
  if (!v) return '';
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  v = v.replace(/^[^@/]*@/, '');
  v = v.split(/[/?#]/)[0] ?? '';
  if (v.startsWith('[')) return v.slice(1, v.indexOf(']') > 0 ? v.indexOf(']') : undefined);
  // A bare IPv6 address has more than one colon; anything else may end in :port.
  if ((v.match(/:/g) ?? []).length === 1) v = v.split(':')[0] ?? '';
  return v.replace(/\.$/, '');
}

const LOCAL_SUFFIXES = ['.local', '.lan', '.home', '.internal', '.intranet', '.localdomain', '.home.arpa', '.fritz.box'];

function privateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    // Carrier-grade NAT, also the range Tailscale hands out.
    (a === 100 && b >= 64 && b <= 127)
  );
}

function privateIpv6(host: string): boolean {
  if (!host.includes(':')) return false;
  return host === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
}

/** True for a private IP, a name without a dot ("diskstation") or a home-network suffix ("nas.local"). */
export function isPrivateHost(value: string): boolean {
  const host = hostOf(value);
  if (!host) return false;
  if (privateIpv4(host) || privateIpv6(host)) return true;
  if (/^\d+(\.\d+){0,3}$/.test(host)) return false;
  if (host === 'localhost' || !host.includes('.')) return true;
  return LOCAL_SUFFIXES.some((s) => host.endsWith(s));
}

/** A Synology QuickConnect address: it relays Synology's own apps only, never SFTP or WebDAV. */
export function isQuickConnect(value: string): boolean {
  const host = hostOf(value);
  return host === 'quickconnect.to' || host.endsWith('.quickconnect.to') || /(^|\.)quickconnect\.cn$/.test(host);
}
