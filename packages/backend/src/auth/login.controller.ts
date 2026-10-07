import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Req,
  Res,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';
import {
  AuthService,
  DASHBOARD_TOKEN_USE,
  isForeignIssuedToken,
  isTokenRevoked,
} from './auth.service';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { PrismaOAuthStore } from './prisma-oauth.store';
import { SsoService } from '../identity-providers/sso.service';
import { MCP_RESOURCE_COOKIE } from './resource-indicator.middleware';
import { providerMarkSvg } from './provider-marks';
import { McpConnectionGrantService } from '../mcp-servers/mcp-connection-grant.service';
import { ProductEvents, ProductEventService } from '../audit/product-event.service';
import { LicenseGuardService } from '../license/license-guard.service';
import { TrustStatsService } from '../public-stats/trust-stats.service';
import { formatStars } from '../public-stats/trust-stats.format';
import {
  AMCP_MARK_SVG as AMCP_MARK,
  claudeMark,
  clientTilePair,
  knownClientFor,
  renderAuthPage,
  type TrustRowOptions,
} from './auth-page';

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
/**
 * The dashboard session cookie. Set by the frontend on sign-in (see
 * `auth-context.tsx`) on the same origin that proxies /auth/* here, so it
 * arrives with the top-level navigation from /authorize.
 */
const DASHBOARD_SESSION_COOKIE = 'amcp_token';

/** A user identified from a still-valid dashboard session. */
interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

interface ConsentContext {
  /** The OAuth client a connection grant would be keyed on. */
  clientId: string;
  clientName: string;
  redirectUri: string;
  redirectHost: string;
  scopeText: string;
  /** When the paused authorization expires (epoch ms), if the store says. */
  expiresAt?: number;
}

/** The longest an authorization may stay paused on the first-connector page. */
const FIRST_CONNECTOR_PAUSE_MAX_MS = 30 * 60 * 1000;

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
    @Optional() private readonly productEvents?: ProductEventService,
    @Optional() private readonly licenseGuard?: LicenseGuardService,
    @Optional() private readonly trustStats?: TrustStatsService,
  ) {}

  /** The trust row under every page of the flow. Never waits on GitHub. */
  private trust(): TrustRowOptions {
    let stars: string | null = null;
    try {
      stars = formatStars(this.trustStats?.peek().githubStars);
    } catch {
      stars = null;
    }
    return { cloud: this.deployment.isCloud(), stars };
  }

  /**
   * The name of the MCP server this client asked for (RFC 8707 `resource`),
   * for the consent text. Only for a signed-in user who belongs to that
   * server's workspace: the page is otherwise unauthenticated.
   */
  private async requestedServerName(req: Request, userId: string | undefined): Promise<string | null> {
    if (!userId) return null;
    const serverId = (req as Request & { signedCookies?: Record<string, unknown> })
      .signedCookies?.[MCP_RESOURCE_COOKIE];
    if (typeof serverId !== 'string' || !serverId) return null;
    try {
      const server = await this.prisma.mcpServerConfig.findUnique({
        where: { id: serverId },
        select: { name: true, organizationId: true },
      });
      if (!server) return null;
      const member = await this.prisma.organizationMember.findFirst({
        where: { userId, organizationId: server.organizationId, deactivatedAt: null },
        select: { userId: true },
      });
      return member ? server.name : null;
    } catch {
      return null;
    }
  }

  @Get('login')
  async showLoginPage(
    @Query('error') error: string,
    @Query('switch') switchAccount: string,
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

    // Already signed in to the dashboard in this browser? Then the consent
    // screen only needs an explicit "Approve", not the password again. Only
    // inside an authorize flow, and never when the user asked to switch
    // accounts.
    const sessionUser =
      consent && switchAccount !== '1'
        ? await this.resolveDashboardSession(req)
        : null;

    const ssoProviders = sessionUser ? [] : await this.loadSsoProviders(req);
    const requestedServer = consent
      ? await this.requestedServerName(req, sessionUser?.id)
      : null;

    res.setHeader('Content-Type', 'text/html');
    // A one-click Approve is exactly what clickjacking wants: never framed.
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.send(
      this.renderLoginPage({
        error,
        serverName,
        consent,
        csrfToken,
        ssoProviders,
        sessionUser,
        requestedServer,
      }),
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

    // "Approve as <signed-in user>". Nothing from the form is trusted: the
    // identity is re-derived from the session cookie, with every check the
    // dashboard API applies, and only inside an authorize flow.
    if (body.action === 'approve-session') {
      const consent = await this.loadConsentContext(req);
      const sessionUser = consent
        ? await this.resolveDashboardSession(req)
        : null;
      if (!sessionUser) {
        return res.redirect(
          `/auth/login?switch=1&error=${encodeURIComponent('Your session has expired. Please sign in.')}`,
        );
      }
      this.logger.log(`Authorization approved from dashboard session: ${sessionUser.email}`);
      return this.completeSignIn(req, res, sessionUser);
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

    return this.completeSignIn(req, res, user);
  }

  /**
   * The identity is settled (password or dashboard session): hand it to the
   * OAuth callback, after asking which servers the client may reach.
   */
  private async completeSignIn(
    req: Request,
    res: Response,
    user: SessionUser,
  ): Promise<void> {
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
    if (await this.maybeOfferFirstConnector(req, res, user.id, encoded, `${baseUrl}/callback`)) return;
    res.redirect(`${baseUrl}/callback`);
  }

  /**
   * Cloud only: a user who connects an AI client to a workspace with no
   * connectors lands back in the chat with nothing to use. 146 of the first
   * 428 sign-ups from the Claude directory did exactly that. Before handing
   * back, say so once, and show both ways forward: ask the client to set an
   * app up (the shared endpoint's setup tools), or add one in a new tab.
   *
   * The OAuth flow is only paused: "Continue" goes to the same callback, and
   * the short-lived login cookie is renewed so a detour does not expire it.
   * Returns true when it has rendered the page.
   */
  private async maybeOfferFirstConnector(
    req: Request,
    res: Response,
    userId: string,
    encodedProfile: string,
    callbackUrl: string,
  ): Promise<boolean> {
    if (!this.deployment.isCloud()) return false;
    const consent = await this.loadConsentContext(req);
    if (!consent) return false;
    // A client connecting one server's own URL does not get the setup tools
    // (they live on the shared endpoint), so the advice would not hold.
    const requestedServerId = (req as Request & { signedCookies?: Record<string, unknown> })
      .signedCookies?.[MCP_RESOURCE_COOKIE];
    if (typeof requestedServerId === 'string' && requestedServerId) return false;
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { organizationId: true },
    });
    const organizationId = account?.organizationId;
    if (!organizationId) return false;
    const [member, connectors] = await Promise.all([
      this.prisma.organizationMember.findFirst({
        where: { userId, organizationId, deactivatedAt: null },
        select: { role: true },
      }),
      this.prisma.connector.count({ where: { organizationId } }),
    ]);
    if (connectors > 0 || (member?.role !== 'ADMIN' && member?.role !== 'EDITOR')) return false;

    // The login cookie lives as long as the authorization it finishes (30
    // minutes from /authorize), so "Continue" still works after a detour to
    // add an app or a card in another tab. Longer would not help: the
    // authorization itself would be gone.
    const isSecure = this.isSecureRequest(req);
    const pauseMs = consent.expiresAt
      ? Math.min(FIRST_CONNECTOR_PAUSE_MAX_MS, Math.max(60 * 1000, consent.expiresAt - Date.now()))
      : 15 * 60 * 1000;
    res.cookie('login_user', encodedProfile, {
      httpOnly: true,
      secure: isSecure,
      maxAge: pauseMs,
      sameSite: isSecure ? 'none' : 'lax',
      signed: true,
    });

    // An admin on the free trial is told when it ends and that a card keeps
    // the workspace running, as a small line under "Continue". Never before
    // Approve: a payment step there halved the connections (#842, #843).
    const trial =
      member?.role === 'ADMIN'
        ? await this.licenseGuard?.getTrialState(organizationId).catch(() => null)
        : null;
    const trialEndsAt = trial?.active && trial.cardTrialAvailable ? trial.endsAt : null;

    await this.productEvents
      ?.log({
        event: ProductEvents.EMPTY_WORKSPACE_PROMPT,
        userId,
        organizationId,
        metadata: { client: consent.clientName, ...(trialEndsAt ? { cardTrialOffered: true } : {}) },
      })
      .catch(() => undefined);

    const dashboard = (this.configService.get<string>('FRONTEND_URL') || '').replace(/\/+$/, '');
    res.setHeader('Content-Type', 'text/html');
    res.send(
      this.renderFirstConnectorOffer({
        clientName: consent.clientName,
        redirectHost: consent.redirectHost,
        callbackUrl,
        welcomeUrl: `${dashboard}/welcome`,
        ...(trialEndsAt ? { cardTrial: { endsAt: trialEndsAt, url: `${dashboard}/start-trial` } } : {}),
      }),
    );
    return true;
  }

  private renderFirstConnectorOffer(params: {
    clientName: string;
    redirectHost?: string;
    callbackUrl: string;
    welcomeUrl: string;
    cardTrial?: { endsAt: Date; url: string };
  }): string {
    const client = this.escapeHtml(params.clientName);
    // "October 13", kept on one line.
    const trialEnd = params.cardTrial
      ? this.escapeHtml(
          params.cardTrial.endsAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }),
        ).replace(' ', '&nbsp;')
      : '';
    const card = `
    ${clientTilePair(params.clientName, params.redirectHost ?? '')}
    <h1>${client} is connected</h1>
    <p class="sub">Your workspace has no apps yet, so ${client} has nothing to work with. You can add them right in the chat. For example, ask:</p>
    <div class="example">“Connect my Etsy shop to AnythingMCP.”</div>
    <p class="body">${client} finds the connector and sets it up with you. Passwords and keys are never typed into the chat: you get a link to enter them here.</p>
    <a class="button" href="${this.escapeHtml(params.callbackUrl)}">Continue to ${client}</a>
    <p class="links"><a href="${this.escapeHtml(params.welcomeUrl)}" target="_blank" rel="noopener noreferrer">Or add an app here first (new tab)</a></p>${
      params.cardTrial
        ? `
    <p class="trial">Your free trial runs until ${trialEnd}. To keep the workspace running after that, you can <a href="${this.escapeHtml(params.cardTrial.url)}" target="_blank" rel="noopener noreferrer">add a card now (new tab)</a>. Nothing is charged before ${trialEnd}.</p>`
        : ''
    }`;
    return renderAuthPage({
      title: `${params.clientName} is connected`,
      card,
      trust: this.trust(),
      extraStyles: `
  .example { background: var(--surface-2); border-radius: 10px; padding: 12px 14px; font-size: 14px; margin: 0 0 14px; }
  .body { color: var(--text-2); font-size: 14px; line-height: 1.5; margin: 0 0 18px; }
  .trial { font-size: 13px; color: var(--text-2); margin: 18px 0 0; padding-top: 14px; border-top: 1px solid var(--border); line-height: 1.5; }
  .trial a { color: var(--brand); }`,
    });
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
        redirectHost: consent.redirectHost,
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
   * The user behind this browser's dashboard session, or null.
   *
   * Applies what `JwtStrategy` + `EmailVerifiedGuard` apply to the dashboard
   * API — signature and expiry, a dashboard-issued token (not an MCP token
   * signed with the same secret), not revoked, at least one active membership,
   * and a verified email in cloud — because approving here is no more than
   * the dashboard itself already lets this session do. Anything off falls
   * back to the password form rather than erroring.
   */
  private async resolveDashboardSession(
    req: Request,
  ): Promise<SessionUser | null> {
    const token = req.cookies?.[DASHBOARD_SESSION_COOKIE];
    if (typeof token !== 'string' || !token) return null;

    let payload: ReturnType<AuthService['verifyToken']>;
    try {
      payload = this.authService.verifyToken(token);
    } catch {
      return null;
    }
    if (
      !payload?.sub ||
      payload.tokenUse !== DASHBOARD_TOKEN_USE ||
      isForeignIssuedToken(payload as unknown as Record<string, unknown>)
    ) {
      return null;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        name: true,
        emailVerified: true,
        sessionsValidFrom: true,
        memberships: {
          where: { deactivatedAt: null },
          select: { organizationId: true },
          take: 1,
        },
      },
    });
    if (!user) return null;
    if (isTokenRevoked(payload, user.sessionsValidFrom)) return null;
    if (user.memberships.length === 0) return null;
    if (this.deployment.isCloud() && !user.emailVerified) return null;

    return { id: user.id, email: user.email, name: user.name };
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
        ...(typeof session.expiresAt === 'number' ? { expiresAt: session.expiresAt } : {}),
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
  ): Promise<{ id: string; name: string; type: string }[]> {
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
        select: { id: true, name: true, type: true },
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
    redirectHost?: string;
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
            <label class="pick">
              <input type="checkbox" name="servers" value="${this.escapeHtml(srv.id)}" />
              <span class="pick-name">${this.escapeHtml(srv.name)}</span>
              <span class="pick-meta">${srv.connectorCount} connector${srv.connectorCount === 1 ? '' : 's'}</span>
            </label>`,
          )
          .join('');
        const whole = `
            <label class="pick whole">
              <input type="radio" name="workspace" value="${this.escapeHtml(t.organizationId)}" />
              <span class="pick-name">Everything in this workspace<span class="pick-sub">including connectors not on a server</span></span>
            </label>`;
        return `
        <fieldset>
          <legend>${this.escapeHtml(t.organizationName)}</legend>
          ${servers}${whole}
        </fieldset>`;
      })
      .join('');

    const card = `
    ${clientTilePair(clientName, params.redirectHost ?? '')}
    <h1>Choose what to connect</h1>
    <p class="sub"><strong>${this.escapeHtml(clientName)}</strong> will be able to use the tools from whatever you pick here, as far as your role allows, and nothing else.</p>
    <form method="POST" action="/auth/select-servers">
      <input type="hidden" name="csrf" value="${this.escapeHtml(csrfToken)}" />
      ${groups}
      <button type="submit">Connect</button>
    </form>
    <p class="note">You can change this later from Settings, without reconnecting.</p>`;

    return renderAuthPage({
      title: 'Choose what to connect',
      card,
      trust: this.trust(),
      extraStyles: `
  .sub strong { color: var(--text); font-weight: 600; }
  fieldset { border: 1px solid var(--border); border-radius: 12px; margin: 0 0 14px; padding: 8px 10px 10px; min-width: 0; }
  legend { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--text-3); padding: 0 4px; overflow-wrap: anywhere; }
  .pick { display: flex; align-items: center; gap: 10px; padding: 9px 6px; border-radius: 8px; cursor: pointer; margin: 0; font-weight: 400; }
  .pick:hover { background: var(--surface-2); }
  .pick input { accent-color: var(--brand); width: 16px; height: 16px; flex: none; }
  .pick-name { flex: 1; font-size: 14px; overflow-wrap: anywhere; }
  .pick-meta { font-size: 12px; color: var(--text-3); text-align: right; white-space: nowrap; }
  .pick-sub { display: block; font-size: 12px; color: var(--text-3); margin-top: 2px; }
  .whole { border-top: 1px solid var(--border); margin-top: 6px; padding-top: 12px; border-radius: 0 0 8px 8px; }
  form button { margin-top: 4px; }`,
    });
  }

  private renderLoginPage(params: {
    error: string | undefined;
    serverName: string;
    consent: ConsentContext | null;
    csrfToken: string;
    ssoProviders: { id: string; name: string; type: string }[];
    sessionUser?: SessionUser | null;
    /** The MCP server the client asked for, when the signed-in user may see its name. */
    requestedServer?: string | null;
  }): string {
    const { error, serverName, consent, csrfToken, ssoProviders, sessionUser, requestedServer } =
      params;
    const server = this.escapeHtml(serverName);
    const client = consent ? this.escapeHtml(consent.clientName) : '';
    const known = consent ? knownClientFor(consent.redirectHost) : null;

    const errorHtml = error
      ? `<div class="error" role="alert">${this.escapeHtml(error)}</div>`
      : '';

    // `formnovalidate` matters: without it the browser blocks the submit
    // because the still-empty email and password inputs are `required`.
    //
    // The provider mark is trusted SVG and is concatenated UNESCAPED; the
    // provider name is admin-supplied free text and MUST be escaped. They are
    // deliberately kept as two separate pieces rather than one template so
    // nobody later "fixes" the wrong half.
    const ssoHtml = ssoProviders.length
      ? ssoProviders
          .map(
            (p) =>
              `<button type="submit" name="action" value="sso:${this.escapeHtml(p.id)}" formnovalidate class="sso">` +
              providerMarkSvg(p.type) +
              `<span>${this.escapeHtml(p.name)}</span>` +
              `</button>`,
          )
          .join('') + '<div class="divider"><span>or</span></div>'
      : '';

    // The pair of tiles shows the client's logo only when the code goes back
    // to that client's own domain (see knownClientFor); otherwise its initial.
    const top = consent
      ? clientTilePair(consent.clientName, consent.redirectHost)
      : `<div class="pair"><div class="tile" title="AnythingMCP">${AMCP_MARK}</div></div>`;

    const heading = consent ? `Connect ${client} to ${server}` : 'Sign in';
    const sub = consent
      ? sessionUser
        ? `${client} will use the tools your role allows on ${server}. You stay in control and can disconnect at any time.`
        : `Sign in to let ${client} use your ${server} tools. You stay in control and can disconnect at any time.`
      : `Authorize access to ${server} MCP Server`;

    // Claude's directory lists AnythingMCP Cloud, so the badge appears only
    // there, and only when the code really goes back to Claude.
    const directoryPill =
      known === 'claude' && this.deployment.isCloud()
        ? `<div class="verified">${claudeMark(12)}<span>Listed in Anthropic&#39;s Claude Directory</span></div>`
        : '';

    const DEFAULT_SCOPE = "Access to your organization's MCP tools and connected servers.";
    const toolsLine = requestedServer
      ? `Use the tools on <b>${this.escapeHtml(requestedServer)}</b> that your role allows`
      : `Use the tools on your MCP server that your role allows`;
    // The destination is the security-relevant part: a code sent anywhere
    // else than the client the user means to connect is a stolen session.
    // Unknown destinations are shown in amber.
    const consentHtml = consent
      ? `
    <div class="consent">
      <h2>${client} will be able to</h2>
      <div class="row"><span class="ok">&#10003;</span><span>${toolsLine}</span></div>
      <div class="row"><span class="ok">&#10003;</span><span>Read your name and email address</span></div>
      <div class="row muted"><span class="no">&ndash;</span><span>It never sees your connector passwords or API keys</span></div>${
        consent.scopeText && consent.scopeText !== DEFAULT_SCOPE
          ? `
      <div class="row muted"><span class="no">&middot;</span><span>Requested scope: <span class="host">${this.escapeHtml(consent.scopeText)}</span></span></div>`
          : ''
      }
      <div class="returns${known ? '' : ' unknown'}">${sessionUser ? 'If you allow it, access' : 'After you sign in, access'} is sent to <span class="host">${this.escapeHtml(consent.redirectHost)}</span>
        <p class="warn">Only continue if you started this and recognise this destination. If you did not, choose <strong>Cancel</strong>.</p>
      </div>
    </div>`
      : '';

    const denyButton = consent
      ? `<button type="submit" name="action" value="deny" formnovalidate class="secondary">Cancel</button>`
      : '';

    const submitLabel = consent ? 'Sign in &amp; allow' : 'Sign in';

    // Someone arriving here from an AI client (e.g. the Claude directory)
    // without an account would otherwise hit a dead end: the only way off this
    // page was "Use a different account". Give them the way in. The links point
    // at the dashboard app on the same origin; sign-up is cloud-only (on
    // self-hosted, registration is closed or invite-based). Sign-up carries
    // `redirect=/auth/login`, so after verifying their email the new user
    // lands back here, still inside the pending authorization (its cookie
    // outlives the detour), and approves with one click instead of starting
    // over from their AI client.
    //
    // Most people who reach this page from an AI client have no account yet,
    // so the sign-up is a full-width button at the top of the card, above the
    // consent box: as a text link under the form it sat below the fold on a
    // phone. After a failed sign-in (that person has an account and is fixing a
    // typo) it shrinks back to the small link under the form.
    const signupHref = '/login?mode=register&amp;redirect=%2Fauth%2Flogin';
    const offerSignup = !sessionUser && this.deployment.isCloud();
    const signupHtml =
      offerSignup && !error
        ? `
    <div class="signup">
      <p class="signup-lead"><strong>New to ${server}?</strong> Create your account first.
        You come straight back here to finish connecting${consent ? ` ${client}` : ''}.</p>
      <a class="signup-btn" href="${signupHref}">Create an account</a>
    </div>
    <div class="divider"><span>Already have an account? Sign in</span></div>`
        : '';
    const preAuthLinks = sessionUser
      ? ''
      : `
      <p class="links"><a href="/forgot-password">Forgot your password?</a></p>` +
        (offerSignup && error
          ? `
      <p class="links">New to ${server}? <a href="${signupHref}">Create an account</a></p>`
          : '');

    // Allow comes before Cancel in the markup: Enter in a field submits the
    // first button. CSS puts Cancel on the left.
    const buttons = (approve: string) =>
      denyButton ? `<div class="btns">${approve}${denyButton}</div>` : approve;

    // Signed in to the dashboard already: approve as that account, or switch.
    // `switch=1` keeps the pending OAuth session (it lives in a cookie) and
    // shows the password form instead.
    const formHtml = sessionUser
      ? `
      <div class="acct"><span>Signed in as <strong>${this.escapeHtml(sessionUser.email)}</strong></span><a href="/auth/login?switch=1">Switch account</a></div>
      ${buttons('<button type="submit" name="action" value="approve-session" autofocus>Allow access</button>')}`
      : `
      ${ssoHtml}
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required autofocus autocomplete="email" placeholder="you@company.com">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password" placeholder="Your password">
      ${buttons(`<button type="submit" name="action" value="approve">${submitLabel}</button>`)}
      ${preAuthLinks}`;

    const card = `
    ${top}
    <h1>${heading}</h1>
    <p class="sub">${sub}</p>${directoryPill}${signupHtml}
    ${errorHtml}
    ${consentHtml}
    <form method="POST" action="/auth/login">
      <input type="hidden" name="csrf" value="${this.escapeHtml(csrfToken)}">${formHtml}
    </form>`;

    return renderAuthPage({
      title: `${sessionUser ? 'Authorize' : 'Sign In'} — ${serverName}`,
      card,
      trust: this.trust(),
    });
  }

  private renderDeniedPage(serverName: string): string {
    return renderAuthPage({
      title: `Request Cancelled — ${serverName}`,
      card: `
    <div class="pair"><div class="tile" title="AnythingMCP">${AMCP_MARK}</div></div>
    <h1>Request Cancelled</h1>
    <p class="sub" style="margin-bottom:0">The authorization request was declined. No access was granted. You can safely close this window.</p>`,
      trust: this.trust(),
    });
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
