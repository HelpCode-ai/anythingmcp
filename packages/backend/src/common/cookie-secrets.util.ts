/**
 * Secrets for cookie-parser's signed cookies. cookie-parser signs with the
 * first secret and accepts a cookie signed with any of them.
 *
 * Without COOKIE_SECRET, cookies are signed with JWT_SECRET. When an operator
 * adds COOKIE_SECRET later, new cookies are signed with it, and JWT_SECRET
 * stays a verification key: a sign-in or connector flow that started before
 * the restart still completes instead of failing. This costs nothing in
 * security, because whoever holds JWT_SECRET can already sign sessions.
 */
export function cookieSecrets(env: { COOKIE_SECRET?: string; JWT_SECRET?: string }): string[] {
  const cookie = env.COOKIE_SECRET?.trim() || '';
  const jwt = env.JWT_SECRET?.trim() || '';
  const secrets = [cookie, jwt].filter((s, i, all) => s && all.indexOf(s) === i);
  if (!secrets.length) {
    throw new Error('COOKIE_SECRET (or fallback JWT_SECRET) must be set for signed cookies');
  }
  return secrets;
}
