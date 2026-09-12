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
import { DeploymentService } from '../common/deployment.service';
import { PrismaOAuthStore } from './prisma-oauth.store';
import { SsoService } from '../identity-providers/sso.service';
import { MCP_RESOURCE_COOKIE } from './resource-indicator.middleware';
import { McpConnectionGrantService } from '../mcp-servers/mcp-connection-grant.service';

/**
 * Carries the VERIFIED identity across the second step of the authorize flow.
 * Signed and httpOnly, so the server-selection submission cannot claim to be
 * somebody else.
 */
const PENDING_GRANT_COOKIE = 'pending_grant';

/**
 * Context describing the OAuth client that initiated the current authorize
 * flow. Rendered on the login page so the user can see — and thereby approve —
 * exactly which client and callback destination they are authorizing before
 * they submit their credentials.
 */
interface ConsentContext {
  /** The OAuth client a connection grant would be keyed on. */
  clientId: string;
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
    private readonly sso: SsoService,
    private readonly deployment: DeploymentService,
    private readonly grants: McpConnectionGrantService,
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

    const ssoProviders = await this.loadSsoProviders(req);

    res.setHeader('Content-Type', 'text/html');
    res.send(
      this.renderLoginPage({ error, serverName, consent, csrfToken, ssoProviders }),
    );
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

    // "Sign in with <provider>" is a submit button on the same form, so it
    // arrives here having already passed the CSRF check above rather than as a
    // bare GET that any page could trigger.
    if (body.action?.startsWith('sso:')) {
      const providerId = body.action.slice(4);
      const oauthSessionId = req.cookies?.oauth_session;
      try {
        const { authorizationUrl } = await this.sso.startMcp(
          providerId,
          oauthSessionId,
        );
        res.clearCookie('login_csrf');
        return res.redirect(authorizationUrl);
      } catch (error: any) {
        this.logger.warn(`MCP SSO start failed: ${error?.reason ?? error}`);
        return res.redirect(
          `/auth/login?error=${encodeURIComponent('Single sign-on is unavailable. Please contact your administrator.')}`,
        );
      }
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

    // SSO-only account: this consent page has its own bcrypt path, so the gate
    // in POST /api/auth/login does not cover it. Without this, an SSO-enforced
    // user could still authorize an AI client with a password — bypassing the
    // IdP's MFA and Conditional Access on exactly the surface that matters.
    if (user.passwordLoginDisabled) {
      this.logger.warn(`Password login refused for SSO-only account: ${email}`);
      return res.redirect(
        `/auth/login?error=${encodeURIComponent('Password sign-in is disabled for this account. Use your organization sign-in.')}`,
      );
    }

    // Nullable for IdP-provisioned users — never hand null to bcrypt.
    if (!user.passwordHash) {
      this.logger.warn(`Login attempt for passwordless account: ${email}`);
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

    // Between "who you are" and "what this client may reach". Returns true when
    // it has taken over the response with the picker.
    if (await this.maybeAskWhichServers(req, res, user.id)) return;

    // Derive callback URL from the request origin (works behind proxy/tunnel)
    const baseUrl = this.getBaseUrl(req);
    res.redirect(`${baseUrl}/callback`);
  }

  /**
   * Decide what this client may reach, asking the user only when there is
   * genuinely something to ask.
   *
   * Returns true when it has taken over the response — i.e. the picker is being
   * shown and the OAuth flow is paused until the user submits it.
   *
   * The shape of the answer is dictated by what workspaces actually look like:
   * 1318 of 1393 on the cloud instance have exactly one MCP server, and all but
   * four users belong to a single workspace. Putting a screen in front of
   * everyone to serve the remaining handful would add a step to the flow this
   * whole piece of work exists to shorten, so a single candidate is granted
   * silently and nothing is shown.
   */
  private async maybeAskWhichServers(
    req: Request,
    res: Response,
    userId: string,
  ): Promise<boolean> {
    const consent = await this.loadConsentContext(req);
    // Not an authorize flow — a bare visit to the login page. Nothing to grant.
    if (!consent) return false;

    // The client asked for one specific server via RFC 8707. It has already
    // said what it wants; asking again would be noise. Still goes through
    // grantServers, which drops an id this user cannot reach.
    const requestedServerId = (req as Request & { signedCookies?: Record<string, unknown> })
      .signedCookies?.[MCP_RESOURCE_COOKIE];
    if (typeof requestedServerId === 'string' && requestedServerId) {
      await this.grants.grantServers(consent.clientId, userId, [requestedServerId]);
      return false;
    }

    const targets = await this.grants.listSelectableTargets(userId);
    const servers = targets.flatMap((t) => t.servers);

    // Nothing to choose between: one server, or one workspace whose servers are
    // the only thing on offer. Grant it and carry on without a screen.
    if (servers.length <= 1) {
      if (servers.length === 1) {
        await this.grants.grantServers(consent.clientId, userId, [servers[0].id]);
      } else if (targets.length === 1) {
        // No servers yet — grant the workspace, so a server created later is
        // picked up without having to reconnect.
        await this.grants.grantWholeOrganization(
          consent.clientId,
          userId,
          targets[0].organizationId,
        );
      }
      return false;
    }

    // More than one. Hold the verified identity in a signed, httpOnly cookie
    // rather than a form field, so the submission cannot claim to be someone
    // else, and issue a fresh CSRF token for the picker form.
    const isSecure = this.isSecureRequest(req);
    res.cookie(PENDING_GRANT_COOKIE, userId, {
      httpOnly: true,
      secure: isSecure,
      maxAge: 10 * 60 * 1000,
      sameSite: isSecure ? 'none' : 'lax',
      signed: true,
    });
    const csrfToken = randomBytes(32).toString('base64url');
    res.cookie('login_csrf', csrfToken, {
      httpOnly: true,
      secure: isSecure,
      maxAge: 10 * 60 * 1000,
      sameSite: isSecure ? 'none' : 'lax',
      signed: true,
    });

    res.setHeader('Content-Type', 'text/html');
    res.send(
      this.renderServerPicker({
        clientName: consent.clientName,
        targets,
        csrfToken,
      }),
    );
    return true;
  }

  /**
   * Second step of the authorize flow: which servers this client may reach.
   *
   * Nothing here is trusted. The identity comes from the signed cookie, not the
   * form; and the ids that do come from the form go through `grantServers`,
   * which resolves each one's owning organization from the database and drops
   * anything this user is not a member of. A tampered submission can therefore
   * only ever produce a NARROWER grant than the user was entitled to, never a
   * wider one.
   */
  @Post('select-servers')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async handleServerSelection(
    @Req() req: Request,
    @Body() body: { servers?: string | string[]; workspace?: string; csrf?: string },
    @Res() res: Response,
  ) {
    if (!this.verifyCsrf(req, body.csrf)) {
      this.logger.warn('Rejected server selection with missing/invalid CSRF token');
      res.clearCookie('login_csrf');
      return res.redirect(
        `/auth/login?error=${encodeURIComponent('Your session expired. Please try again.')}`,
      );
    }

    const userId = (req as Request & { signedCookies?: Record<string, unknown> })
      .signedCookies?.[PENDING_GRANT_COOKIE];
    const consent = await this.loadConsentContext(req);
    if (typeof userId !== 'string' || !userId || !consent) {
      return res.redirect(
        `/auth/login?error=${encodeURIComponent('Your session expired. Please sign in again.')}`,
      );
    }

    const selected = Array.isArray(body.servers)
      ? body.servers
      : body.servers
        ? [body.servers]
        : [];

    if (body.workspace) {
      // "Everything in this workspace" — covers connectors not yet attached to
      // any server. Refused outright if the user is not a member.
      await this.grants.grantWholeOrganization(consent.clientId, userId, body.workspace);
    } else if (selected.length > 0) {
      const granted = await this.grants.grantServers(consent.clientId, userId, selected);
      if (granted.length === 0) {
        return res.redirect(
          `/auth/login?error=${encodeURIComponent('None of the selected servers are available to you. Please try again.')}`,
        );
      }
    } else {
      return res.redirect(
        `/auth/login?error=${encodeURIComponent('Choose at least one MCP server.')}`,
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true },
    });
    if (!user) {
      return res.redirect(
        `/auth/login?error=${encodeURIComponent('Your session expired. Please sign in again.')}`,
      );
    }

    const encoded = Buffer.from(
      JSON.stringify({ id: user.id, email: user.email, name: user.name, username: user.email }),
    ).toString('base64url');
    const isSecure = this.isSecureRequest(req);
    res.cookie('login_user', encoded, {
      httpOnly: true,
      secure: isSecure,
      maxAge: 60 * 1000,
      sameSite: isSecure ? 'none' : 'lax',
      signed: true,
    });
    res.clearCookie('login_csrf');
    res.clearCookie(PENDING_GRANT_COOKIE);

    res.redirect(`${this.getBaseUrl(req)}/callback`);
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
        clientId: session.clientId,
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

  /**
   * The identity providers offered on this page.
   *
   * Scoped to the ONE workspace this authorization is for, resolved from the
   * `mcp_resource` cookie that `ResourceIndicatorMiddleware` captured from the
   * client's RFC 8707 `resource` parameter at /authorize.
   *
   * Deliberately not "every active provider": this page is unauthenticated, so
   * an unscoped list would let anyone read off every customer's workspace and
   * directory — the same enumeration oracle that keeps the provider list off
   * /health/server-info in cloud. Scoping to the resource leaks nothing,
   * because reaching here already required that tenant's own server id.
   *
   * Returns nothing when the client sent no `resource`, which leaves the page
   * exactly as it is today: password only.
   */
  private async loadSsoProviders(
    req: Request,
  ): Promise<{ id: string; name: string }[]> {
    // SIGNED cookie, so it lives in `signedCookies` — reading `req.cookies`
    // here silently yields undefined and the buttons never render.
    // Self-hosted only, like the rest of SSO. Cloud has no providers to find,
    // so this would return an empty list anyway — but saying so here means the
    // MCP authorization page never queries for them.
    if (this.deployment.isCloud()) return [];

    const serverId = (req as any).signedCookies?.[MCP_RESOURCE_COOKIE];
    if (!serverId) return [];
    try {
      const server = await this.prisma.mcpServerConfig.findUnique({
        where: { id: serverId },
        select: { organizationId: true },
      });
      if (!server?.organizationId) return [];
      return await this.prisma.identityProvider.findMany({
        where: { organizationId: server.organizationId, isActive: true },
        select: { id: true, name: true },
        orderBy: { createdAt: 'asc' },
      });
    } catch (error: any) {
      // Never let this break the password path — it is only an extra option.
      this.logger.warn(`Could not load SSO providers: ${error?.message}`);
      return [];
    }
  }

  /**
   * The second step: which MCP servers this client may reach.
   *
   * Only ever rendered when there is more than one candidate — see
   * {@link maybeAskWhichServers}. Servers are grouped by workspace because that
   * is how people think about them, and each workspace carries an "everything"
   * option so connectors not yet attached to a server are still reachable.
   */
  private renderServerPicker(params: {
    clientName: string;
    targets: {
      organizationId: string;
      organizationName: string;
      servers: { id: string; name: string; connectorCount: number }[];
    }[];
    csrfToken: string;
  }): string {
    const { clientName, targets, csrfToken } = params;

    const groups = targets
      .map((t) => {
        const servers = t.servers
          .map(
            (srv) => `
            <label class="row">
              <input type="checkbox" name="servers" value="${this.escapeHtml(srv.id)}" />
              <span class="row-name">${this.escapeHtml(srv.name)}</span>
              <span class="row-meta">${srv.connectorCount} connector${srv.connectorCount === 1 ? '' : 's'}</span>
            </label>`,
          )
          .join('');
        const whole = `
            <label class="row whole">
              <input type="radio" name="workspace" value="${this.escapeHtml(t.organizationId)}" />
              <span class="row-name">Everything in this workspace</span>
              <span class="row-meta">including connectors not on a server</span>
            </label>`;
        return `
        <fieldset>
          <legend>${this.escapeHtml(t.organizationName)}</legend>
          ${servers}${whole}
        </fieldset>`;
      })
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Choose what to connect</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #f5f6f8; margin: 0; padding: 40px 16px; color: #111; }
    .card { max-width: 460px; margin: 0 auto; background: #fff; border-radius: 12px;
            padding: 28px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    h1 { font-size: 19px; margin: 0 0 6px; }
    p.lead { color: #555; font-size: 14px; margin: 0 0 20px; }
    .app { font-weight: 600; }
    fieldset { border: 1px solid #e3e5e8; border-radius: 9px; margin: 0 0 14px; padding: 10px 12px 12px; }
    legend { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; padding: 0 4px; }
    .row { display: flex; align-items: center; gap: 10px; padding: 8px 4px; border-radius: 7px; cursor: pointer; }
    .row:hover { background: #f7f8fa; }
    .row-name { flex: 1; font-size: 14px; }
    .row-meta { font-size: 12px; color: #8a8f98; }
    .whole { border-top: 1px solid #eef0f2; margin-top: 6px; padding-top: 12px; }
    button { width: 100%; padding: 11px; font-size: 15px; font-weight: 600; color: #fff;
             background: #2563eb; border: 0; border-radius: 8px; cursor: pointer; margin-top: 6px; }
    button:hover { background: #1d4ed8; }
    .note { font-size: 12px; color: #8a8f98; margin-top: 14px; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Choose what to connect</h1>
    <p class="lead"><span class="app">${this.escapeHtml(clientName)}</span> will be able to use
      the tools from whatever you pick here — and nothing else.</p>
    <form method="POST" action="/auth/select-servers">
      <input type="hidden" name="csrf" value="${this.escapeHtml(csrfToken)}" />
      ${groups}
      <button type="submit">Connect</button>
    </form>
    <p class="note">You can change this later from Settings, without reconnecting.</p>
  </div>
</body>
</html>`;
  }

  private renderLoginPage(params: {
    error: string | undefined;
    serverName: string;
    consent: ConsentContext | null;
    csrfToken: string;
    ssoProviders: { id: string; name: string }[];
  }): string {
    const { error, serverName, consent, csrfToken, ssoProviders } = params;

    const errorHtml = error
      ? `<div class="error">${this.escapeHtml(error)}</div>`
      : '';

    // `formnovalidate` matters: without it the browser blocks the submit
    // because the still-empty email and password inputs are `required`.
    const ssoHtml = ssoProviders.length
      ? ssoProviders
          .map(
            (p) =>
              `<button type="submit" name="action" value="sso:${this.escapeHtml(p.id)}" formnovalidate class="sso">${this.escapeHtml(p.name)}</button>`,
          )
          .join('') + '<div class="divider"><span>or</span></div>'
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
    button.sso {
      background: #fff;
      color: #0f172a;
      border: 1px solid #cbd5e1;
      margin-bottom: 4px;
    }
    button.sso:hover { background: #f8fafc; }
    .divider {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 14px 0 4px;
      color: #94a3b8;
      font-size: 12px;
    }
    .divider::before, .divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: #e2e8f0;
    }
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
      ${ssoHtml}
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
