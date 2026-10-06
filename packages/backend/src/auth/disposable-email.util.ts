import domainList from './disposable-email-domains.json';

/**
 * Domains of throwaway inboxes (yopmail, mailinator, ...), from
 * https://github.com/disposable-email-domains/disposable-email-domains
 * (CC0, commit 1aac72a, 2026-10-05). Refresh by replacing the JSON with the
 * current `disposable_email_blocklist.conf`, one domain per entry.
 *
 * The list leaves out forwarding services that deliver to a real inbox
 * (Apple Hide My Email, SimpleLogin, Firefox Relay, DuckDuckGo): people pay
 * with those, so they must keep working.
 */
const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set(domainList.map((d) => d.toLowerCase()));

export const DISPOSABLE_EMAIL_MESSAGE =
  'Please sign up with a permanent email address. Disposable email addresses are not accepted.';

/** True when the address's domain, or a domain it is a subdomain of, is a throwaway inbox. */
export function isDisposableEmail(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const labels = email.slice(at + 1).trim().toLowerCase().replace(/\.$/, '').split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    if (DISPOSABLE_DOMAINS.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}
