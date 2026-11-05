import { isIP } from 'node:net';

/**
 * The public IP addresses this instance calls connector APIs from, and the
 * advice given when a server refuses those calls because of its IP allowlist.
 *
 * WHY. Many servers only accept approved addresses: a self-hosted ERP or CRM
 * behind a firewall, and providers that check every call (eMAG, Shopee, the
 * Korean law API). Their refusal rarely says so: most answer 403 with a web
 * page ("Access Restricted"), which the model reads as a broken connector and
 * the user as a broken product. The setup page and the connector page show the
 * address up front, and a refused call names it, so the user knows what to
 * give their network admin.
 *
 * The addresses come from `EGRESS_IPS` (comma-separated). An operator sets it
 * when the instance calls out from fixed addresses; without it nothing is
 * shown and the advice speaks of "the public IP address of the server
 * AnythingMCP runs on". Entries that are not IP addresses are ignored.
 */
export function egressIps(env: NodeJS.ProcessEnv = process.env): string[] {
  const ips = (env.EGRESS_IPS ?? '')
    .split(',')
    .map((ip) => ip.trim())
    .filter((ip) => isIP(ip) !== 0);
  return [...new Set(ips)];
}

/** "1.2.3.4", "1.2.3.4 and 5.6.7.8", "1.2.3.4, 5.6.7.8 and 9.9.9.9". */
export function listIps(ips: string[]): string {
  if (ips.length <= 1) return ips[0] ?? '';
  return `${ips.slice(0, -1).join(', ')} and ${ips[ips.length - 1]}`;
}

// What servers and providers answer when the calling address is not on their
// list. Matched on the response text, whatever the status (eMAG answers its
// refusal inside a 200). Each names the address check itself: a plain
// "Access denied" from an API is a permission, not an allowlist.
const IP_REFUSAL_PATTERNS: RegExp[] = [
  /source_ip_undeclared/i, // Shopee
  /not in the IP allow ?list/i, // TikTok Shop (36009033)
  /You are not allowed to use this API/i, // eMAG
  /\bIP\b(?: address)?[^\n]{0,40}\b(?:is )?not (?:allowed|whitelisted|allowlisted|authori[sz]ed|permitted|in the (?:white|allow) ?list)/i,
  /\b(?:not (?:allowed|whitelisted|allowlisted|authori[sz]ed)|blocked|denied|forbidden)[^\n]{0,30}\bfrom (?:this|your) IP\b/i,
  /\bIP (?:restriction|whitelist|allowlist|address restriction)/i,
];

// Bot walls answer a datacenter address with a 403 page too, but no
// allowlist on the user's side fixes those (the per-tool proxy does).
const BOT_WALL = /cloudflare|cf-ray|just a moment|attention required|edgesuite|akamai|datadome|perimeterx|px-captcha|captcha|incapsula|imperva|sucuri/i;

/**
 * True when an answer looks like a server refusing the caller's address:
 * one of the known refusals above, or a 403 that is a web page instead of
 * the API's answer (a firewall, reverse proxy or WAF in front of the API),
 * unless the page is a known bot wall.
 */
export function looksLikeIpRefusal(input: { status?: number; text: string }): boolean {
  if (IP_REFUSAL_PATTERNS.some((re) => re.test(input.text))) return true;
  return input.status === 403 && /<(?:!doctype|html)[\s>]/i.test(input.text) && !BOT_WALL.test(input.text);
}

/**
 * One paragraph for a call refused that way, written for the model (tool
 * errors) and readable by the user (setup check).
 */
export function ipRefusalHint(opts: {
  ips: string[];
  cloud?: boolean;
  usedProxy?: boolean;
}): string {
  const where = opts.ips.length
    ? `${opts.cloud ? 'AnythingMCP Cloud' : 'This AnythingMCP server'} calls every API from ` +
      `${opts.ips.length === 1 ? 'the fixed IP address' : 'the fixed IP addresses'} ${listIps(opts.ips)}.`
    : 'AnythingMCP calls it from the public IP address of the server AnythingMCP runs on.';
  const allow = opts.ips.length ? listIps(opts.ips) : 'that address';
  const proxy = opts.usedProxy
    ? ' This call went through the proxy ("Use proxy" on the tool), which uses changing addresses that ' +
      'an allowlist always blocks: switch "Use proxy" off for this tool.'
    : '';
  return (
    'The server refused the request before it reached the API, the way a firewall or an IP allowlist ' +
    `does: it most likely accepts only approved IP addresses. ${where} Retrying will not help: tell ` +
    `the user to ask whoever runs that server or account to allow ${allow}.${proxy} If it still fails ` +
    'afterwards, the block comes from something else in front of the server (bot protection, a ' +
    'country block), which its admin can see in the firewall log.'
  );
}
