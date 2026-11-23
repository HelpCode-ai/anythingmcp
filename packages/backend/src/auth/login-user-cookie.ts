import type { Request, Response } from 'express';

/**
 * The cookie the OAuth callback trusts: who signed in on the authorization
 * pages. Signed (HMAC) and httpOnly.
 *
 * It is bound to ONE pending authorization. `login_bind` carries the id of
 * the authorization (`oauth_session`) the person signed in and allowed
 * access for; the callback only accepts `login_user` when the two match. A
 * sign-in that paused on the page after approving keeps its cookie for up to
 * 30 minutes: without the binding, any other pending authorization started in
 * that browser in the meantime (a second "Connect", or one opened by another
 * site through open client registration) could be finished through
 * `/callback` without its own consent page.
 *
 * Both cookies are cleared once the code is issued (CallbackGuardMiddleware).
 */
export const LOGIN_USER_COOKIE = 'login_user';
export const LOGIN_BIND_COOKIE = 'login_bind';

/** The pending authorization of this browser (the library's cookie), or null. */
export function pendingAuthorizationId(req: Request): string | null {
  const id = req.cookies?.oauth_session;
  return typeof id === 'string' && id ? id : null;
}

/** Signs the person in for the pending authorization of this request. */
export function setLoginUserCookie(
  req: Request,
  res: Response,
  encodedProfile: string,
  opts: { maxAge: number; secure: boolean },
): void {
  const cookie = {
    httpOnly: true,
    secure: opts.secure,
    maxAge: opts.maxAge,
    sameSite: opts.secure ? ('none' as const) : ('lax' as const),
    signed: true, // HMAC-signed: rejects forged cookies in the OAuth strategy
  };
  res.cookie(LOGIN_USER_COOKIE, encodedProfile, cookie);
  const id = pendingAuthorizationId(req);
  if (id) res.cookie(LOGIN_BIND_COOKIE, id, cookie);
  else res.clearCookie(LOGIN_BIND_COOKIE);
}

export function clearLoginUserCookie(res: Response): void {
  res.clearCookie(LOGIN_USER_COOKIE);
  res.clearCookie(LOGIN_BIND_COOKIE);
}

/**
 * The signed `login_user` value, only when it was issued for the pending
 * authorization of this request. Anything else (no cookie, another or no
 * pending authorization, a cookie from before the binding existed) is null:
 * the person signs in or allows again.
 */
export function boundLoginUser(req: Request): string | null {
  const signed = (req as Request & { signedCookies?: Record<string, unknown> }).signedCookies;
  const user = signed?.[LOGIN_USER_COOKIE];
  const bind = signed?.[LOGIN_BIND_COOKIE];
  const id = pendingAuthorizationId(req);
  if (typeof user !== 'string' || !user || typeof bind !== 'string' || !id || bind !== id) return null;
  return user;
}
