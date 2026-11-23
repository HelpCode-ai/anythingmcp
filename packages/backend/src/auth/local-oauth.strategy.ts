import { Strategy } from 'passport-strategy';
import { Request } from 'express';
import { boundLoginUser } from './login-user-cookie';

/**
 * Custom Passport strategy for local username/password authentication
 * within the MCP OAuth2 Authorization Code flow.
 *
 * Flow:
 *   1. /authorize calls passport.authenticate() → strategy redirects to /auth/login
 *   2. User submits credentials at /auth/login → controller sets login_user cookie
 *   3. Login controller redirects to /callback
 *   4. /callback calls passport.authenticate() again → strategy reads cookie → success
 */
export class LocalOAuthStrategy extends Strategy {
  name = 'local-oauth';

  private verifyFn: (
    accessToken: string,
    refreshToken: string,
    profile: any,
    done: (err: any, user?: any) => void,
  ) => void;

  private options: { serverUrl: string; callbackPath: string };

  constructor(
    options: { serverUrl: string; callbackPath: string },
    verify: (
      accessToken: string,
      refreshToken: string,
      profile: any,
      done: (err: any, user?: any) => void,
    ) => void,
  ) {
    super();
    this.options = options;
    this.verifyFn = verify;
  }

  authenticate(req: Request): void {
    // Workaround: @rekog/mcp-nest's authorize endpoint calls
    // passport.authenticate() without { session: false }, so passport
    // tries to serialize the user to a session that doesn't exist.
    // Patch req.logIn to always disable sessions.
    const origLogIn = req.logIn;
    if (origLogIn) {
      req.logIn = function (user: any, optionsOrDone?: any, done?: any) {
        if (typeof optionsOrDone === 'function') {
          return origLogIn.call(this, user, { session: false }, optionsOrDone);
        }
        return origLogIn.call(this, user, { ...optionsOrDone, session: false }, done);
      } as any;
    }

    // Only consume the login cookie on the CALLBACK endpoint. The same strategy
    // runs both for /authorize (initiate) and /callback (validate). @rekog's
    // /authorize calls passport.authenticate() in its redirect form (no success
    // callback): if the strategy calls success() there — which happens whenever a
    // still-valid login_user cookie is present — passport falls through to next()
    // and Express returns 404 "Cannot GET /authorize". That breaks any client
    // (e.g. Microsoft Copilot Studio) that re-hits /authorize while the short-lived
    // login cookie is still set. So on /authorize we ALWAYS redirect to login;
    // the cookie is only read on /callback, where handleProviderCallback expects
    // success().
    const reqPath = (req.path || (req as any).originalUrl || '').split('?')[0];
    const isCallback =
      reqPath === this.options.callbackPath ||
      reqPath.endsWith(this.options.callbackPath);

    // We REQUIRE the cookie to be HMAC-signed (req.signedCookies). Unsigned
    // values in req.cookies are rejected to prevent an attacker forging a
    // base64-encoded profile to bypass authentication.
    //
    // And it must have been issued for THIS pending authorization
    // (login-user-cookie.ts): a sign-in that paused on the page after
    // approving stays valid for up to 30 minutes, and must not finish another
    // authorization started in the same browser in the meantime.
    const loginUserCookie = isCallback ? boundLoginUser(req) : undefined;

    if (loginUserCookie) {
      try {
        const profile = JSON.parse(
          Buffer.from(loginUserCookie, 'base64url').toString('utf-8'),
        );

        // Call the verify function with the profile
        this.verifyFn(
          'local',
          '',
          profile,
          (err: any, user: any) => {
            if (err) return this.error(err);
            if (!user) return this.fail('Authentication failed', 401);
            this.success(user);
          },
        );
      } catch {
        // Invalid cookie — redirect to login
        this.redirectToLogin(req);
      }
    } else {
      // No login cookie — redirect to login page
      this.redirectToLogin(req);
    }
  }

  private getBaseUrl(req: Request): string {
    const proto =
      (req.headers['x-forwarded-proto'] as string) ||
      (req.secure ? 'https' : 'http');
    const host =
      (req.headers['x-forwarded-host'] as string) || req.headers.host;
    if (host) {
      return `${proto}://${host}`;
    }
    return this.options.serverUrl;
  }

  private redirectToLogin(req: Request): void {
    const baseUrl = this.getBaseUrl(req);
    const loginUrl = `${baseUrl}/auth/login`;
    this.redirect(loginUrl);
  }
}
