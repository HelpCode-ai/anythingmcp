import type { CookieOptions, Request } from 'express';

/**
 * Cookies of the connect page (/auth/connect, connect-page.controller), where
 * a user connects their own account to a connector with per-user credentials.
 * All are httpOnly and signed with COOKIE_SECRET (cookie-parser), so their
 * values cannot be forged or read by scripts.
 */

/**
 * Who signed in on the connect page through the workspace's identity provider
 * (SsoController sets it after the CONNECT surface). Valid on /auth/connect
 * only: it is not a dashboard session and opens nothing else.
 */
export const CONNECT_USER_COOKIE = 'connect_user';
/** How long that sign-in lasts: enough to connect, nothing more. */
export const CONNECT_USER_TTL_MS = 15 * 60 * 1000;

/**
 * The browser binding of a pending connect-page sign-in at the identity
 * provider, with the connector it is for. Path /auth, because it is read on
 * /auth/sso/callback.
 */
export const CONNECT_SSO_COOKIE = 'connect_sso';

/**
 * The state of the connector authorization this browser started from the
 * connect page. The completion refuses a state the browser does not carry.
 */
export const CONNECT_FLOW_COOKIE = 'connect_flow';

/** How long a trip to the identity provider or the connector's provider may take. */
export const CONNECT_ROUND_TRIP_MS = 10 * 60 * 1000;

export const CONNECT_PAGE_PATH = '/auth/connect';

export interface ConnectUserCookie {
  /** users.id */
  uid: string;
  /** Issued at (epoch ms): checked against the user's sessionsValidFrom. */
  iat: number;
}

export interface ConnectSsoCookie {
  /** Random binding value, also recorded on the SSO attempt. */
  b: string;
  /** The connector the sign-in is for. */
  c: string;
}

export function connectCookieOptions(req: Request, path: string, maxAge: number): CookieOptions {
  const secure =
    req.secure ||
    req.headers['x-forwarded-proto'] === 'https' ||
    process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure,
    // Lax: the providers send the browser back with a top-level GET, which
    // carries Lax cookies, while a cross-site POST or subrequest does not.
    sameSite: 'lax',
    signed: true,
    path,
    maxAge,
  };
}

/** A signed cookie's JSON value, or null when absent, unsigned or malformed. */
export function readSignedJsonCookie<T>(req: Request, name: string): T | null {
  const raw = (req as Request & { signedCookies?: Record<string, unknown> }).signedCookies?.[name];
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as T) : null;
  } catch {
    return null;
  }
}
