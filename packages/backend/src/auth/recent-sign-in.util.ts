import type { Request, Response } from 'express';

/**
 * Proof that this browser just signed in on the authorization page, while
 * connecting an AI client: a signed, httpOnly cookie with the user id and the
 * time of the sign-in.
 *
 * The setup links an AI client hands out (/s/<token>) open the dashboard. A
 * user who has just connected Claude was asked to sign in a second time
 * there, minutes after the first. With this cookie, the link opens a
 * dashboard session itself, but only for the user the link was made for and
 * only in the browser that signed in: a link copied out of a chat opens
 * nothing elsewhere.
 */
export const RECENT_SIGN_IN_COOKIE = 'amcp_signin';

/**
 * Two hours: enough to finish the setup the chat hands out right after
 * connecting, and short enough that a shared or borrowed browser, where
 * someone only connected an AI client and never opened (or signed out of)
 * the dashboard, does not keep a password-free sign-in for days.
 */
export const RECENT_SIGN_IN_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Header the dashboard sends on the requests that turn this cookie into a
 * session. A page on another origin, a sibling subdomain included, cannot
 * add a custom header without a CORS preflight, which only the dashboard's
 * own origin passes: a blind cross-site POST carrying the cookie is refused.
 */
export const RECENT_SIGN_IN_HEADER = 'x-amcp-dashboard';

export function hasDashboardHeader(req: Request): boolean {
  return req.headers?.[RECENT_SIGN_IN_HEADER] === '1';
}

export interface RecentSignIn {
  userId: string;
  /** When the sign-in happened, in seconds (compared with sessionsValidFrom). */
  iat: number;
}

export function setRecentSignInCookie(res: Response, userId: string, secure: boolean, now = Date.now()): void {
  const value = Buffer.from(JSON.stringify({ uid: userId, iat: Math.floor(now / 1000) })).toString('base64url');
  res.cookie(RECENT_SIGN_IN_COOKIE, value, {
    httpOnly: true,
    secure,
    // Read by the dashboard on the same site: Lax is enough, and it keeps the
    // cookie off cross-site subrequests.
    sameSite: 'lax',
    signed: true,
    path: '/',
    maxAge: RECENT_SIGN_IN_MAX_AGE_MS,
  });
}

/** The signed cookie's content, or null when it is missing, forged, malformed or too old. */
export function readRecentSignIn(req: Request, now = Date.now()): RecentSignIn | null {
  const raw = (req as Request & { signedCookies?: Record<string, unknown> }).signedCookies?.[RECENT_SIGN_IN_COOKIE];
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { uid?: unknown; iat?: unknown };
    if (typeof parsed?.uid !== 'string' || !parsed.uid) return null;
    if (typeof parsed.iat !== 'number' || !Number.isFinite(parsed.iat)) return null;
    // The browser drops it after maxAge; a copied value must not outlive it either.
    if (parsed.iat * 1000 + RECENT_SIGN_IN_MAX_AGE_MS < now) return null;
    return { userId: parsed.uid, iat: parsed.iat };
  } catch {
    return null;
  }
}
