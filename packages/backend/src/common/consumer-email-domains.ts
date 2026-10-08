/**
 * Free / consumer mailbox providers: an address on one of these says nothing
 * about a company behind it. Exact domains only: a subdomain such as
 * `mail.company.gmail.com` does not exist for these providers, and matching
 * subdomains would let `anything.web.de`-style hosts in by accident.
 *
 * Used by the Cloud trial win-back to tell private users from businesses. Not
 * a sign-up filter: disposable inboxes are a different list.
 */
export const CONSUMER_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  // Google
  'gmail.com',
  'googlemail.com',
  // Yahoo
  'yahoo.com',
  'yahoo.it',
  'yahoo.de',
  'yahoo.fr',
  'yahoo.co.uk',
  'yahoo.es',
  'yahoo.co.jp',
  'ymail.com',
  // Microsoft
  'hotmail.com',
  'hotmail.it',
  'hotmail.de',
  'hotmail.fr',
  'hotmail.co.uk',
  'hotmail.es',
  'outlook.com',
  'outlook.it',
  'outlook.de',
  'outlook.fr',
  'outlook.es',
  'live.com',
  'live.it',
  'live.de',
  'live.fr',
  'msn.com',
  // Apple
  'icloud.com',
  'me.com',
  'mac.com',
  // AOL
  'aol.com',
  // Germany, Austria, Switzerland
  'gmx.de',
  'gmx.net',
  'gmx.at',
  'gmx.ch',
  'gmx.com',
  'web.de',
  't-online.de',
  'freenet.de',
  'posteo.de',
  'mailbox.org',
  'bluewin.ch',
  // Italy
  'libero.it',
  'virgilio.it',
  'alice.it',
  'tiscali.it',
  'tim.it',
  // Privacy-focused
  'proton.me',
  'protonmail.com',
  'pm.me',
  'tutanota.com',
  'tuta.io',
  'hey.com',
  'duck.com',
  // Russia
  'yandex.ru',
  'yandex.com',
  'ya.ru',
  'mail.ru',
  'bk.ru',
  'inbox.ru',
  'list.ru',
  'rambler.ru',
  // China
  'qq.com',
  '163.com',
  '126.com',
  // France
  'orange.fr',
  'free.fr',
  'laposte.net',
  'wanadoo.fr',
  'sfr.fr',
  // Ukraine, Czechia, Poland
  'ukr.net',
  'i.ua',
  'seznam.cz',
  'wp.pl',
  'o2.pl',
  'interia.pl',
  'onet.pl',
  // Korea, India
  'naver.com',
  'hanmail.net',
  'daum.net',
  'rediffmail.com',
  // Generic providers
  'mail.com',
  'fastmail.com',
  'zoho.com',
]);

/** True when the address is on a consumer mailbox provider (case-insensitive). */
export function isConsumerEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.lastIndexOf('@');
  if (at < 1) return false;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  return CONSUMER_EMAIL_DOMAINS.has(domain);
}
