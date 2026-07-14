import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Req,
  Res,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';
import { AuthService } from './auth.service';
import { PrismaService } from '../common/prisma.service';
import { PrismaOAuthStore } from './prisma-oauth.store';

/**
 * Context describing the OAuth client that initiated the current authorize
 * flow. Rendered on the login page so the user can see — and thereby approve —
 * exactly which client and callback destination they are authorizing before
 * they submit their credentials.
 */
interface ConsentContext {
  clientName: string;
  redirectUri: string;
  redirectHost: string;
  scopeText: string;
}

@Controller('auth')
export class LoginController {
  private readonly logger = new Logger(LoginController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly oauthStore: PrismaOAuthStore,
  ) {}

  @Get('login')
  async showLoginPage(
    @Query('error') error: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const serverName =
      this.configService.get<string>('MCP_SERVER_NAME') || 'AnythingMCP';

    // Which client/redirect is this login authorizing? Read it from the OAuth
    // session that @rekog/mcp-nest's /authorize handler stored (keyed by the
    // httpOnly `oauth_session` cookie) so the user gives INFORMED consent.
    const consent = await this.loadConsentContext(req);

    // Issue a CSRF token bound to this render (double-submit, HMAC-signed
    // cookie + matching hidden field). Prevents login CSRF / silent
    // credential submission from a cross-site context.
    const csrfToken = randomBytes(32).toString('base64url');
    const isSecure = this.isSecureRequest(req);
    res.cookie('login_csrf', csrfToken, {
      httpOnly: true,
      secure: isSecure,
      maxAge: 10 * 60 * 1000, // 10 minutes — long enough to fill the form
      sameSite: isSecure ? 'none' : 'lax',
      signed: true,
    });

    res.setHeader('Content-Type', 'text/html');
    res.send(this.renderLoginPage({ error, serverName, consent, csrfToken }));
  }

  @Post('login')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async handleLogin(
    @Req() req: Request,
    @Body()
    body: {
      email: string;
      password: string;
      csrf: string;
      action?: string;
    },
    @Res() res: Response,
  ) {
    const serverName =
      this.configService.get<string>('MCP_SERVER_NAME') || 'AnythingMCP';

    // CSRF: the signed cookie must match the form field. Reject before doing
    // anything with the submitted credentials.
    if (!this.verifyCsrf(req, body.csrf)) {
      this.logger.warn('Rejected login with missing/invalid CSRF token');
      res.clearCookie('login_csrf');
      return res.redirect(
        `/auth/login?error=${encodeURIComponent('Your session expired. Please try again.')}`,
      );
    }

    // The user explicitly declined on the consent screen: abort the flow and
    // drop the OAuth session cookies so no authorization code can be issued.
    if (body.action === 'deny') {
      res.clearCookie('login_csrf');
      res.clearCookie('oauth_session');
      res.clearCookie('oauth_state');
      res.setHeader('Content-Type', 'text/html');
      return res.send(this.renderDeniedPage(serverName));
    }

    const { email, password } = body;

    if (!email || !password) {
      return res.redirect(
        `/auth/login?error=${encodeURIComponent('Email and password are required')}`,
      );
    }

    // Find user by email
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      this.logger.warn(`Login attempt for non-existent user: ${email}`);
      return res.redirect(
        `/auth/login?error=${encodeURIComponent('Invalid email or password')}`,
      );
    }

    // Verify password
    const passwordValid = await this.authService.comparePassword(
      password,
      user.passwordHash,
    );

    if (!passwordValid) {
      this.logger.warn(`Failed login attempt for user: ${email}`);
      return res.redirect(
        `/auth/login?error=${encodeURIComponent('Invalid email or password')}`,
      );
    }

    this.logger.log(`Successful login for user: ${email}`);

    // Set a short-lived cookie with the user profile for the callback to read
    const profile = {
      id: user.id,
      email: user.email,
      name: user.name,
      username: user.email,
    };

    const encoded = Buffer.from(JSON.stringify(profile)).toString('base64url');

    const isSecure = this.isSecureRequest(req);

    res.cookie('login_user', encoded, {
      httpOnly: true,
      secure: isSecure,
      maxAge: 60 * 1000, // 1 minute — just enough for the redirect
      sameSite: isSecure ? 'none' : 'lax',
      signed: true, // HMAC-signed: rejects forged cookies in the OAuth strategy
    });

    // The consent decision has been made — the single-use CSRF token is done.
    res.clearCookie('login_csrf');

    // Derive callback URL from the request origin (works behind proxy/tunnel)
    const baseUrl = this.getBaseUrl(req);
    res.redirect(`${baseUrl}/callback`);
  }

  /**
   * Loads the client/redirect being authorized from the pending OAuth session.
   * Returns null when there is no valid pending session (e.g. the login page was
   * hit outside an authorize flow) — in that case a generic login form is shown,
   * which is safe because /callback refuses to issue a code without a session.
   */
  private async loadConsentContext(
    req: Request,
  ): Promise<ConsentContext | null> {
    const sessionId = req.cookies?.oauth_session;
    if (!sessionId || typeof sessionId !== 'string') return null;

    try {
      const session = await this.oauthStore.getOAuthSession(sessionId);
      if (!session?.clientId || !session.redirectUri) return null;

      const client = await this.oauthStore.getClient(session.clientId);

      let redirectHost = session.redirectUri;
      try {
        redirectHost = new URL(session.redirectUri).host || session.redirectUri;
      } catch {
        // Keep the raw value if it does not parse as a URL.
      }

      const scopeText = session.scope
        ? session.scope
        : "Access to your organization's MCP tools and connected servers.";

      return {
        clientName: client?.client_name || session.clientId,
        redirectUri: session.redirectUri,
        redirectHost,
        scopeText,
      };
    } catch (e) {
      this.logger.warn('Failed to load OAuth consent context', e as Error);
      return null;
    }
  }

  private verifyCsrf(req: Request, formToken: unknown): boolean {
    const cookieToken = (req as Request & { signedCookies?: Record<string, unknown> })
      .signedCookies?.login_csrf;
    if (typeof cookieToken !== 'string' || typeof formToken !== 'string') {
      return false;
    }
    const a = Buffer.from(cookieToken);
    const b = Buffer.from(formToken);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private isSecureRequest(req: Request): boolean {
    return (
      req.secure ||
      req.headers['x-forwarded-proto'] === 'https' ||
      this.configService.get<string>('NODE_ENV') === 'production'
    );
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
    return (
      this.configService.get<string>('SERVER_URL') || 'http://localhost:4000'
    );
  }

  private renderLoginPage(params: {
    error: string | undefined;
    serverName: string;
    consent: ConsentContext | null;
    csrfToken: string;
  }): string {
    const { error, serverName, consent, csrfToken } = params;

    const errorHtml = error
      ? `<div class="error">${this.escapeHtml(error)}</div>`
      : '';

    const consentHtml = consent
      ? `
    <div class="consent">
      <p class="consent-lead">An application is requesting access to your
        <strong>${this.escapeHtml(serverName)}</strong> account:</p>
      <div class="consent-app">${this.escapeHtml(consent.clientName)}</div>
      <p class="consent-redirect">After you sign in, your access will be sent to:</p>
      <div class="consent-host">${this.escapeHtml(consent.redirectHost)}</div>
      <p class="consent-scope">${this.escapeHtml(consent.scopeText)}</p>
      <p class="consent-warn">Only continue if you started this and recognise the
        destination above. If you did not, choose <strong>Cancel</strong>.</p>
    </div>`
      : '';

    const denyButton = consent
      ? `<button type="submit" name="action" value="deny" formnovalidate class="secondary">Cancel</button>`
      : '';

    const submitLabel = consent ? 'Sign In &amp; Authorize' : 'Sign In';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign In — ${this.escapeHtml(serverName)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      color: #333;
      padding: 20px;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.08);
      padding: 40px;
      width: 100%;
      max-width: 400px;
    }
    h1 {
      font-size: 1.5rem;
      margin-bottom: 8px;
      text-align: center;
    }
    .subtitle {
      color: #666;
      text-align: center;
      margin-bottom: 24px;
      font-size: 0.9rem;
    }
    .error {
      background: #fef2f2;
      color: #dc2626;
      border: 1px solid #fecaca;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 16px;
      font-size: 0.875rem;
    }
    .consent {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 20px;
      font-size: 0.875rem;
    }
    .consent-lead { color: #555; margin-bottom: 8px; }
    .consent-app {
      font-weight: 600;
      font-size: 1rem;
      color: #111;
      margin-bottom: 12px;
    }
    .consent-redirect { color: #555; margin-bottom: 4px; }
    .consent-host {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-weight: 600;
      color: #b45309;
      word-break: break-all;
      margin-bottom: 12px;
    }
    .consent-scope { color: #666; font-size: 0.8rem; margin-bottom: 12px; }
    .consent-warn { color: #92400e; font-size: 0.8rem; }
    label {
      display: block;
      font-size: 0.875rem;
      font-weight: 500;
      margin-bottom: 6px;
      color: #555;
    }
    input[type="email"],
    input[type="password"] {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #ddd;
      border-radius: 8px;
      font-size: 1rem;
      margin-bottom: 16px;
      transition: border-color 0.2s;
    }
    input:focus {
      outline: none;
      border-color: #2563eb;
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
    }
    button {
      width: 100%;
      padding: 12px;
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: #1d4ed8; }
    button:active { background: #1e40af; }
    button.secondary {
      background: transparent;
      color: #64748b;
      margin-top: 8px;
    }
    button.secondary:hover { background: #f1f5f9; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign In</h1>
    <p class="subtitle">Authorize access to ${this.escapeHtml(serverName)} MCP Server</p>
    ${errorHtml}
    ${consentHtml}
    <form method="POST" action="/auth/login">
      <input type="hidden" name="csrf" value="${this.escapeHtml(csrfToken)}">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required autofocus placeholder="you@example.com">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required placeholder="Your password">
      <button type="submit" name="action" value="approve">${submitLabel}</button>
      ${denyButton}
    </form>
  </div>
</body>
</html>`;
  }

  private renderDeniedPage(serverName: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Request Cancelled — ${this.escapeHtml(serverName)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      color: #333;
      margin: 0;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.08);
      padding: 40px;
      max-width: 400px;
      text-align: center;
    }
    h1 { font-size: 1.25rem; margin-bottom: 12px; }
    p { color: #666; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Request Cancelled</h1>
    <p>The authorization request was declined. No access was granted. You can
      safely close this window.</p>
  </div>
</body>
</html>`;
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }
}
