import { Strategy } from 'passport-strategy';
import { Request } from 'express';

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
    // Check if the user has already authenticated via the login form
    // (login controller sets a signed cookie with user profile)
    const loginUserCookie = (req as any).cookies?.login_user;

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
