import {
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  Post,
  Query,
  Param,
  Body,
  Req,
  Res,
  Logger,
  Optional,
  UseFilters,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { AuthService } from './auth.service';
import { PrismaService } from '../common/prisma.service';
import { resolveDashboardSessionUser, type SessionUser } from './dashboard-session.util';
import { DeploymentService } from '../common/deployment.service';
import { findUserByEmail } from '../common/email.util';
import type { User } from '../generated/prisma/client';
import { PrismaOAuthStore } from './prisma-oauth.store';
import { SsoService } from '../identity-providers/sso.service';
import {
  MCP_APP_COOKIE,
  MCP_DIRECTORY_COOKIE,
  MCP_RESOURCE_COOKIE,
  type DirectoryPluginEndpoint,
} from './resource-indicator.middleware';
import { serverReachability } from './server-reachability.util';
import { markDirectorySignup } from '../audit/directory-signup';
import { providerMarkSvg } from './provider-marks';
import { McpConnectionGrantService } from '../mcp-servers/mcp-connection-grant.service';
import { ProductEvents, ProductEventService } from '../audit/product-event.service';
import { LicenseGuardService } from '../license/license-guard.service';
import { CardTrialEligibilityService } from '../license/card-trial-eligibility.service';
import { POST_APPROVE_SOURCE } from '../license/license-checkout';
import { SOCIAL_BIND_COOKIE, SocialAuthError, SocialAuthService } from './social/social-auth.service';
import { setSocialBindCookie } from './social/social-auth.controller';
import {
  AMCP_MARK_SVG as AMCP_MARK,
  clientTilePair,
  knownClientFor,
  renderAuthPage,
  renderClosedRequestPage,
  directoryBadgeHtml,
  directoryBadgesFor,
  signupClientFor,
  type TrustRowOptions,
} from './auth-page';
import { maskEmail } from './mcp-email-verification';
import { hasDashboardHeader, setRecentSignInCookie } from './recent-sign-in.util';
import { RecentSignInService } from './recent-sign-in.service';
import { EmailVerificationService, MAX_CODES_PER_HOUR, VERIFICATION_CODE_TTL_MS } from './email-verification.service';
import {
  SharedSetupRegistry,
  type SetupCallResult,
  type SetupContext,
  type SharedSetupProvider,
} from '../mcp-server/shared-setup';
import { assistantForRedirectUris, profileForRedirectUris } from '../mcp-server/shared-toolset';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import {
  TELEGRAM_CONNECTED_REQUEST,
  TELEGRAM_ONE_TAP,
  TELEGRAM_SLUG,
  type TelegramOneTap,
} from '../adapters/telegram-managed-bot';
import { fill, signInTexts } from './auth-page-i18n';
import { boundLoginUser, clearLoginUserCookie, setLoginUserCookie } from './login-user-cookie';
import { AuthPageThrottleFilter } from './auth-page-throttle.filter';
import {
  attemptKey,
  connectedPageArm,
  CONNECTED_PAGE_TEST_ENV,
  pageLanguageFor,
  signInPageArm,
  SIGNIN_PAGE_TEST_ENV,
  type SignInPageArm,
  type PageLanguage,
  deviceOf,
  isPhoneUserAgent,
  languageBucket,
  type ConnectedPageArm,
} from './authorization-attempt';
import {
  TELEGRAM_PANEL_SCRIPT,
  TELEGRAM_PANEL_STYLES,
  TELEGRAM_PICK_HOOK,
  telegramPanelHtml,
  telegramQrDataUri,
} from './first-app-telegram';

/**
 * Carries the VERIFIED identity across the second step of the authorize flow.
 * Signed and httpOnly, so the server-selection submission cannot claim to be
 * somebody else.
 */
const PENDING_GRANT_COOKIE = 'pending_grant';

/**
 * The social provider (Google, Microsoft, GitHub) the user signed in with on
 * the login page, carried across the server picker so the first-connector
 * page after it can link to the dashboard the same way. Signed, and checked
 * against the enabled providers when read.
 */
const PENDING_SOCIAL_COOKIE = 'pending_grant_social';

/**
 * Cloud: the account that signed in with its password on this page but has
 * not verified its email address yet, while the page asks for the code.
 * Signed and httpOnly: the code step trusts it as "this browser proved the
 * password of this account", for as long as a code is valid.
 */
const PENDING_VERIFY_COOKIE = 'pending_verify';

/** CSRF token of the code step's form (double submit, like `login_csrf`). */
const VERIFY_CSRF_COOKIE = 'verify_csrf';

/** At most one code per minute from the code step (the dashboard sign-in waits as long). */
const CODE_RESEND_INTERVAL_MS = 60 * 1000;

/** The notice when the hourly cap of codes is reached. */
const TOO_MANY_CODES =
  'You asked for many codes in the last hour: use the newest email you received, or try again later.';

/**
 * Shown on the sign-in form when the account just used is not a member of the
 * workspace that owns the MCP server the client asked for. The server is not
 * named: the person may not belong to its workspace.
 */
export const WRONG_WORKSPACE_MESSAGE =
  'The MCP server you are connecting belongs to another workspace, and this account is not a member of it. ' +
  'Sign in with an account of that workspace, or ask its admin to invite you. ' +
  'If you do not need this connection, remove it from your AI client.';

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
  /** When the paused authorization expires (epoch ms), if the store says. */
  expiresAt?: number;
  /**
   * The arm of the test of the page shown to an empty workspace, for this
   * pending authorization (authorization-attempt.ts). Null when the test
   * does not run: the page is then the control, and no arm is recorded.
   */
  connectedArm: ConnectedPageArm | null;
  /** The arm of the sign-in page test (A3/A4); null when it does not run. */
  signinArm: SignInPageArm | null;
  /** The pending authorization's id, and the `state` the client sent with it. */
  sessionId: string;
  clientState?: string;
}

/** The longest an authorization may stay paused on the first-connector page. */
const FIRST_CONNECTOR_PAUSE_MAX_MS = 30 * 60 * 1000;

/**
 * CSRF token of the first-connector page's app picker (double submit: signed
 * cookie + the value the page sends back). Its own cookie, so it never
 * collides with the sign-in form's `login_csrf`, which is spent by then.
 */
const FIRST_APP_CSRF_COOKIE = 'first_app_csrf';

/**
 * What the page after approving needs to be shown again (GET /auth/next):
 * signed, httpOnly, as long as the pause. The page used to be the body of
 * whatever request finished the sign-in (a form post, or the provider's
 * one-time callback), so a reload, the Back button or a tab restored by a
 * phone turned it into an error. `o` workspace, `s` the provider signed in
 * with, `t` when the trial ends (card-trial button), `g` one-tap Telegram.
 */
const FIRST_OFFER_COOKIE = 'first_offer';
/** The app picked on that page (its slug), so a reload shows it as added. */
const FIRST_APP_PICKED_COOKIE = 'first_app_picked';
interface FirstOffer {
  o: string;
  s?: string;
  t?: number;
  g?: 1;
  /** The workspace's free trial has ended. */
  x?: 1;
}

/**
 * The quick-setup apps the first-connector page offers: catalog connectors
 * whose setups complete most often and that need no approval of an app by
 * the provider (an Etsy app, for one, stays pending for days). Picking one
 * only adds it as a connector waiting for its credentials; the user finishes
 * it in the chat, through the link the setup tools hand out.
 */
export const QUICK_SETUP_APPS: ReadonlyArray<{ slug: string; name: string }> = [
  // The app most people who arrive from the Claude directory ask for. It
  // takes the user's own Etsy app and Etsy's approval: the picker only adds
  // it, and the guided setup the chat links to walks through the rest.
  { slug: 'etsy', name: 'Etsy' },
  { slug: 'telegram-bot', name: 'Telegram' },
  // Shopify is not offered here: its setup needs the store's owner to create
  // an app in the Shopify Dev Dashboard (about ten minutes), and of 75 picks
  // in four weeks none ever got its keys. Asked for in the chat or added
  // from the dashboard, where people know what it takes, it works for most.
  { slug: 'woocommerce', name: 'WooCommerce' },
  { slug: 'odoo', name: 'Odoo' },
  { slug: 'printify', name: 'Printify' },
];

/** The request the first-connector page suggests typing into the chat. */
export const FIRST_CONNECTOR_EXAMPLE = 'Connect my Telegram bot to AnythingMCP.';

/** Its text once an app was picked on the page. */
export function finishSetupRequest(appName: string): string {
  return `Finish setting up my ${appName} connector.`;
}

/**
 * CSRF token of the File Search setup page's links (see
 * maybeOfferFileSearchSetup): a signed cookie, and the same value in each
 * link to the dashboard hand-off.
 */
const FILE_SEARCH_SETUP_CSRF_COOKIE = 'file_search_setup_csrf';

/**
 * How a folder can be connected, as the File Search plugin's setup page
 * offers it after "Approve": the wizard's protocols, and the products it has
 * presets for. `local` (a folder mounted into the server) only exists on a
 * self-hosted instance.
 */
export const FILE_SEARCH_SETUP_OPTIONS: ReadonlyArray<{
  id: string;
  label: string;
  hint: string;
  protocol: 'sftp' | 'ftps' | 'ftp' | 'webdav' | 's3' | 'local';
  preset?: string;
  selfHostedOnly?: boolean;
}> = [
  { id: 'sftp', label: 'SFTP', hint: 'Linux or Windows server, most NAS', protocol: 'sftp' },
  { id: 'ftps', label: 'FTPS', hint: 'FTP with TLS encryption', protocol: 'ftps' },
  { id: 'ftp', label: 'FTP', hint: 'Unencrypted, only when nothing else works', protocol: 'ftp' },
  { id: 'webdav', label: 'WebDAV', hint: 'Any WebDAV share', protocol: 'webdav' },
  { id: 'nextcloud', label: 'Nextcloud', hint: 'WebDAV', protocol: 'webdav', preset: 'nextcloud' },
  { id: 'owncloud', label: 'ownCloud', hint: 'WebDAV', protocol: 'webdav', preset: 'owncloud' },
  { id: 'synology', label: 'Synology NAS', hint: 'SFTP', protocol: 'sftp', preset: 'synology' },
  { id: 'qnap', label: 'QNAP NAS', hint: 'SFTP', protocol: 'sftp', preset: 'qnap' },
  { id: 'fritzbox', label: 'FRITZ!Box', hint: 'FTPS', protocol: 'ftps', preset: 'fritzbox' },
  { id: 'hetzner', label: 'Hetzner Storage Box', hint: 'SFTP', protocol: 'sftp', preset: 'hetzner' },
  { id: 's3', label: 'S3-compatible storage', hint: 'AWS S3, DigitalOcean Spaces, MinIO, Wasabi', protocol: 's3' },
  { id: 'local', label: 'Network folder', hint: 'A folder mounted into this server', protocol: 'local', selfHostedOnly: true },
];

/**
 * The File Search wizard for one setup option, in "back to the authorization"
 * mode: preselects the protocol and preset, and the servers this connection
 * was granted, so the new folder is reachable from the plugin at once. Built
 * here from a fixed list, never from the request.
 */
export function fileSearchWizardPathFor(optionId: string, serverIds: readonly string[]): string | null {
  const option = FILE_SEARCH_SETUP_OPTIONS.find((o) => o.id === optionId);
  if (!option) return null;
  const q = new URLSearchParams({ protocol: option.protocol });
  if (option.preset) q.set('preset', option.preset);
  q.set('from', 'authorize');
  q.set('return', 'authorize');
  const servers = serverIds.filter((id) => /^[a-z0-9]{20,40}$/i.test(id));
  if (servers.length) q.set('servers', servers.join(','));
  return `/connectors/new/file-search?${q.toString()}`;
}

// Kept here for the callers that import it from this file (authorization-attempt.ts has it now).
export { isPhoneUserAgent };

/**
 * A bcrypt hash (cost 12, as AuthService.hashPassword) of a random value that
 * was thrown away: no password matches it and no account uses it. See
 * LoginController.spendPasswordCheck.
 */
const NO_ACCOUNT_PASSWORD_HASH = '$2b$12$IiJXBx6uVaTbVBrwh5VRKe7P./mbaxLHXjX7kyOgJwdFSnENFxHSi';

/**
 * What a post of the sign-in form asks for. `password` is every post that can
 * reach the password check in handleLogin: "Sign in & allow", and anything
 * this function does not recognise. `button` is a post that handleLogin
 * answers before it looks at a password: a provider button, the single
 * sign-on button, "Allow access" with the dashboard session, and Cancel.
 */
export function loginPostKind(body: unknown): 'password' | 'button' {
  const action = (body as { action?: unknown } | null | undefined)?.action;
  if (typeof action !== 'string') return 'password';
  return action === 'deny' ||
    action === 'approve-session' ||
    action.startsWith('sso:') ||
    action.startsWith('social:')
    ? 'button'
    : 'password';
}

/**
 * Posts of the sign-in form allowed per address in a minute. Password
 * attempts keep the limit of 5 they always had. The buttons that check no
 * password used to share those 5, so one address with several people behind
 * it, or one person pressing a provider button again, was refused (127 times
 * from 16 to 22 November 2026): they are counted on their own, 30 a minute,
 * the limit of the provider's return address.
 */
export function loginPostLimit(context: ExecutionContext): number {
  return loginPostKind(context.switchToHttp().getRequest<Request>().body) === 'password' ? 5 : 30;
}

/**
 * The counter a post of the sign-in form is added to: one per address for
 * password attempts (the key the throttler builds by default, so nothing
 * changes for them) and a second one per address for the buttons. The kind
 * comes from the same function the limit uses, and a post counted as a
 * button never reaches the password check.
 */
export function loginPostThrottleKey(context: ExecutionContext, tracker: string, throttlerName: string): string {
  const kind = loginPostKind(context.switchToHttp().getRequest<Request>().body);
  const prefix = `${context.getClass().name}-${context.getHandler().name}-${throttlerName}`;
  return createHash('sha256')
    .update(kind === 'password' ? `${prefix}-${tracker}` : `${prefix}-${tracker}-button`)
    .digest('hex');
}

/**
 * What ties the sign-in form's CSRF token to the pending authorization: a
 * digest of the `oauth_session` cookie the authorize endpoint set. Null
 * outside a pending authorization.
 */
function loginCsrfBinding(req: Request): string | null {
  const sessionId = req.cookies?.oauth_session;
  if (typeof sessionId !== 'string' || !sessionId) return null;
  return createHash('sha256').update(sessionId).digest('base64url').slice(0, 22);
}

/**
 * The `login_csrf` cookie: `<token>.<binding>` when it was issued inside a
 * pending authorization, the bare token otherwise (and for cookies issued
 * before the binding existed; they live ten minutes). Tokens are base64url,
 * so the last dot is the separator.
 */
function parseLoginCsrf(cookie: unknown): { token: string; binding: string | null } | null {
  if (typeof cookie !== 'string' || !cookie) return null;
  const dot = cookie.lastIndexOf('.');
  const token = dot === -1 ? cookie : cookie.slice(0, dot);
  if (!token) return null;
  return { token, binding: dot === -1 ? null : cookie.slice(dot + 1) };
}

/**
 * Continue may be pressed once. The first press is not touched in any way
 * (see continueBeaconScript: phones were lost on this button once); a second
 * press within a few seconds is dropped, because `/callback` answers only the
 * first request and the browser would show the second answer ("no longer
 * open") although the first one went through. After five seconds the link
 * works again, for a hand-back the browser refused.
 */
export const CONTINUE_ONCE_SCRIPT = `
    (function () {
      var cont = document.getElementById('continue');
      if (!cont || !window.setTimeout) return;
      var pressed = false;
      cont.addEventListener('click', function (event) {
        if (pressed) { event.preventDefault(); return; }
        pressed = true;
        window.setTimeout(function () { pressed = false; }, 5000);
      });
    })();`;

/**
 * Reports the two ways off the page after approving that are not Continue:
 * "Or add an app here first" and "Add a payment method" (`authorize_action`
 * with button open_dashboard / payment_method). Beacons that never delay the
 * click; `attempt` is a base-36 number.
 */
export function pausedPageLinksBeaconScript(attempt: string): string {
  return `
    (function () {
      if (!navigator.sendBeacon || !window.URLSearchParams) return;
      var report = function (id, kind) {
        var link = document.getElementById(id);
        if (!link) return;
        link.addEventListener('click', function () {
          try { navigator.sendBeacon('/auth/beacon', new URLSearchParams({ e: kind, a: '${attempt}' })); } catch (e) {}
        });
      };
      report('open-dashboard', 'open_dashboard');
      report('card-trial-link', 'payment_method');
    })();`;
}

/**
 * Reports the click on "Continue" (`post_approve_continue_clicked`). Its own
 * listener, so it works where the clipboard does not. `sendBeacon` queues the
 * request and returns at once: the listener never waits, never prevents the
 * default action and opens nothing, so the browser follows the link exactly
 * as it does without it (phones were lost on this button once, see
 * renderFirstConnectorOffer). `attempt` is a base-36 number.
 */
export function continueBeaconScript(attempt: string): string {
  return `
    (function () {
      var cont = document.getElementById('continue');
      if (!cont || !navigator.sendBeacon || !window.URLSearchParams) return;
      cont.addEventListener('click', function () {
        try {
          // "Copy & continue" presses Continue for the person (data-via="copy").
          var via = cont.getAttribute && cont.getAttribute('data-via') === 'copy' ? 'copy_continue' : 'continue';
          navigator.sendBeacon('/auth/beacon', new URLSearchParams({ e: via, a: '${attempt}' }));
        } catch (e) { /* the authorization goes on regardless */ }
      });
    })();`;
}

/**
 * The 'next_step' arm only: once the one-tap Telegram bot is connected (the
 * panel sets `data-telegram="done"` on the picker), the page goes on through
 * Continue by itself: the same address as the link, in the same tab, and
 * nothing is opened. A quarter of the people who started the one-tap bot
 * never came back to press Continue (89 of 349 attempts, 16 to 21 November
 * 2026).
 *
 * It counts down five seconds first, only while the tab is visible, and
 * "Stay on this page" stops it. A click on Continue stops it too, so the
 * callback is never asked for twice.
 */
export function autoContinueScript(attempt: string): string {
  return `
    (function () {
      var picker = document.getElementById('quick-apps');
      var cont = document.getElementById('continue');
      var note = document.getElementById('auto-continue');
      var text = document.getElementById('auto-continue-text');
      var stay = document.getElementById('auto-continue-stay');
      if (!picker || !cont || !note || !text || !stay || !window.setInterval || !window.location) return;
      var target = cont.getAttribute('href');
      if (!target) return;
      var clientName = cont.getAttribute('data-client') || 'your assistant';
      var left = 5;
      var stopped = false;
      var timer = null;
      var stop = function () {
        stopped = true;
        if (timer) window.clearInterval(timer);
        timer = null;
      };
      cont.addEventListener('click', function () { stop(); });
      stay.addEventListener('click', function () {
        stop();
        text.textContent = 'Press Continue to ' + clientName + ' when you are ready.';
        stay.hidden = true;
      });
      timer = window.setInterval(function () {
        if (stopped || picker.getAttribute('data-telegram') !== 'done') return;
        // Never from a tab in the background: the person is in Telegram.
        if (document.visibilityState && document.visibilityState !== 'visible') return;
        if (left > 0) {
          text.textContent = 'Telegram is connected. Going back to ' + clientName + ' in ' + left + ' s…';
          note.hidden = false;
          left -= 1;
          return;
        }
        stop();
        try {
          if (navigator.sendBeacon && window.URLSearchParams) {
            navigator.sendBeacon('/auth/beacon', new URLSearchParams({ e: 'auto_continue', a: '${attempt}' }));
          }
        } catch (e) { /* the page goes on regardless */ }
        window.location.assign(target);
      }, 1000);
    })();`;
}

@ApiTags('MCP client sign-in')
@Controller('auth')
// A person who hits a rate limit on these pages gets a page, not JSON.
@UseFilters(AuthPageThrottleFilter)
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
    @Optional() private readonly cardTrialEligibility?: CardTrialEligibilityService,
    @Optional() private readonly social?: SocialAuthService,
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional() private readonly recentSignIn?: RecentSignInService,
    @Optional() private readonly emailVerification?: EmailVerificationService,
  ) {}

  /**
   * Connector setup (the provider behind the chat's setup tools), resolved
   * lazily: it lives in the adapters' module, which this one does not import.
   */
  private setupProvider(): SharedSetupProvider | null {
    try {
      return this.moduleRef?.get(SharedSetupRegistry, { strict: false })?.get() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The one-tap Telegram bot (adapters/telegram-managed-bot.ts), resolved
   * lazily for the same reason. Null when the instance has none.
   */
  private telegramOneTap(): TelegramOneTap | null {
    try {
      const service = this.moduleRef?.get<TelegramOneTap>(TELEGRAM_ONE_TAP, { strict: false });
      return service && typeof service.isEnabledFor === 'function' ? service : null;
    } catch {
      return null;
    }
  }

  /** Cloud social sign-in buttons, when this deployment has any. */
  private socialProviders(): { id: string; name: string }[] {
    if (!this.deployment.isCloud() || !this.social) return [];
    return this.social.enabledProviders();
  }

  private frontendUrl(): string {
    return (
      this.configService.get<string>('FRONTEND_URL') ||
      this.configService.get<string>('SERVER_URL') ||
      'http://localhost:3000'
    ).replace(/\/$/, '');
  }

  /** The trust row under every page of the flow. */
  private trust(): TrustRowOptions {
    return { cloud: this.deployment.isCloud() };
  }

  /**
   * The name of the MCP server this client asked for (RFC 8707 `resource`),
   * for the consent text. Only for a signed-in user who belongs to that
   * server's workspace and may see it (member visibility: a restricted member
   * is shown only their own servers): the page is otherwise unauthenticated.
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
      if (!member) return null;
      const visible = await this.grants.keepVisible(userId, [{ id: serverId, organizationId: server.organizationId }]);
      return visible.length > 0 ? server.name : null;
    } catch {
      return null;
    }
  }

  /**
   * True when the client asked for one MCP server by URL (RFC 8707 `resource`)
   * and the user cannot reach it: the server exists, and the user is neither
   * in its workspace as primary organization nor an active member of it. The
   * same rule as the per-server MCP endpoint, which would refuse every call
   * of such a token, and as the refresh grant (server-reachability.util).
   *
   * The requested id is client input. It is used here only to refuse, never
   * to grant: a forged value can only stop this user's own authorization.
   * An unknown server or a lookup error is left to the existing flow (the
   * endpoint answers 404 for an unknown server).
   */
  private async isRequestedServerUnreachable(req: Request, userId: string): Promise<boolean> {
    const serverId = (req as Request & { signedCookies?: Record<string, unknown> })
      .signedCookies?.[MCP_RESOURCE_COOKIE];
    if (typeof serverId !== 'string' || !serverId) return false;
    return (await serverReachability(this.prisma, userId, serverId)) === 'unreachable';
  }

  /**
   * What every event of one authorization attempt carries: the client, the
   * device, the attempt and the arm of the page test (see
   * authorization-attempt.ts). All of it passes the event store's allow-list.
   */
  private attemptMeta(req: Request, consent: ConsentContext): Record<string, string> {
    const attempt = attemptKey(consent.expiresAt);
    return {
      client: consent.clientName,
      // 'mobile', not 'phone': the only values the event store keeps for `device`.
      device: deviceOf(req.headers['user-agent']),
      // Reloads and the return from a social sign-in show the page again: the
      // same attempt, counted once by this value. It is the moment the pending
      // authorization expires, set once when it starts; nothing of the session
      // itself is stored.
      ...(attempt ? { attempt } : {}),
      ...(consent.connectedArm ? { connectedArm: consent.connectedArm } : {}),
      ...(consent.signinArm ? { signinArm: consent.signinArm } : {}),
    };
  }

  /**
   * `authorize_step_viewed`: a step between the sign-in page and the code was
   * shown ('email-code', 'servers', 'wrong-workspace'). Cloud only, never
   * awaited, never throws.
   */
  private recordStepViewed(req: Request, step: string): void {
    if (!this.productEvents || !this.deployment.isCloud()) return;
    void this.loadConsentContext(req)
      .then((consent) =>
        consent
          ? this.productEvents?.log({
              event: ProductEvents.AUTHORIZE_STEP_VIEWED,
              metadata: { ...this.attemptMeta(req, consent), step },
            })
          : undefined,
      )
      .catch(() => undefined);
  }

  /**
   * `authorize_action`: which button of the sign-in page was used. Never
   * awaited and never throws: the form post must not wait for a statistic.
   */
  private recordAuthorizeAction(req: Request, button: string): void {
    if (!this.productEvents) return;
    void this.loadConsentContext(req)
      .then((consent) =>
        consent
          ? this.productEvents?.log({
              event: ProductEvents.AUTHORIZE_ACTION,
              metadata: { ...this.attemptMeta(req, consent), button },
            })
          : undefined,
      )
      .catch(() => undefined);
  }

  /** The button behind a sign-in form post, as `authorize_action` names it. */
  private buttonOf(action: string | undefined): string {
    if (action === 'deny') return 'cancel';
    if (action === 'approve-session') return 'session';
    if (action?.startsWith('sso:')) return 'sso';
    if (action?.startsWith('social:')) return action.slice('social:'.length);
    return 'password';
  }

  /**
   * `authorization_signed_in`: the identity is settled and access allowed,
   * with the way the person signed in and whether the account is new (made in
   * the last 30 minutes, which is how long an authorization can stay open).
   * Never awaited and never throws.
   */
  private recordSignedIn(req: Request, userId: string, method: string): void {
    if (!this.productEvents) return;
    void (async () => {
      const consent = await this.loadConsentContext(req);
      if (!consent) return;
      const account = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { createdAt: true, organizationId: true },
      });
      const created = account?.createdAt instanceof Date ? account.createdAt.getTime() : null;
      await this.productEvents?.log({
        event: ProductEvents.AUTHORIZATION_SIGNED_IN,
        userId,
        organizationId: account?.organizationId ?? null,
        metadata: {
          ...this.attemptMeta(req, consent),
          method,
          ...(created ? { account: Date.now() - created < 30 * 60 * 1000 ? 'new' : 'existing' } : {}),
        },
      });
    })().catch(() => undefined);
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
    // No open authorization in this browser: it expired (30 minutes), its
    // code was already issued, or this is a bookmark. Signing in here could
    // only end in a refused callback, so say what to do instead of showing a
    // form (it used to be a bare "Sign in" page, then the library's JSON 400).
    if (!consent) {
      if (this.deployment.isCloud()) {
        void this.productEvents
          ?.log({
            event: ProductEvents.AUTHORIZE_REQUEST_CLOSED,
            metadata: { device: deviceOf(req.headers['user-agent']), via: 'login' },
          })
          .catch(() => undefined);
      }
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Cache-Control', 'no-store');
      res.send(renderClosedRequestPage({ trust: this.trust(), message: error, dashboardUrl: this.frontendUrl() }));
      return;
    }
    // Only inside a pending authorization: a bookmark or a crawler on this
    // address is not somebody connecting an AI client.
    if (consent) {
      void this.productEvents
        ?.log({
          event: ProductEvents.AUTHORIZE_PAGE_VIEWED,
          metadata: {
            ...this.attemptMeta(req, consent),
            // The browser's first language, as one of seven buckets or 'other'.
            lang: languageBucket(req.headers['accept-language']),
          },
        })
        .catch(() => undefined);
    }

    // Issue the form's CSRF token (double-submit, HMAC-signed cookie +
    // matching hidden field). Prevents login CSRF / silent credential
    // submission from a cross-site context.
    const csrfToken = this.issueLoginCsrf(req, res);

    // Already signed in to the dashboard in this browser? Then the consent
    // screen only needs an explicit "Approve", not the password again. Only
    // inside an authorize flow, and never when the user asked to switch
    // accounts.
    const sessionUser =
      consent && switchAccount !== '1'
        ? await this.resolveDashboardSession(req)
        : null;

    const ssoProviders = sessionUser ? [] : await this.loadSsoProviders(req);
    // Only inside a pending authorization: the round trip is bound to it, so
    // without one (an old bookmark, an expired session) the button could only fail.
    const socialProviders = sessionUser || !consent ? [] : this.socialProviders();
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
        socialProviders,
        sessionUser,
        requestedServer,
        lang: pageLanguageFor(req.headers['accept-language']),
      }),
    );
  }

  /**
   * Where Google, Microsoft and GitHub send the browser back (Cloud only).
   *
   * Lives here, not on the dashboard API, because the MCP authorization flow
   * has to finish exactly where a password sign-in on this page finishes:
   * through `completeSignIn`, with the server picker and the first-connector
   * step. The dashboard and Settings surfaces are sent on to the frontend.
   */
  @Get('social/:provider/callback')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async socialCallback(
    @Param('provider') provider: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const frontend = this.frontendUrl();
    if (!this.deployment.isCloud() || !this.social) {
      return res.status(404).send('Not found');
    }
    // The URL the provider redirected to, rebuilt on the configured origin: a
    // spoofed Host or x-forwarded-host must not reach the token exchange.
    const currentUrl = new URL(`${frontend}${req.originalUrl}`);
    const clearBinding = () => res.clearCookie(SOCIAL_BIND_COOKIE, { path: '/auth/social' });
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const result = await this.social.complete(
        provider,
        currentUrl,
        {
          bindingToken: req.cookies?.[SOCIAL_BIND_COOKIE],
          oauthSessionId: req.cookies?.oauth_session,
        },
        { ip: req.ip, userAgent: req.headers['user-agent'] },
      );
      clearBinding();
      if (result.kind === 'MCP') {
        this.logger.log(`Authorization signed in with ${provider}: ${maskEmail(result.user.email)}`);
        return this.completeSignIn(req, res, result.user, result.provider);
      }
      if (result.kind === 'LINK') {
        return res.redirect(
          `${frontend}${result.returnTo}${result.returnTo.includes('?') ? '&' : '?'}linked=${encodeURIComponent(result.provider)}`,
        );
      }
      const redirect = result.returnTo !== '/' ? `&redirect=${encodeURIComponent(result.returnTo)}` : '';
      return res.redirect(`${frontend}/login?social=${encodeURIComponent(result.handoffCode)}${redirect}`);
    } catch (err) {
      clearBinding();
      await this.social.logFailure(err, provider, { ip: req.ip, userAgent: req.headers['user-agent'] });
      const message = err instanceof SocialAuthError ? err.userMessage : 'Sign-in failed. Please try again.';
      const surface = err instanceof SocialAuthError ? err.surface : null;
      // An error raised before the attempt is known (the round trip took
      // more than ten minutes, or its address was loaded twice) has no
      // surface. With an authorization pending in this browser the way on is
      // its page, not the dashboard's sign-in, which has no way back to it.
      if (surface === 'MCP' || (surface === null && (await this.loadConsentContext(req)))) {
        return res.redirect(`/auth/login?error=${encodeURIComponent(message)}`);
      }
      if (surface === 'LINK') {
        return res.redirect(`${frontend}/settings?linkError=${encodeURIComponent(message)}`);
      }
      return res.redirect(`${frontend}/login?error=${encodeURIComponent(message)}`);
    }
  }

  // A form post of the sign-in pages (CSRF token + signed cookies), not an API: kept out of the OpenAPI doc.
  @Post('login')
  @HttpCode(200) // a page (or a redirect), not a created resource: Nest's default for POST is 201
  @Throttle({ default: { limit: loginPostLimit, ttl: 60_000, generateKey: loginPostThrottleKey } })
  @ApiExcludeEndpoint()
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
    // anything with the submitted credentials. A POST without a form body
    // (bots, replayed requests) has no body at all: treat it the same way.
    if (!body || !this.verifyCsrf(req, body.csrf)) {
      this.logger.warn('Rejected login with missing/invalid CSRF token');
      res.clearCookie('login_csrf');
      return res.redirect(
        `/auth/login?error=${encodeURIComponent('Your session expired. Please try again.')}`,
      );
    }

    // Which button this was, for the funnel of the page. Not awaited.
    this.recordAuthorizeAction(req, this.buttonOf(body.action));

    // The user explicitly declined on the consent screen: abort the flow and
    // drop the OAuth session cookies so no authorization code can be issued.
    if (body.action === 'deny') {
      const denied = await this.loadConsentContext(req);
      res.clearCookie('login_csrf');
      res.clearCookie('oauth_session');
      res.clearCookie('oauth_state');
      clearLoginUserCookie(res);
      // Tell the client, as OAuth says (RFC 6749 4.1.2.1): it used to hear
      // nothing and kept waiting while the person looked at "Request
      // Cancelled". The redirect goes to the address the client registered
      // and this authorization was started with, never to one from the form.
      const back = denied ? this.deniedRedirect(req, denied) : null;
      if (denied) {
        // Best effort: the cookies are gone either way, and the row expires by itself.
        await Promise.resolve()
          .then(() => this.oauthStore.removeOAuthSession(denied.sessionId))
          .catch(() => undefined);
      }
      if (back) return res.redirect(back);
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
        // The form's token stays valid (see issueLoginCsrf): the back button
        // from the provider's page shows this form again, as it was.
        return res.redirect(authorizationUrl);
      } catch (error: any) {
        this.logger.warn(`MCP SSO start failed: ${error?.reason ?? error}`);
        return res.redirect(
          `/auth/login?error=${encodeURIComponent('Single sign-on is unavailable. Please contact your administrator.')}`,
        );
      }
    }

    // "Continue with Google / Microsoft / GitHub" (Cloud). Also a submit button
    // on this form, so it too has passed the CSRF check.
    if (body.action?.startsWith('social:')) {
      return this.startSocialSignIn(req, res, body.action.slice('social:'.length));
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
      this.logger.log(`Authorization approved from dashboard session: ${maskEmail(sessionUser.email)}`);
      return this.completeSignIn(req, res, sessionUser, undefined, 'session');
    }

    const { email, password } = body;

    if (!email || !password) {
      return res.redirect(
        `/auth/login?error=${encodeURIComponent('Email and password are required')}`,
      );
    }

    // Find user by email, in any case: an address registered with capitals
    // must still sign in when typed in lower case, and the other way round.
    const user = await findUserByEmail<User>(this.prisma, email);

    if (!user) {
      this.logger.warn(`Login attempt for non-existent user: ${maskEmail(email)}`);
      await this.spendPasswordCheck(password);
      return res.redirect(
        `/auth/login?error=${encodeURIComponent(this.signInFailedMessage())}`,
      );
    }

    // SSO-only account: this consent page has its own bcrypt path, so the gate
    // in POST /api/auth/login does not cover it. Without this, an SSO-enforced
    // user could still authorize an AI client with a password — bypassing the
    // IdP's MFA and Conditional Access on exactly the surface that matters.
    if (user.passwordLoginDisabled) {
      this.logger.warn(`Password login refused for SSO-only account: ${maskEmail(email)}`);
      return res.redirect(
        `/auth/login?error=${encodeURIComponent('Password sign-in is disabled for this account. Use your organization sign-in.')}`,
      );
    }

    // Nullable for IdP-provisioned users — never hand null to bcrypt.
    if (!user.passwordHash) {
      this.logger.warn(`Login attempt for passwordless account: ${maskEmail(email)}`);
      await this.spendPasswordCheck(password);
      return res.redirect(
        `/auth/login?error=${encodeURIComponent(this.signInFailedMessage())}`,
      );
    }

    // Verify password
    const passwordValid = await this.authService.comparePassword(
      password,
      user.passwordHash,
    );

    if (!passwordValid) {
      this.logger.warn(`Failed login attempt for user: ${maskEmail(email)}`);
      return res.redirect(
        `/auth/login?error=${encodeURIComponent(this.signInFailedMessage())}`,
      );
    }

    // Cloud: an address nobody verified gets no access token. The client
    // would hold a token that /mcp refuses on every call (EmailVerifiedGuard)
    // and retry it for weeks: 36 accounts did between 28 Sep and 6 Nov 2026.
    // Ask for the code here instead, then go on to "Approve".
    if (this.deployment.isCloud() && !user.emailVerified) {
      if (!this.emailVerification) {
        return res.redirect(
          `/auth/login?error=${encodeURIComponent('Verify your email address first: open the link in the email we sent you.')}`,
        );
      }
      this.logger.log(`Authorization held for email verification: ${maskEmail(email)}`);
      this.recordStepViewed(req, 'email-code');
      return this.askForEmailCode(req, res, user, { sendCode: true });
    }

    this.logger.log(`Successful login for user: ${maskEmail(email)}`);

    return this.completeSignIn(req, res, user);
  }

  /**
   * The one answer to an e-mail and password that did not sign in, whatever
   * the reason: no account with that address, an account that has no
   * password (made with a provider button, or by an identity provider), or a
   * wrong password. The text never depends on the address, so it cannot be
   * used to find out which addresses have an account or how they were made.
   * Where provider buttons exist it says what the two usual cases do next:
   * 58 people typed an address that had no account and 9 a password for an
   * account made with a provider (16 to 21 November 2026).
   */
  private signInFailedMessage(): string {
    const providers = this.socialProviders().map((p) => p.name);
    if (providers.length === 0) return 'Invalid email or password';
    const list =
      providers.length === 1
        ? providers[0]
        : `${providers.slice(0, -1).join(', ')} or ${providers[providers.length - 1]}`;
    return `That email and password do not match. If you signed up with ${list}, use that button instead. New here? Create an account first.`;
  }

  /**
   * One password check against a hash no password matches, for a sign-in
   * that has no hash to check (no such account, or an account without a
   * password). The refusal then takes as long as a wrong password does.
   */
  private async spendPasswordCheck(password: string): Promise<void> {
    try {
      await this.authService.comparePassword(String(password), NO_ACCOUNT_PASSWORD_HASH);
    } catch {
      // Only the time matters; the sign-in is refused either way.
    }
  }

  /** "Continue with Google / Microsoft / GitHub" from a CSRF-checked form of this flow. */
  private async startSocialSignIn(req: Request, res: Response, provider: string): Promise<void> {
    if (!this.social || this.socialProviders().length === 0) {
      return res.redirect(`/auth/login?error=${encodeURIComponent('This sign-in option is not available.')}`);
    }
    try {
      const { authorizationUrl, bindingToken } = await this.social.start({
        provider,
        surface: 'MCP',
        oauthSessionId: req.cookies?.oauth_session,
      });
      setSocialBindCookie(req, res, bindingToken);
      // The form's token stays valid (see issueLoginCsrf): the back button
      // from the provider's page shows this form again, as it was.
      return res.redirect(authorizationUrl);
    } catch (error: any) {
      this.logger.warn(`MCP social sign-in start failed: ${error?.reason ?? error}`);
      const message =
        error instanceof SocialAuthError ? error.userMessage : 'This sign-in option is not available right now.';
      return res.redirect(`/auth/login?error=${encodeURIComponent(message)}`);
    }
  }

  /**
   * Cloud: the code step for an account whose address is not verified yet.
   *
   * The password was right, but the authorization is not finished: no
   * `login_user` cookie, so /callback cannot issue a code. The account id is
   * held in a signed cookie while the person types the code from the email,
   * asks for a new one, or continues with Google, Microsoft or GitHub (which
   * verifies the address). A right code goes on to completeSignIn, exactly as
   * a verified account would have from the password form.
   */
  private async askForEmailCode(
    req: Request,
    res: Response,
    user: { id: string; email: string },
    opts: { sendCode?: boolean; error?: string; notice?: string } = {},
  ): Promise<void> {
    let notice = opts.notice;
    if (opts.sendCode && this.emailVerification) {
      // The same rule as the dashboard sign-in: no second code within a
      // minute (it would void the first one, which may be on its way).
      const justSent = await this.emailVerification.codesSentWithin(user.id, CODE_RESEND_INTERVAL_MS);
      if (justSent === 0) {
        const lastHour = await this.emailVerification.codesSentWithin(user.id, 60 * 60 * 1000);
        if (lastHour < MAX_CODES_PER_HOUR) {
          await this.emailVerification.sendCode(user.id, user.email, { sendInBackground: true });
        } else {
          notice = TOO_MANY_CODES;
        }
      }
    }

    const isSecure = this.isSecureRequest(req);
    const cookieOptions = {
      httpOnly: true,
      secure: isSecure,
      maxAge: VERIFICATION_CODE_TTL_MS,
      sameSite: isSecure ? ('none' as const) : ('lax' as const),
      signed: true,
    };
    const csrfToken = randomBytes(32).toString('base64url');
    res.cookie(PENDING_VERIFY_COOKIE, user.id, cookieOptions);
    res.cookie(VERIFY_CSRF_COOKIE, csrfToken, cookieOptions);
    // The password form is done with: its single-use token goes.
    res.clearCookie('login_csrf');

    const consent = await this.loadConsentContext(req);
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.send(
      this.renderEmailCodePage({
        consent,
        maskedEmail: maskEmail(user.email) ?? 'your address',
        csrfToken,
        // The round trip is bound to the pending authorization, as on the sign-in page.
        socialProviders: consent ? this.socialProviders() : [],
        error: opts.error,
        notice,
      }),
    );
  }

  /** Ends the code step: its cookies go. */
  private clearEmailCodeStep(res: Response): void {
    res.clearCookie(PENDING_VERIFY_COOKIE);
    res.clearCookie(VERIFY_CSRF_COOKIE);
  }

  /**
   * What every route of the code step checks first (Cloud only): the step's
   * CSRF token, then the pending sign-in cookie, then the account itself.
   * Answers the request and returns null when one of them fails.
   */
  private async pendingCodeStep(
    req: Request,
    res: Response,
    csrf: unknown,
  ): Promise<{ id: string; email: string; name: string | null; emailVerified: boolean } | null> {
    if (!this.deployment.isCloud() || !this.emailVerification) {
      res.status(404).send('Not found');
      return null;
    }
    const restart = (message: string) => {
      this.clearEmailCodeStep(res);
      res.redirect(`/auth/login?error=${encodeURIComponent(message)}`);
      return null;
    };
    if (!this.verifySignedToken(req, VERIFY_CSRF_COOKIE, csrf)) {
      this.logger.warn('Rejected email code step with missing/invalid CSRF token');
      return restart('Your session expired. Please sign in again.');
    }
    const userId = (req as Request & { signedCookies?: Record<string, unknown> }).signedCookies?.[
      PENDING_VERIFY_COOKIE
    ];
    if (typeof userId !== 'string' || !userId) {
      return restart('Your session expired. Please sign in again.');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, emailVerified: true, passwordLoginDisabled: true },
    });
    // Gone, or made SSO-only meanwhile: the password that opened this step
    // no longer counts.
    if (!user || user.passwordLoginDisabled) {
      return restart('Please sign in again.');
    }
    return { id: user.id, email: user.email, name: user.name, emailVerified: user.emailVerified };
  }

  /**
   * Verified meanwhile (the link in the email, in another tab): nothing left
   * to check, the password was proven when the step began. Returns true when
   * it has completed the sign-in.
   */
  private async continueIfVerified(
    req: Request,
    res: Response,
    user: { id: string; email: string; name: string | null; emailVerified: boolean },
  ): Promise<boolean> {
    if (!user.emailVerified) return false;
    this.clearEmailCodeStep(res);
    this.logger.log(`Authorization continues after email verification: ${maskEmail(user.email)}`);
    await this.completeSignIn(req, res, user, undefined, 'email_code');
    return true;
  }

  /**
   * The code step's form (Cloud): checks the code. Its other buttons post to
   * their own routes below (`formaction`), so no form field picks what runs.
   */
  @Post('verify-email')
  @HttpCode(200) // a page (or a redirect), not a created resource: Nest's default for POST is 201
  // A code is 6 digits and lives 15 minutes: 10 tries a minute leaves no
  // realistic guess, and a person never needs more.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async handleEmailCode(
    @Req() req: Request,
    @Body() body: { csrf?: string; code?: string },
    @Res() res: Response,
  ) {
    const user = await this.pendingCodeStep(req, res, body?.csrf);
    if (!user || (await this.continueIfVerified(req, res, user))) return;

    // Spaces from a pasted code go; anything else simply matches no code.
    const code = typeof body?.code === 'string' ? body.code.replace(/\s+/g, '').slice(0, 16) : '';
    const verified = await this.emailVerification!.verifyCode(user.id, code);
    if (!verified) {
      return this.askForEmailCode(req, res, user, {
        error: 'That code is wrong or has expired. Use the newest email, or send a new code.',
      });
    }

    this.clearEmailCodeStep(res);
    this.logger.log(`Email verified on the authorization page: ${maskEmail(user.email)}`);
    return this.completeSignIn(req, res, user, undefined, 'email_code');
  }

  /** "Send a new code" of the code step: at most one a minute, five an hour. */
  @Post('verify-email/resend')
  @HttpCode(200) // a page (or a redirect), not a created resource: Nest's default for POST is 201
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async resendEmailCode(@Req() req: Request, @Body() body: { csrf?: string }, @Res() res: Response) {
    const user = await this.pendingCodeStep(req, res, body?.csrf);
    if (!user || (await this.continueIfVerified(req, res, user))) return;
    const verification = this.emailVerification!;
    if ((await verification.codesSentWithin(user.id, CODE_RESEND_INTERVAL_MS)) > 0) {
      return this.askForEmailCode(req, res, user, {
        notice: 'A code was sent less than a minute ago. Check your inbox and spam folder, or ask again in a minute.',
      });
    }
    if ((await verification.codesSentWithin(user.id, 60 * 60 * 1000)) >= MAX_CODES_PER_HOUR) {
      return this.askForEmailCode(req, res, user, { notice: TOO_MANY_CODES });
    }
    await verification.sendCode(user.id, user.email, { sendInBackground: true });
    return this.askForEmailCode(req, res, user, {
      notice: 'A new code is on its way. Codes sent before it no longer work.',
    });
  }

  /** "I opened the link in the email": continues once the link verified the address. */
  @Post('verify-email/continue')
  @HttpCode(200) // a page (or a redirect), not a created resource: Nest's default for POST is 201
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async continueAfterEmailLink(@Req() req: Request, @Body() body: { csrf?: string }, @Res() res: Response) {
    const user = await this.pendingCodeStep(req, res, body?.csrf);
    if (!user || (await this.continueIfVerified(req, res, user))) return;
    return this.askForEmailCode(req, res, user, {
      error: 'Your address is not verified yet. Enter the code from the email, or open its link first.',
    });
  }

  /** "Continue with <provider>" of the code step: the provider verifies the address. */
  @Post('verify-email/social/:provider')
  @HttpCode(200) // a page (or a redirect), not a created resource: Nest's default for POST is 201
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async socialFromEmailCode(
    @Param('provider') provider: string,
    @Req() req: Request,
    @Body() body: { csrf?: string },
    @Res() res: Response,
  ) {
    const user = await this.pendingCodeStep(req, res, body?.csrf);
    if (!user) return;
    this.clearEmailCodeStep(res);
    return this.startSocialSignIn(req, res, provider);
  }

  /**
   * The identity is settled (password or dashboard session): hand it to the
   * OAuth callback, after asking which servers the client may reach.
   */
  private async completeSignIn(
    req: Request,
    res: Response,
    user: SessionUser,
    /** Set when the user signed in on this page with Google, Microsoft or GitHub. */
    socialProvider?: string,
    /** How the identity was settled, when not with a provider or the password form (for the event only). */
    via?: 'session' | 'email_code',
  ): Promise<void> {
    // The client asked for one server by URL, and this account cannot reach
    // it: no token. It would be refused on every call, and clients do not
    // sign in again after a 403, so the person could never fix it from the
    // chat (#1609). Back to the sign-in form instead, without the dashboard
    // session, to sign in with an account of that server's workspace.
    if (await this.isRequestedServerUnreachable(req, user.id)) {
      this.logger.warn(
        `Authorization refused: the requested MCP server belongs to a workspace ${maskEmail(user.email)} is not a member of`,
      );
      res.clearCookie('login_csrf');
      this.recordStepViewed(req, 'wrong-workspace');
      return res.redirect(
        `/auth/login?switch=1&error=${encodeURIComponent(WRONG_WORKSPACE_MESSAGE)}`,
      );
    }
    // For the funnel of the pages: who signed in, and how. Not awaited.
    this.recordSignedIn(req, user.id, socialProvider ?? via ?? 'password');
    // Remembered for the setup links the AI client will hand out, so they open
    // the dashboard without asking for this sign-in again (recent-sign-in.util).
    setRecentSignInCookie(res, user.id, this.isSecureRequest(req));
    // Set a short-lived cookie with the user profile for the callback to read
    const profile = {
      id: user.id,
      email: user.email,
      name: user.name,
      username: user.email,
    };

    const encoded = Buffer.from(JSON.stringify(profile)).toString('base64url');

    const isSecure = this.isSecureRequest(req);

    setLoginUserCookie(req, res, encoded, { maxAge: 60 * 1000, secure: isSecure });

    // The consent decision has been made — the single-use CSRF token is done.
    res.clearCookie('login_csrf');

    // Between "who you are" and "what this client may reach". Returns true when
    // it has taken over the response with the picker.
    if (await this.maybeAskWhichServers(req, res, user.id, socialProvider)) return;

    // Derive callback URL from the request origin (works behind proxy/tunnel)
    const baseUrl = this.getBaseUrl(req);
    if (await this.offerAfterApprove(req, res, user.id, encoded, `${baseUrl}/callback`, socialProvider)) return;
    res.redirect(`${baseUrl}/callback`);
  }

  /**
   * The optional page between "Approve" and the AI client: the File Search
   * plugin's folder setup for a client that asked for `/mcp/file-search`,
   * otherwise the first-connector page (Cloud only, empty workspaces). The
   * File Search plugin serves no catalog apps, so it never gets the latter.
   */
  private async offerAfterApprove(
    req: Request,
    res: Response,
    userId: string,
    encodedProfile: string,
    callbackUrl: string,
    socialProvider?: string,
  ): Promise<boolean> {
    if (this.requestedApp(req) === 'file-search') {
      return this.maybeOfferFileSearchSetup(req, res, userId, encodedProfile, callbackUrl);
    }
    return this.maybeOfferFirstConnector(req, res, userId, encodedProfile, callbackUrl, socialProvider);
  }

  /** The directory plugin this authorization asked for (MCP_DIRECTORY_COOKIE), or null. */
  private requestedDirectoryPlugin(req: Request): DirectoryPluginEndpoint | null {
    const value = (req as Request & { signedCookies?: Record<string, unknown> }).signedCookies?.[MCP_DIRECTORY_COOKIE];
    return value === 'chatgpt-app' || value === 'file-search' ? value : null;
  }

  /** The fixed plugin endpoint this authorization asked for (MCP_APP_COOKIE), or null. */
  private requestedApp(req: Request): 'file-search' | null {
    const app = (req as Request & { signedCookies?: Record<string, unknown> }).signedCookies?.[MCP_APP_COOKIE];
    return app === 'file-search' ? app : null;
  }

  /**
   * File Search plugin: a workspace admin whose workspace has no folder
   * connected yet is offered to connect one before going back to the AI
   * client, because the plugin has nothing else to work with. The page lists
   * how a folder can be reached (SFTP, FTPS, FTP, WebDAV, Nextcloud, NAS
   * presets, S3); each choice opens the File Search wizard in the dashboard,
   * signed in as this user on the granted workspace, and the wizard comes back
   * to /auth/file-search/continue when the folder is active. Passwords and
   * keys are entered there, never in the chat.
   *
   * Same in Cloud and self-hosted. Non-admins, and workspaces that already
   * have a folder, go straight on. The OAuth flow is only paused, as on the
   * first-connector page: "Skip" and the wizard's return both reach the same
   * callback. Returns true when it has rendered the page.
   */
  private async maybeOfferFileSearchSetup(
    req: Request,
    res: Response,
    userId: string,
    encodedProfile: string,
    callbackUrl: string,
  ): Promise<boolean> {
    if (!this.recentSignIn) return false;
    const consent = await this.loadConsentContext(req);
    if (!consent) return false;
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { organizationId: true },
    });
    const workspace = await this.grantedWorkspace(consent.clientId, userId, account?.organizationId);
    if (!workspace) return false;
    const { organizationId } = workspace;
    const [member, sources] = await Promise.all([
      this.prisma.organizationMember.findFirst({
        where: { userId, organizationId, deactivatedAt: null },
        select: { role: true },
      }),
      this.prisma.connector.findMany({
        where: { organizationId, type: 'FILE_SEARCH' as any, isActive: true },
        select: { config: true },
      }),
    ]);
    // Only admins set up File Search (FileSearchService.assertAdmin).
    if (member?.role !== 'ADMIN') return false;
    // The File Share connector is a FILE_SEARCH connector with no folder.
    if (sources.some((c) => !(c.config as { fileShare?: unknown } | null)?.fileShare)) return false;

    // The login cookie lives as long as the authorization it finishes, so the
    // wizard's return still completes it (see maybeOfferFirstConnector).
    const isSecure = this.isSecureRequest(req);
    const pauseMs = consent.expiresAt
      ? Math.min(FIRST_CONNECTOR_PAUSE_MAX_MS, Math.max(60 * 1000, consent.expiresAt - Date.now()))
      : 15 * 60 * 1000;
    setLoginUserCookie(req, res, encodedProfile, { maxAge: pauseMs, secure: isSecure });
    const csrf = randomBytes(32).toString('base64url');
    res.cookie(FILE_SEARCH_SETUP_CSRF_COOKIE, csrf, {
      httpOnly: true,
      secure: isSecure,
      maxAge: pauseMs,
      sameSite: isSecure ? 'none' : 'lax',
      signed: true,
    });

    await this.productEvents
      ?.log({
        event: ProductEvents.FILE_SEARCH_AUTHORIZE_OFFERED,
        userId,
        organizationId,
        metadata: { client: consent.clientName },
      })
      .catch(() => undefined);

    res.setHeader('Content-Type', 'text/html');
    res.send(
      this.renderFileSearchSetupOffer({
        clientName: consent.clientName,
        redirectHost: consent.redirectHost,
        callbackUrl,
        csrf,
        cloud: this.deployment.isCloud(),
      }),
    );
    return true;
  }

  /**
   * The File Search setup page's hand-off to the dashboard: a dashboard
   * session for the user of the paused authorization, on the workspace that
   * authorization was granted, and the wizard path for the chosen option.
   *
   * It needs everything at once: the page's CSRF token and its signed cookie,
   * the dashboard's own header (a cross-site page cannot send it without a
   * CORS preflight), the signed login cookie of a still-pending authorization
   * that asked for the File Search plugin, and this browser's recent sign-in
   * cookie for the same user. Admins only, as for the page itself.
   */
  // A form post of the sign-in pages (CSRF token + signed cookies), not an API: kept out of the OpenAPI doc.
  @Post('file-search/session')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async fileSearchSetupSession(
    @Req() req: Request,
    @Body() body: { csrf?: unknown; option?: unknown },
    @Res() res: Response,
  ) {
    const expired = 'This page has expired. Go back to the chat and connect again, or set up the folder in the dashboard.';
    if (!hasDashboardHeader(req) || !this.verifySignedToken(req, FILE_SEARCH_SETUP_CSRF_COOKIE, body?.csrf)) {
      this.logger.warn('Rejected a File Search setup hand-off with a missing header or CSRF token');
      return res.status(403).json({ ok: false, error: expired });
    }
    const userId = this.pendingLoginUserId(req);
    const consent = await this.loadConsentContext(req);
    if (!userId || !consent || this.requestedApp(req) !== 'file-search' || !this.recentSignIn) {
      return res.status(403).json({ ok: false, error: expired });
    }
    const recent = await this.recentSignIn.user(req).catch(() => null);
    if (!recent || recent.id !== userId) return res.status(403).json({ ok: false, error: expired });

    const account = await this.prisma.user.findUnique({ where: { id: userId }, select: { organizationId: true } });
    const workspace = await this.grantedWorkspace(consent.clientId, userId, account?.organizationId);
    if (!workspace) return res.status(403).json({ ok: false, error: expired });
    const member = await this.prisma.organizationMember.findFirst({
      where: { userId, organizationId: workspace.organizationId, deactivatedAt: null },
      select: { role: true },
    });
    if (member?.role !== 'ADMIN') {
      return res.status(403).json({ ok: false, error: 'Only workspace admins can connect a folder.' });
    }
    const option = typeof body?.option === 'string' ? body.option : '';
    const allowed = FILE_SEARCH_SETUP_OPTIONS.find((o) => o.id === option && (!o.selfHostedOnly || !this.deployment.isCloud()));
    const redirect = allowed ? fileSearchWizardPathFor(allowed.id, workspace.serverIds) : null;
    if (!redirect) return res.status(400).json({ ok: false, error: 'Unknown option.' });

    const session = await this.recentSignIn.session(userId, workspace.organizationId).catch(() => null);
    if (!session) return res.status(403).json({ ok: false, error: expired });
    this.logger.log(`File Search setup opened from the authorization page by user ${userId}`);
    return res.json({ ok: true, redirect, session });
  }

  /**
   * Where the File Search wizard returns to when it was opened from the
   * authorization page: finishes the paused authorization (the AI client
   * gets its code), or, when it has expired meanwhile, says how to go on.
   * The folder is saved either way.
   */
  @Get('file-search/continue')
  async fileSearchSetupContinue(@Req() req: Request, @Res() res: Response) {
    const userId = this.pendingLoginUserId(req);
    const consent = userId ? await this.loadConsentContext(req) : null;
    if (userId && consent) {
      res.clearCookie(FILE_SEARCH_SETUP_CSRF_COOKIE);
      return res.redirect(`${this.getBaseUrl(req)}/callback`);
    }
    res.setHeader('Content-Type', 'text/html');
    return res.send(
      renderAuthPage({
        title: 'Go back to the chat to finish',
        card: `
    <h1>Go back to the chat to finish</h1>
    <p class="sub">The connection request from the chat timed out in the meantime. A folder you connected is saved and its first sync is running.</p>
    <p class="sub">Go back to the chat and connect the plugin again. It takes a few seconds now.</p>`,
        trust: this.trust(),
      }),
    );
  }

  private renderFileSearchSetupOffer(params: {
    clientName: string;
    redirectHost?: string;
    callbackUrl: string;
    csrf: string;
    cloud: boolean;
  }): string {
    const client = this.escapeHtml(params.clientName);
    const options = FILE_SEARCH_SETUP_OPTIONS.filter((o) => !o.selfHostedOnly || !params.cloud);
    const tiles = options
      .map((o) => {
        // The dashboard's hand-off page, on the dashboard's own origin: the
        // session it opens is the dashboard's (same site as this page).
        const href = `${this.frontendUrl()}/setup/file-search?${new URLSearchParams({ option: o.id, t: params.csrf }).toString()}`;
        return `
        <a class="fs-option" href="${this.escapeHtml(href)}"><span class="fs-option-label">${this.escapeHtml(o.label)}</span><span class="fs-option-hint">${this.escapeHtml(o.hint)}</span></a>`;
      })
      .join('');
    const card = `
    ${clientTilePair(params.clientName, params.redirectHost ?? '')}
    <h1>Connect a folder for ${client}</h1>
    <p class="sub">${client} can search the documents on your file server once a folder is connected. Choose how AnythingMCP reaches it:</p>
    <nav class="fs-options" aria-label="How to reach the folder">${tiles}
    </nav>
    <ol class="steps">
      <li>Enter the server address and a read-only account, and test the connection.</li>
      <li>Pick the folders and file types to search, and see how many files that is.</li>
      <li>Check the description ${client} reads, then activate: the first sync starts.</li>
    </ol>
    <p class="body">It takes about five minutes. Passwords and keys are entered on the next page, never in the chat. When the folder is active you come back here and on to ${client}.</p>
    <p class="links"><a id="skip" href="${this.escapeHtml(params.callbackUrl)}">Skip for now and continue to ${client}</a></p>`;
    return renderAuthPage({
      title: `Connect a folder for ${params.clientName}`,
      card,
      trust: this.trust(),
      extraStyles: `
  /* Not .tile: that class is the client icons at the top. */
  .fs-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0 0 18px; }
  a.fs-option { display: flex; flex-direction: column; gap: 2px; border: 1px solid var(--border-strong); border-radius: 10px;
           padding: 10px 12px; text-decoration: none; color: var(--text); background: #fff; min-height: 44px; }
  a.fs-option:hover { border-color: var(--brand); background: var(--surface-2); }
  a.fs-option:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
  .fs-option-label { font-size: 14px; font-weight: 600; }
  .fs-option-hint { font-size: 12.5px; color: var(--text-2); line-height: 1.35; }
  @media (max-width: 360px) { .fs-options { grid-template-columns: 1fr; } }
  .steps { color: var(--text-2); font-size: 14px; line-height: 1.5; margin: 0 0 14px; padding-left: 20px; }
  .steps li { margin: 0 0 4px; }
  .body { color: var(--text-2); font-size: 14px; line-height: 1.5; margin: 0 0 18px; }`,
    });
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
    socialProvider?: string,
  ): Promise<boolean> {
    if (!this.deployment.isCloud()) return false;
    const consent = await this.loadConsentContext(req);
    if (!consent) return false;
    // A client connecting one server's own URL does not get the setup tools
    // (they live on the shared endpoint), so the advice would not hold.
    const requestedServerId = (req as Request & { signedCookies?: Record<string, unknown> })
      .signedCookies?.[MCP_RESOURCE_COOKIE];
    if (typeof requestedServerId === 'string' && requestedServerId) return false;
    // ChatGPT's database plugin has no setup tools: "add them right in the
    // chat" and the app chips would promise what that endpoint cannot do.
    if (this.requestedDirectoryPlugin(req) === 'chatgpt-app') return false;
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { organizationId: true, email: true },
    });
    // The workspace this connection was granted, which is not the user's
    // primary one when they picked another on "Choose what to connect".
    const workspace = await this.grantedWorkspace(consent.clientId, userId, account?.organizationId);
    if (!workspace) return false;
    const { organizationId } = workspace;
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
    setLoginUserCookie(req, res, encodedProfile, { maxAge: pauseMs, secure: isSecure });
    // The optional app picker, when this instance can install connectors: a
    // CSRF token for its one request, valid as long as the pause.
    // An admin on the free trial is offered a payment method (below). Looked
    // up first: with an ended trial nothing can be added, so the picker and
    // the "add them in the chat" sentence are left out.
    const trial =
      member?.role === 'ADMIN'
        ? await this.licenseGuard?.getTrialState(organizationId).catch(() => null)
        : null;
    const trialEnded = !!trial && !trial.active;
    const pickerCsrf = this.setupProvider() && !trialEnded ? randomBytes(32).toString('base64url') : null;
    // Telegram can then be finished on this page, with a bot created in one
    // tap: only where this instance has a manager bot, and for this workspace.
    const telegramOneTap = !!pickerCsrf && !!this.telegramOneTap()?.isEnabledFor(organizationId);
    if (pickerCsrf) {
      res.cookie(FIRST_APP_CSRF_COOKIE, pickerCsrf, {
        httpOnly: true,
        secure: isSecure,
        maxAge: pauseMs,
        sameSite: isSecure ? 'none' : 'lax',
        signed: true,
      });
    }

    // An admin on the free trial is offered a payment method, as a secondary
    // button under "Continue" that comes back through /callback. Never before
    // Approve: a payment step there halved the connections (#842, #843).
    const trialEndsAt =
      trial?.active && trial.cardTrialAvailable && !(await this.hadSubscriptionQuickly(account?.email))
        ? trial.endsAt
        : null;

    await this.productEvents
      ?.log({
        event: ProductEvents.EMPTY_WORKSPACE_PROMPT,
        userId,
        organizationId,
        metadata: { ...this.attemptMeta(req, consent), ...(trialEndsAt ? { cardTrialOffered: true } : {}) },
      })
      .catch(() => undefined);

    // The page gets an address of its own (GET /auth/next): what it shows is
    // kept in a signed cookie for as long as the pause, and this request
    // answers with a redirect. Reload, Back and a restored tab then show the
    // page again instead of an error (FIRST_OFFER_COOKIE).
    const offer: FirstOffer = {
      o: organizationId,
      ...(socialProvider ? { s: socialProvider } : {}),
      ...(trialEndsAt ? { t: trialEndsAt.getTime() } : {}),
      ...(telegramOneTap ? { g: 1 as const } : {}),
      ...(trialEnded ? { x: 1 as const } : {}),
    };
    res.cookie(FIRST_OFFER_COOKIE, Buffer.from(JSON.stringify(offer)).toString('base64url'), {
      httpOnly: true,
      secure: isSecure,
      maxAge: pauseMs,
      sameSite: isSecure ? 'none' : 'lax',
      signed: true,
    });
    res.clearCookie(FIRST_APP_PICKED_COOKIE);
    void callbackUrl; // the page builds it again from its own request
    res.redirect(303, '/auth/next');
    return true;
  }

  /**
   * Whether this address had a subscription before (it would be charged
   * today, so "nothing is charged before" would be false). The authorization
   * waits for this page, so the licence site gets 1.5 s; no answer counts as
   * no, as the page always said, and the site checks again at checkout.
   */
  private async hadSubscriptionQuickly(email: string | null | undefined): Promise<boolean> {
    if (!email || !this.cardTrialEligibility) return false;
    const answer = await Promise.race([
      this.cardTrialEligibility.hadSubscription(email).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500).unref?.()),
    ]);
    return answer === true;
  }

  /**
   * The one workspace this client reaches for this user, as the shared
   * endpoint resolves it: the granted workspace, or the workspace of the
   * granted servers (with their ids). Without any grant (a connection from
   * before grants existed), the user's own organization, `fallback`. Null
   * when the grant reaches nothing, or servers in more than one workspace:
   * there is then no single workspace to add an app to.
   */
  private async grantedWorkspace(
    clientId: string,
    userId: string,
    fallback: string | null | undefined,
  ): Promise<{ organizationId: string; serverIds: string[] } | null> {
    let grant: Awaited<ReturnType<McpConnectionGrantService['resolve']>> = null;
    try {
      grant = await this.grants.resolve(clientId, userId);
    } catch {
      grant = null;
    }
    if (!grant) return fallback ? { organizationId: fallback, serverIds: [] } : null;
    if (grant.mode === 'organization') return { organizationId: grant.organizationId, serverIds: [] };
    if (grant.mode === 'servers') {
      const organizations = new Set(grant.servers.map((s) => s.organizationId));
      if (organizations.size !== 1) return null;
      return { organizationId: grant.servers[0].organizationId, serverIds: grant.servers.map((s) => s.id) };
    }
    return null;
  }

  private renderFirstConnectorOffer(params: {
    clientName: string;
    redirectHost?: string;
    /** A phone or tablet browser: Continue must not open a second tab there. */
    onPhone?: boolean;
    callbackUrl: string;
    /** The arm of the page test (authorization-attempt.ts); null or absent: the control page. */
    arm?: ConnectedPageArm | null;
    /** The attempt, for the page's beacons; without it the page reports nothing. */
    attempt?: string;
    welcomeUrl: string;
    cardTrial?: { endsAt: Date; url: string };
    /** CSRF token of the optional app picker; no picker without it. */
    pickerCsrf?: string;
    /** Picking Telegram offers a bot created in one tap (first-app-telegram.ts). */
    telegramOneTap?: boolean;
    /** The app already picked on this page (shown again after a reload). */
    picked?: { slug: string; name: string };
    /** The workspace's free trial has ended: nothing can be added until it is reactivated. */
    trialEnded?: boolean;
  }): string {
    const client = this.escapeHtml(params.clientName);
    // "October 13", kept on one line.
    const trialEnd = params.cardTrial
      ? this.escapeHtml(
          params.cardTrial.endsAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }),
        ).replace(' ', '&nbsp;')
      : '';
    // Continue only goes back through the authorization, on every device. It
    // used to open a new Claude chat in a second tab as well (2 November
    // 2026). On phones that tab took over and the authorization in this tab
    // was never finished: about 200 authorization codes a day were never
    // exchanged, against about 10 before, until phones lost the tab on 15
    // November. From 18 November the same happened on computers (19 % of the
    // codes issued from this page never exchanged, against 3 % without the
    // page), so no device opens a second tab now. The same click copies the
    // request instead, to paste in a new chat.
    const telegram = !!params.pickerCsrf && !!params.telegramOneTap;
    // Hidden until the script shows it: without JavaScript the page is the
    // same as before, and never more than one click from the chat.
    const picker = params.pickerCsrf
      ? `
    <section class="quick" id="quick-apps" hidden data-csrf="${this.escapeHtml(params.pickerCsrf)}"${
      params.picked
        ? ` data-picked="${this.escapeHtml(params.picked.slug)}" data-picked-request="${this.escapeHtml(finishSetupRequest(params.picked.name))}"`
        : ''
    } aria-labelledby="quick-title">
      <p class="quick-title" id="quick-title">Optional: add an app to start with</p>
      <div class="chips" role="group" aria-labelledby="quick-title">${QUICK_SETUP_APPS.map(
        (app) => `
        <button type="button" class="chip" aria-pressed="false" data-adapter="${this.escapeHtml(app.slug)}" data-name="${this.escapeHtml(app.name)}">${this.escapeHtml(app.name)}</button>`,
      ).join('')}
      </div>
      <label class="other-label" for="other-app">Another app</label>
      <input type="text" id="other-app" class="other" maxlength="60" autocomplete="off" spellcheck="false" placeholder="e.g. HubSpot">
      <p class="quick-status" id="quick-status" role="status" aria-live="polite"></p>${
        // A phone gets no QR code: the button opens the Telegram app there.
        telegram ? telegramPanelHtml({ withQr: !params.onPhone }) : ''
      }
    </section>`
      : '';
    // The 'next_step' arm of the page test. No code exists while this page is
    // shown: the client is connected only after Continue, and the control's
    // heading says it already is. 7 % of sign-in attempts ended here, signed
    // in and never connected (16 to 21 November 2026).
    const nextStep = params.arm === 'next_step';
    // A base-36 number (attemptKey); checked again here because it is written into the script.
    const attempt = params.attempt && /^[0-9a-z]{6,12}$/.test(params.attempt) ? params.attempt : '';
    const heading = nextStep ? `One more step: go back to ${client}` : `${client} is connected`;
    // On the next_step page the sentence about Continue stands alone, so on a
    // phone the button can follow it directly (see the order in the styles);
    // the example request comes after the button there.
    const sub = nextStep
      ? `Press <strong>Continue to ${client}</strong> to finish connecting.`
      : `Your workspace has no apps yet, so ${client} has nothing to work with. You can add them right in the chat. For example, ask:`;
    const sub2 = !nextStep
      ? ''
      : params.trialEnded
        ? `<p class="sub sub2" id="first-sub2">Your free trial has ended. ${client} will show you how to reactivate the workspace when you ask it something.</p>`
        : `<p class="sub sub2" id="first-sub2">Your workspace has no apps yet: you can add them right in the chat. For example, ask:</p>`;
    const card = `
    <div class="flow${nextStep ? ' next' : ''}">
    ${clientTilePair(params.clientName, params.redirectHost ?? '')}
    <h1${nextStep ? ' class="vh"' : ''}>${heading}</h1>
    <p class="sub" id="first-sub">${sub}</p>${sub2}
${
      nextStep && params.trialEnded
        ? ''
        : `
    <div class="example"><span>“<span id="example-request">${this.escapeHtml(FIRST_CONNECTOR_EXAMPLE)}</span>”</span><button type="button" class="copy" id="copy-request"${nextStep ? ' data-continue="1"' : ''}>${nextStep ? 'Copy &amp; continue' : 'Copy'}</button></div>
    <p class="copied" id="request-copied" role="status" aria-live="polite" hidden></p>
    <p class="body" id="first-body">${client} finds the connector and sets it up with you. Passwords and keys are never typed into the chat: you get a link to enter them here.</p>`
    }${picker}${
      nextStep && telegram
        ? `
    <p class="auto" id="auto-continue" role="status" aria-live="polite" hidden><span id="auto-continue-text"></span> <button type="button" class="stay" id="auto-continue-stay">Stay on this page</button></p>`
        : ''
    }
    <a class="button" id="continue" href="${this.escapeHtml(params.callbackUrl)}" data-client="${client}">Continue to ${client}</a>${
      // Optional, under Continue and never in its place. Same tab: every way
      // out of the card-trial page (checkout done, cancelled, skipped) comes
      // back through /callback, which finishes this authorization (the
      // sign-in cookie lasts as long as it). Never before Approve (#842/#843).
      params.cardTrial
        ? `
    <div class="trial" id="card-trial">
      <a class="button secondary-link" id="card-trial-link" href="${this.escapeHtml(params.cardTrial.url)}">Add a payment method (optional)</a>
      <p>Your free trial runs until ${trialEnd}. With a payment method your plan carries on after it; nothing is charged before ${trialEnd}. Either way you come straight back to ${client}.</p>
    </div>`
        : ''
    }
    <p class="links"><a id="open-dashboard" href="${this.escapeHtml(params.welcomeUrl)}" target="_blank" rel="noopener noreferrer">Or add an app here first (new tab)</a></p>
    </div>
    <script>
    // Copy the example request, to paste into the chat after "Continue":
    // easier than retyping it. The quotes are left out of the copy.
    //
    // On the next_step page the button is "Copy & continue" (data-continue):
    // once the request is copied it presses Continue for the person, so
    // nobody copies the request, goes to the chat and finds the client not
    // connected. One press of the same link, in the same tab, and only once:
    // /callback must never be asked for twice. A clipboard that refuses or
    // never answers does not hold the person back.
    (function () {
      var button = document.getElementById('copy-request');
      var request = document.getElementById('example-request');
      if (!button || !request || !navigator.clipboard) { if (button) button.hidden = true; return; }
      var goOn = button.getAttribute('data-continue') === '1';
      var gone = false;
      var go = function () {
        if (!goOn || gone) return;
        var cont = document.getElementById('continue');
        if (!cont || !cont.click) return;
        gone = true;
        cont.setAttribute('data-via', 'copy');
        cont.click();
      };
      button.addEventListener('click', function () {
        navigator.clipboard.writeText(request.textContent || '').then(function () {
          button.textContent = 'Copied';
          go();
        }, function () {
          button.hidden = true;
          go();
        });
        if (goOn && window.setTimeout) window.setTimeout(go, 1200);
      });
    })();
    // The optional app picker: one click adds the app (it waits for its
    // credentials) and the example request becomes "finish setting it up".
    // Any failure leaves the page as it was; Continue always works.
    (function () {
      var picker = document.getElementById('quick-apps');
      var request = document.getElementById('example-request');
      var status = document.getElementById('quick-status');
      var other = document.getElementById('other-app');
      var cont = document.getElementById('continue');
      if (!picker || !request || !status || !other || !cont || !window.fetch || !window.JSON) return;
      var fallback = request.textContent;
      var clientName = cont.getAttribute('data-client') || 'the chat';
      var chips = picker.querySelectorAll('button[data-adapter]');
      var added = false;
      var busy = false;
      // aria-disabled rather than disabled: a disabled button drops the
      // keyboard focus to the page, and the picked one must stay readable.
      var setDisabled = function (on) {
        for (var i = 0; i < chips.length; i++) chips[i].setAttribute('aria-disabled', on ? 'true' : 'false');
        other.readOnly = on;
      };
      var failed = function (name, message) {
        status.textContent = message || ('Could not add ' + name + ' right now. You can still continue and add it in the chat.');
        busy = false;
        setDisabled(false);
      };
      for (var i = 0; i < chips.length; i++) {
        chips[i].addEventListener('click', function (event) {
          var chip = event.currentTarget;
          var name = chip.getAttribute('data-name') || '';
          if (added || busy) return;
          busy = true;
          setDisabled(true);
          status.textContent = 'Adding ' + name + '…';
          fetch('/auth/first-app', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adapter: chip.getAttribute('data-adapter'), csrf: picker.getAttribute('data-csrf') }),
          }).then(function (r) {
            return r.json().catch(function () { return {}; });
          }).then(function (out) {
            if (!out || out.ok !== true) return failed(name, out && out.error);
            added = true;
            busy = false;
            chip.setAttribute('aria-pressed', 'true');
            request.textContent = out.request;
            status.textContent = out.name + ' added — you’ll finish it in ' + clientName + '.';${telegram ? TELEGRAM_PICK_HOOK : ''}
          }, function () { failed(name); });
        });
      }
      // Shown again after a reload: the app picked before stays added.
      var pickedBefore = picker.getAttribute('data-picked');
      if (pickedBefore) {
        for (var k = 0; k < chips.length; k++) {
          if (chips[k].getAttribute('data-adapter') !== pickedBefore) continue;
          added = true;
          setDisabled(true);
          chips[k].setAttribute('aria-pressed', 'true');
          request.textContent = picker.getAttribute('data-picked-request') || fallback;
          status.textContent = (chips[k].getAttribute('data-name') || '') + ' added — you’ll finish it in ' + clientName + '.';
        }
      }
      other.addEventListener('input', function () {
        if (added) return;
        var app = other.value.replace(/\\s+/g, ' ').trim().slice(0, 60);
        request.textContent = app ? 'Connect my ' + app + ' to AnythingMCP.' : fallback;
      });
      picker.hidden = false;
    })();${telegram ? TELEGRAM_PANEL_SCRIPT : ''}
    // Continue goes back through the authorization and opens nothing else
    // (see the comment above the card). The same click copies the
    // request, to paste in a new chat. Best effort and nothing more: the
    // listener returns at once, never waits for the clipboard, never prevents
    // the default action and opens nothing, so the browser follows the link
    // exactly as it does without it. A refused clipboard changes nothing on
    // the page.
    (function () {
      var cont = document.getElementById('continue');
      var request = document.getElementById('example-request');
      var note = document.getElementById('request-copied');
      if (!cont || !request || !note || !navigator.clipboard || !navigator.clipboard.writeText) return;
      var clientName = cont.getAttribute('data-client') || 'your assistant';
      cont.addEventListener('click', function () {
        try {
          navigator.clipboard.writeText(request.textContent || '').then(function () {
            note.textContent = 'Copied. Paste it in a new chat in ' + clientName + '.';
            note.hidden = false;
          }, function () { /* refused: nothing else happens */ });
        } catch (e) { /* the authorization goes on regardless */ }
      });
    })();${attempt ? continueBeaconScript(attempt) : ''}${attempt ? pausedPageLinksBeaconScript(attempt) : ''}${nextStep && telegram ? autoContinueScript(attempt) : ''}${CONTINUE_ONCE_SCRIPT}
    </script>`;
    return renderAuthPage({
      title: nextStep ? `One more step: go back to ${params.clientName}` : `${params.clientName} is connected`,
      card,
      trust: this.trust(),
      extraStyles: `
  .example { background: var(--surface-2); border-radius: 10px; padding: 12px 14px; font-size: 14px; margin: 0 0 14px;
             display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .example button.copy { width: auto; min-height: 30px; padding: 0 12px; font-size: 13px; font-weight: 500; flex: none;
             background: #fff; color: var(--text); border-color: var(--border-strong); }
  .example button.copy:hover { background: var(--surface); border-color: var(--brand); }
  .copied { font-size: 13px; font-weight: 500; color: var(--text); line-height: 1.45; margin: -6px 0 14px; text-wrap: balance; }
  .copied::before { content: '\\2713\\00a0'; color: var(--ok); font-weight: 700; }
  .copied[hidden] { display: none; }
  .body { color: var(--text-2); font-size: 14px; line-height: 1.5; margin: 0 0 18px; }
  .quick { border: 1px solid var(--border); border-radius: 12px; padding: 12px 12px 4px; margin: 0 0 18px; }
  .quick-title { font-size: 13px; font-weight: 500; color: var(--text); margin: 0 0 10px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; }
  .chips button.chip { width: auto; min-height: 34px; padding: 0 12px; font-size: 13.5px; font-weight: 500;
             background: #fff; color: var(--text); border-color: var(--border-strong); }
  .chips button.chip:hover { background: var(--surface-2); border-color: var(--brand); }
  .chips button.chip:focus-visible, .example button.copy:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
  .chips button.chip[aria-pressed="true"] { background: var(--brand); color: #fff; border-color: var(--brand); }
  .chips button.chip[aria-disabled="true"] { cursor: default; }
  .chips button.chip[aria-disabled="true"]:not([aria-pressed="true"]) { color: var(--text-3); background: #fff; border-color: var(--border); }
  .other-label { font-size: 12.5px; color: var(--text-2); font-weight: 500; }
  input.other { width: 100%; height: 38px; border: 1px solid var(--border); border-radius: 9px; padding: 0 12px;
             font: inherit; font-size: 14px; background: #fff; color: var(--text); margin: 0 0 8px; }
  .quick-status { font-size: 13px; color: var(--text-2); margin: 0 0 8px; line-height: 1.45; }
  .quick-status:empty { margin: 0; }
  .trial { font-size: 13px; color: var(--text-2); margin: 12px 0 0; line-height: 1.5; }
  .trial p { margin: 8px 0 0; text-align: center; }
  .trial a.secondary-link { background: #fff; color: var(--text); border: 1px solid var(--border-strong); }
  .trial a.secondary-link:hover { border-color: var(--brand); color: var(--brand); }
  .sub2 { margin-top: -8px; }
  /* The next_step page has no visible heading: the sentence and the button
     say it all. The heading stays for screen readers and the tab title. */
  h1.vh { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
          clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .flow.next > #first-sub { color: var(--text); font-size: 15px; }
  /* On a phone the first screen holds what matters: one sentence, the app
     picker, the request to copy, Continue (and the optional payment method).
     Claude's in-app browser leaves about 640 px of height. */
  @media (max-width: 480px) {
    .flow.next { display: flex; flex-direction: column; }
    .flow.next > .pair { margin-bottom: 12px; }
    .flow.next > .pair .tile { width: 40px; height: 40px; border-radius: 10px; }
    .flow.next > #first-sub { margin-bottom: 12px; }
    .flow.next > .quick { order: 1; margin-bottom: 12px; }
    .flow.next > .sub2 { order: 2; margin: 0 0 8px; font-size: 13px; }
    .flow.next > .example { order: 3; margin-bottom: 12px; padding: 10px 12px; }
    .flow.next > .copied { order: 4; }
    .flow.next > .auto { order: 5; }
    .flow.next > #continue { order: 6; }
    .flow.next > #card-trial { order: 7; }
    .flow.next > .body { order: 8; margin-top: 18px; }
    .flow.next > .links { order: 9; }
  }

  .auto { font-size: 13.5px; font-weight: 500; color: var(--text); line-height: 1.45; margin: 0 0 12px; }
  .auto[hidden] { display: none; }
  .auto button.stay { width: auto; min-height: 28px; padding: 0 10px; margin-left: 4px; font-size: 12.5px; font-weight: 500;
             background: #fff; color: var(--text); border-color: var(--border-strong); }
  .auto button.stay:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }${telegram ? TELEGRAM_PANEL_STYLES : ''}`,
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
    socialProvider?: string,
  ): Promise<boolean> {
    const consent = await this.loadConsentContext(req);
    // Not an authorize flow — a bare visit to the login page. Nothing to grant.
    if (!consent) return false;

    // A brand-new account authorizing a plugin from OpenAI's directory:
    // record that the sign-up came from there (the sign-up itself looks 'direct').
    const plugin = this.requestedDirectoryPlugin(req);
    if (plugin) await markDirectorySignup(this.prisma, this.productEvents, userId, plugin);

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
      if (targets.length === 1 && (await this.grants.restrictedIn(userId, targets[0].organizationId))) {
        // Member visibility: a restricted member is offered only their own
        // server, which often holds none of the connectors shared with them.
        // The whole workspace gives them every tool their roles allow.
        await this.grants.grantWholeOrganization(consent.clientId, userId, targets[0].organizationId);
      } else if (servers.length === 1) {
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
    if (socialProvider) {
      res.cookie(PENDING_SOCIAL_COOKIE, socialProvider, {
        httpOnly: true,
        secure: isSecure,
        maxAge: 10 * 60 * 1000,
        sameSite: isSecure ? 'none' : 'lax',
        signed: true,
      });
    } else {
      res.clearCookie(PENDING_SOCIAL_COOKIE);
    }
    const csrfToken = randomBytes(32).toString('base64url');
    res.cookie('login_csrf', csrfToken, {
      httpOnly: true,
      secure: isSecure,
      maxAge: 10 * 60 * 1000,
      sameSite: isSecure ? 'none' : 'lax',
      signed: true,
    });

    this.recordStepViewed(req, 'servers');
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
  // A form post of the sign-in pages (CSRF token + signed cookies), not an API: kept out of the OpenAPI doc.
  @Post('select-servers')
  @HttpCode(200) // a page (or a redirect), not a created resource: Nest's default for POST is 201
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async handleServerSelection(
    @Req() req: Request,
    @Body() body: { servers?: string | string[]; workspace?: string; csrf?: string },
    @Res() res: Response,
  ) {
    if (!body || !this.verifyCsrf(req, body.csrf)) {
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
    setLoginUserCookie(req, res, encoded, { maxAge: 60 * 1000, secure: isSecure });
    res.clearCookie('login_csrf');
    res.clearCookie(PENDING_GRANT_COOKIE);
    const social = (req as Request & { signedCookies?: Record<string, unknown> })
      .signedCookies?.[PENDING_SOCIAL_COOKIE];
    res.clearCookie(PENDING_SOCIAL_COOKIE);
    const socialProvider =
      typeof social === 'string' && this.socialProviders().some((p) => p.id === social) ? social : undefined;

    // Picking an empty workspace gets the same first-connector page as
    // signing in to one, for the workspace just granted (Cloud only).
    const callbackUrl = `${this.getBaseUrl(req)}/callback`;
    if (await this.offerAfterApprove(req, res, user.id, encoded, callbackUrl, socialProvider)) return;
    res.redirect(callbackUrl);
  }

  /**
   * The first-connector page's optional app picker (Cloud only): adds one of
   * QUICK_SETUP_APPS to the workspace as a connector waiting for its
   * credentials, through the same setup service as the chat's
   * setup_install_connector (role, plan limit, hourly cap, security event).
   * Nothing secret is taken here; the user finishes the setup in the chat.
   *
   * Nothing from the request is trusted: the CSRF token must match its
   * signed cookie, the identity is the signed login cookie the paused
   * authorization already relies on, the authorization must still be pending,
   * and the app must be one of the page's own. The OAuth flow is untouched:
   * this answers JSON, and "Continue" goes to the callback as before.
   */
  // A form post of the sign-in pages (CSRF token + signed cookies), not an API: kept out of the OpenAPI doc.
  /**
   * For the dashboard, which cannot read the httpOnly cookies: is an
   * authorization waiting in this browser, and what is missing? It shows a
   * "finish connecting" bar on its pages from the answer, so someone who
   * wandered off (sign-up, a new tab to add an app, the card-trial page, a
   * password reset) has a way back. Tells this browser about its own pending
   * authorization only: the client's name and the next step.
   */
  @Get('pending')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async pendingAuthorization(@Req() req: Request, @Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const consent = await this.loadConsentContext(req);
    if (!consent) return res.json({ pending: false });
    return res.json({
      pending: true,
      client: String(consent.clientName).slice(0, 40),
      // 'continue': allowed, only /callback is missing. 'allow': not yet.
      step: this.pendingLoginUserId(req) ? 'continue' : 'allow',
    });
  }

  /**
   * The page after approving into an empty workspace, at an address of its
   * own (see FIRST_OFFER_COOKIE). Everything it needs comes from signed
   * cookies set when the person allowed access; nothing is decided again
   * here. Without them: no open authorization → the "no longer open" page;
   * not signed in for it → back to the sign-in page; nothing to show → on to
   * the callback.
   */
  @Get('next')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async showPausedPage(@Req() req: Request, @Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const consent = await this.loadConsentContext(req);
    if (!consent) {
      if (this.deployment.isCloud()) {
        void this.productEvents
          ?.log({
            event: ProductEvents.AUTHORIZE_REQUEST_CLOSED,
            metadata: { device: deviceOf(req.headers['user-agent']), via: 'next' },
          })
          .catch(() => undefined);
      }
      res.setHeader('Content-Type', 'text/html');
      res.send(renderClosedRequestPage({ trust: this.trust(), dashboardUrl: this.frontendUrl() }));
      return;
    }
    if (!this.pendingLoginUserId(req)) return res.redirect('/auth/login');
    const offer = this.firstOffer(req);
    const callbackUrl = `${this.getBaseUrl(req)}/callback`;
    if (!offer || !this.deployment.isCloud()) return res.redirect(callbackUrl);

    const signed = (req as Request & { signedCookies?: Record<string, unknown> }).signedCookies ?? {};
    const pickerCsrf = this.setupProvider() && typeof signed[FIRST_APP_CSRF_COOKIE] === 'string' ? (signed[FIRST_APP_CSRF_COOKIE] as string) : '';
    const picked = QUICK_SETUP_APPS.find((a) => a.slug === signed[FIRST_APP_PICKED_COOKIE]);
    const dashboard = (this.configService.get<string>('FRONTEND_URL') || '').replace(/\/+$/, '');
    // Someone who signed in here with Google, Microsoft or GitHub has no
    // dashboard session: this page is the only place they signed in. A plain
    // link would land them on the sign-in form in the new tab, where most
    // stopped (card-trial page reached by 11.6% of them in their first 16
    // hours, against 20% of email sign-ups, 21-22 Oct 2026). The dashboard
    // signs them in with the same provider on its own and goes on to the page.
    const dashboardLink = (path: string) =>
      offer.s
        ? `${dashboard}/login?continueWith=${encodeURIComponent(offer.s)}&redirect=${encodeURIComponent(path)}`
        : `${dashboard}${path}`;
    res.setHeader('Content-Type', 'text/html');
    // Never framed: the page finishes an authorization with one click.
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.send(
      this.renderFirstConnectorOffer({
        clientName: consent.clientName,
        redirectHost: consent.redirectHost,
        onPhone: isPhoneUserAgent(req.headers['user-agent']),
        callbackUrl,
        arm: consent.connectedArm,
        attempt: attemptKey(consent.expiresAt),
        welcomeUrl: dashboardLink('/welcome'),
        ...(pickerCsrf ? { pickerCsrf } : {}),
        ...(pickerCsrf && offer.g ? { telegramOneTap: true } : {}),
        ...(picked ? { picked } : {}),
        ...(offer.x ? { trialEnded: true } : {}),
        ...(offer.t
          ? { cardTrial: { endsAt: new Date(offer.t), url: dashboardLink(`/start-trial?source=${POST_APPROVE_SOURCE}&return=%2Fcallback`) } }
          : {}),
      }),
    );
  }

  /** What the page after approving was offered with (FIRST_OFFER_COOKIE), or null. */
  private firstOffer(req: Request): FirstOffer | null {
    const raw = (req as Request & { signedCookies?: Record<string, unknown> }).signedCookies?.[FIRST_OFFER_COOKIE];
    if (typeof raw !== 'string' || !raw) return null;
    try {
      const data = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<FirstOffer>;
      if (typeof data?.o !== 'string' || !data.o) return null;
      return {
        o: data.o,
        ...(typeof data.s === 'string' && /^[a-z]{2,20}$/.test(data.s) ? { s: data.s } : {}),
        ...(typeof data.t === 'number' && Number.isFinite(data.t) && data.t > 0 ? { t: data.t } : {}),
        ...(data.g === 1 ? { g: 1 as const } : {}),
        ...(data.x === 1 ? { x: 1 as const } : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * What the pages of the flow report about a click the server never sees:
   * "Continue" on the page shown to an empty workspace (the link goes to the
   * OAuth library's /callback), the same page going on by itself after the
   * one-tap Telegram bot, and "Create an account" on the sign-in page (a link
   * to the dashboard). Sent with `navigator.sendBeacon`, which never delays
   * the click it reports.
   *
   * Cloud only, like the pages that send it. A statistic and nothing else: it
   * reads the pending authorization, writes one event and always answers 204.
   * It counts only inside the authorization it names: the attempt in the
   * body must be the one of this browser's pending authorization, a value
   * another site cannot know.
   */
  @Post('beacon')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async pageBeacon(@Req() req: Request, @Body() body: { e?: unknown; a?: unknown }, @Res() res: Response) {
    res.status(204).end();
    if (!this.deployment.isCloud() || !this.productEvents) return;
    try {
      const kind = body?.e;
      const kinds = ['continue', 'auto_continue', 'copy_continue', 'create_account', 'open_dashboard', 'payment_method'];
      if (typeof kind !== 'string' || !kinds.includes(kind)) return;
      const consent = await this.loadConsentContext(req);
      const attempt = consent ? attemptKey(consent.expiresAt) : undefined;
      if (!consent || !attempt || body?.a !== attempt) return;
      if (kind === 'create_account') {
        await this.productEvents.log({
          event: ProductEvents.AUTHORIZE_ACTION,
          metadata: { ...this.attemptMeta(req, consent), button: 'create_account' },
        });
        return;
      }
      // Continue exists only for a signed-in person on the paused authorization.
      const userId = this.pendingLoginUserId(req);
      if (!userId) return;
      const account = await this.prisma.user.findUnique({ where: { id: userId }, select: { organizationId: true } });
      if (kind === 'open_dashboard' || kind === 'payment_method') {
        // The two ways off the page that are not Continue.
        await this.productEvents.log({
          event: ProductEvents.AUTHORIZE_ACTION,
          userId,
          organizationId: account?.organizationId ?? null,
          metadata: { ...this.attemptMeta(req, consent), button: kind },
        });
        return;
      }
      await this.productEvents.log({
        event: ProductEvents.POST_APPROVE_CONTINUE_CLICKED,
        userId,
        organizationId: account?.organizationId ?? null,
        metadata: { ...this.attemptMeta(req, consent), button: kind },
      });
    } catch {
      // A lost statistic: nothing to tell the page.
    }
  }

  @Post('first-app')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async pickFirstApp(
    @Req() req: Request,
    @Body() body: { adapter?: unknown; csrf?: unknown },
    @Res() res: Response,
  ) {
    if (!this.deployment.isCloud()) return res.status(404).json({ ok: false, error: 'Not found.' });
    // No "Continue" here: with the authorization gone it would not work either.
    const expired = 'This page has expired. Go back to your AI assistant and press Connect again.';
    if (!this.verifySignedToken(req, FIRST_APP_CSRF_COOKIE, body?.csrf)) {
      this.logger.warn('Rejected a first-app pick with a missing/invalid CSRF token');
      return res.status(403).json({ ok: false, error: expired });
    }
    const app = QUICK_SETUP_APPS.find((a) => a.slug === body?.adapter);
    if (!app) return res.status(400).json({ ok: false, error: 'Unknown app.' });

    const userId = this.pendingLoginUserId(req);
    const consent = await this.loadConsentContext(req);
    const requestedServerId = (req as Request & { signedCookies?: Record<string, unknown> })
      .signedCookies?.[MCP_RESOURCE_COOKIE];
    if (!userId || !consent || (typeof requestedServerId === 'string' && requestedServerId)) {
      return res.status(403).json({ ok: false, error: expired });
    }
    const provider = this.setupProvider();
    if (!provider) {
      return res
        .status(503)
        .json({ ok: false, error: `${app.name} cannot be added here right now. Continue, and add it in the chat.` });
    }

    // The workspace the connection was granted, the same one the page was
    // offered for: a user in several workspaces may have picked another one
    // than their own on "Choose what to connect".
    const account = await this.prisma.user.findUnique({ where: { id: userId }, select: { organizationId: true } });
    const workspace = await this.grantedWorkspace(consent.clientId, userId, account?.organizationId);
    if (!workspace) return res.status(403).json({ ok: false, error: expired });
    const { organizationId } = workspace;
    const redirectUris = [consent.redirectUri];
    const ctx: SetupContext = {
      userId,
      organizationId,
      // So the connector lands on the server(s) this connection was granted.
      serverIds: workspace.serverIds,
      dashboardBase: this.frontendUrl(),
      assistant: assistantForRedirectUris(redirectUris),
      profile: profileForRedirectUris(redirectUris),
    };
    if (!(await provider.canSetUp(ctx).catch(() => false))) {
      return res.status(403).json({
        ok: false,
        error: 'Only workspace admins and editors can add apps. Continue, and ask an admin to add it.',
      });
    }

    let out: SetupCallResult;
    try {
      // Recorded as via 'post_approve', apart from installs the chat makes.
      out = await provider.install(ctx, { adapter: app.slug }, { via: 'post_approve' });
    } catch (err: any) {
      out = { isError: true, body: { error: String(err?.message ?? err) } };
    }
    const reason = out.isError ? (out.body as { error?: unknown } | null)?.error : undefined;
    await this.productEvents
      ?.log({
        event: ProductEvents.POST_APPROVE_APP_PICKED,
        userId,
        organizationId,
        metadata: {
          ...this.attemptMeta(req, consent),
          adapterSlug: app.slug,
          status: out.isError ? 'failed' : 'added',
          ...(typeof reason === 'string' ? { error: reason.slice(0, 160) } : {}),
        },
      })
      .catch(() => undefined);
    if (out.isError) {
      return res.json({
        ok: false,
        error: `${app.name} could not be added right now. You can still continue and add it in the chat.`,
      });
    }
    const telegram =
      app.slug === TELEGRAM_SLUG && out.connectorId
        ? await this.beginTelegramOneTap(req, {
            userId,
            organizationId,
            connectorId: out.connectorId,
            client: consent.clientName,
            redirectHost: consent.redirectHost,
          })
        : null;
    // So a reload of the page shows the app as added, not the picker anew.
    const pickedSecure = this.isSecureRequest(req);
    res.cookie(FIRST_APP_PICKED_COOKIE, app.slug, {
      httpOnly: true,
      secure: pickedSecure,
      maxAge: FIRST_CONNECTOR_PAUSE_MAX_MS,
      sameSite: pickedSecure ? 'none' : 'lax',
      signed: true,
    });
    return res.json({
      ok: true,
      adapter: app.slug,
      name: app.name,
      request: finishSetupRequest(app.name),
      ...(telegram ? { telegram } : {}),
    });
  }

  /**
   * Telegram was just added without a token: where this instance has a
   * manager bot, the link that creates the user's bot in Telegram with one
   * tap, and the link that connects a bot whose username the user changed
   * (`claim`: it opens the manager bot's chat with the setup's code); on a
   * desktop also their QR codes. Null (the page stays as it is) when the
   * feature is off for the workspace, or on any failure.
   */
  private async beginTelegramOneTap(
    req: Request,
    setup: { userId: string; organizationId: string; connectorId: string; client: string; redirectHost?: string },
  ): Promise<{ link: string; claim: string; qr?: string; claimQr?: string; web?: string; claimWeb?: string } | null> {
    const service = this.telegramOneTap();
    if (!service?.isEnabledFor(setup.organizationId)) return null;
    try {
      const started = await service.begin({
        connectorId: setup.connectorId,
        organizationId: setup.organizationId,
        userId: setup.userId,
        // For the bot's messages: "tap Continue to <client>", and for Claude
        // (the same test as the chat tab of Continue) a link to a new chat.
        client: { name: setup.client, claude: (setup.redirectHost ?? '').toLowerCase() === 'claude.ai' },
      });
      if (!started) return null;
      const onPhone = isPhoneUserAgent(req.headers['user-agent']);
      await this.productEvents
        ?.log({
          event: ProductEvents.TELEGRAM_BOT_LINK_OFFERED,
          userId: setup.userId,
          organizationId: setup.organizationId,
          metadata: { adapterSlug: TELEGRAM_SLUG, client: setup.client, device: onPhone ? 'mobile' : 'desktop' },
        })
        .catch(() => undefined);
      return {
        link: started.link,
        claim: started.claimLink,
        // A computer: the QR code for the phone (through this server's own
        // address, so a scan is counted), and Telegram in the browser for
        // someone who has no Telegram app on the computer.
        ...(onPhone
          ? {}
          : {
              qr: telegramQrDataUri(`${this.getBaseUrl(req)}${started.qrPath}`),
              claimQr: telegramQrDataUri(started.claimLink),
              web: started.webLink,
              claimWeb: started.claimWebLink,
            }),
      };
    } catch (err) {
      this.logger.warn(`The one-tap Telegram bot could not be offered (${(err as Error)?.name || 'error'})`);
      return null;
    }
  }

  /**
   * Who is on the first-connector page, for the requests its Telegram panel
   * makes: checked exactly like a pick (pickFirstApp), and the user must be
   * an admin or editor of the workspace the connection was granted. Null
   * when any of it does not hold.
   */
  private async firstAppTelegramCaller(
    req: Request,
    csrf: unknown,
  ): Promise<{ service: TelegramOneTap; userId: string; organizationId: string } | null> {
    if (!this.deployment.isCloud()) return null;
    if (!this.verifySignedToken(req, FIRST_APP_CSRF_COOKIE, csrf)) return null;
    const userId = this.pendingLoginUserId(req);
    const consent = await this.loadConsentContext(req);
    const requestedServerId = (req as Request & { signedCookies?: Record<string, unknown> })
      .signedCookies?.[MCP_RESOURCE_COOKIE];
    if (!userId || !consent || (typeof requestedServerId === 'string' && requestedServerId)) return null;
    const account = await this.prisma.user.findUnique({ where: { id: userId }, select: { organizationId: true } });
    const workspace = await this.grantedWorkspace(consent.clientId, userId, account?.organizationId);
    if (!workspace) return null;
    const member = await this.prisma.organizationMember.findFirst({
      where: { userId, organizationId: workspace.organizationId, deactivatedAt: null },
      select: { role: true },
    });
    if (member?.role !== 'ADMIN' && member?.role !== 'EDITOR') return null;
    const service = this.telegramOneTap();
    if (!service?.isEnabledFor(workspace.organizationId)) return null;
    return { service, userId, organizationId: workspace.organizationId };
  }

  /**
   * The address in the QR code of a creation link (a computer's page shows
   * it, a phone scans it): notes the scan and sends the phone on to Telegram.
   * Open to anyone, like the Telegram link it stands for: the code in it is
   * the one in that link, and the only place it can lead is Telegram's
   * creation screen for this server's own manager bot.
   */
  @Get('first-app/telegram/qr/:code')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async telegramOneTapQr(@Param('code') code: string, @Res() res: Response) {
    const link = await this.telegramOneTap()
      ?.qrScanned(code)
      .catch(() => null);
    if (!link) return res.status(404).type('text/plain').send('Not found');
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, link);
  }

  /**
   * The Telegram panel asks this every two seconds while its page is visible:
   * has the bot been created and its token stored? Read-only for the page,
   * apart from noting the first click on the link (`opened`) and the first
   * time "Link your bot" was shown (`offered`). Protected like a pick: the
   * CSRF token against its signed cookie, the signed login cookie and the
   * pending authorization.
   */
  @Post('first-app/telegram/status')
  // One page asks 30 times a minute; several people can share an address.
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async telegramOneTapStatus(
    @Req() req: Request,
    @Body() body: { csrf?: unknown; opened?: unknown; offered?: unknown; via?: unknown },
    @Res() res: Response,
  ) {
    const caller = await this.firstAppTelegramCaller(req, body?.csrf);
    if (!caller) return res.status(403).json({ ok: false, error: 'This page has expired.' });
    try {
      const status = await caller.service.status({
        organizationId: caller.organizationId,
        userId: caller.userId,
        opened: body?.opened === true,
        openedVia: body?.via === 'web' ? 'web' : 'app',
        claimOffered: body?.offered === true,
        device: isPhoneUserAgent(req.headers['user-agent']) ? 'mobile' : 'desktop',
      });
      return res.json({
        ok: true,
        ...status,
        ...(status.state === 'connected' ? { request: TELEGRAM_CONNECTED_REQUEST } : {}),
      });
    } catch (err) {
      this.logger.warn(`The one-tap Telegram status could not be read (${(err as Error)?.name || 'error'})`);
      // Not final: the page asks again.
      return res.status(503).json({ error: 'Try again.' });
    }
  }

  /**
   * "Already have a bot? Paste its token" on the Telegram panel: checked with
   * Telegram and stored the way the setup page does it, only into the
   * connector this user's pick added and only while it has no token. The
   * token is never logged or sent back.
   */
  @Post('first-app/telegram/token')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async telegramOneTapToken(
    @Req() req: Request,
    @Body() body: { csrf?: unknown; token?: unknown },
    @Res() res: Response,
  ) {
    const caller = await this.firstAppTelegramCaller(req, body?.csrf);
    if (!caller) {
      return res.status(403).json({ ok: false, error: 'This page has expired. Continue, and finish Telegram in the chat.' });
    }
    try {
      const saved = await caller.service.saveToken({
        organizationId: caller.organizationId,
        userId: caller.userId,
        token: body?.token,
      });
      if (!saved.ok) return res.json(saved);
      return res.json({ ...saved, state: 'connected', request: TELEGRAM_CONNECTED_REQUEST });
    } catch (err) {
      this.logger.warn(`A pasted Telegram bot token could not be saved (${(err as Error)?.name || 'error'})`);
      return res.json({ ok: false, error: 'The token could not be saved. Try again.' });
    }
  }

  /** The user id in the signed login cookie of a paused authorization, or null. */
  private pendingLoginUserId(req: Request): string | null {
    // Only a sign-in made for the authorization this browser is in (login-user-cookie.ts).
    const raw = boundLoginUser(req);
    if (!raw) return null;
    try {
      const profile = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { id?: unknown };
      return typeof profile?.id === 'string' && profile.id ? profile.id : null;
    } catch {
      return null;
    }
  }

  /** The user behind this browser's dashboard session, or null (see resolveDashboardSessionUser). */
  private async resolveDashboardSession(
    req: Request,
  ): Promise<SessionUser | null> {
    return resolveDashboardSessionUser(req, {
      authService: this.authService,
      prisma: this.prisma,
      deployment: this.deployment,
    });
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
        sessionId,
        ...(typeof (session as { oauthState?: unknown }).oauthState === 'string'
          ? { clientState: (session as { oauthState: string }).oauthState }
          : {}),
        connectedArm: connectedPageArm(sessionId, {
          cloud: this.deployment.isCloud(),
          setting: this.configService.get<string>(CONNECTED_PAGE_TEST_ENV),
        }),
        signinArm: signInPageArm(sessionId, {
          cloud: this.deployment.isCloud(),
          setting: this.configService.get<string>(SIGNIN_PAGE_TEST_ENV),
        }),
      };
    } catch (e) {
      this.logger.warn('Failed to load OAuth consent context', e as Error);
      return null;
    }
  }

  /**
   * The sign-in form's CSRF token for this render: a signed, httpOnly
   * `login_csrf` cookie that the form's hidden field has to match.
   *
   * Inside a pending authorization the cookie also carries a digest of that
   * authorization, and the same token is handed out again for as long as the
   * browser holds both unchanged. A reload, a second click, or the back
   * button from a provider's page then posts a form that still matches;
   * before, each of them ended in "Your session expired" (46 a day in
   * November 2026, three quarters within a minute of loading the page). The
   * token is never good for another pending authorization, and the consent
   * decision still ends it (completeSignIn).
   */
  private issueLoginCsrf(req: Request, res: Response): string {
    const binding = loginCsrfBinding(req);
    const current = binding
      ? parseLoginCsrf((req as Request & { signedCookies?: Record<string, unknown> }).signedCookies?.login_csrf)
      : null;
    const token =
      current && current.binding === binding ? current.token : randomBytes(32).toString('base64url');
    const isSecure = this.isSecureRequest(req);
    res.cookie('login_csrf', binding ? `${token}.${binding}` : token, {
      httpOnly: true,
      secure: isSecure,
      maxAge: 10 * 60 * 1000, // 10 minutes — long enough to fill the form
      sameSite: isSecure ? 'none' : 'lax',
      signed: true,
    });
    return token;
  }

  /**
   * Double submit for the sign-in form: the token in the signed `login_csrf`
   * cookie must equal `formToken`, and a cookie issued inside a pending
   * authorization only counts while that authorization is the browser's.
   */
  private verifyCsrf(req: Request, formToken: unknown): boolean {
    const current = parseLoginCsrf(
      (req as Request & { signedCookies?: Record<string, unknown> }).signedCookies?.login_csrf,
    );
    if (!current || typeof formToken !== 'string') return false;
    if (current.binding !== null && current.binding !== loginCsrfBinding(req)) return false;
    const a = Buffer.from(current.token);
    const b = Buffer.from(formToken);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** Double submit: the signed cookie `cookieName` must equal `formToken`. */
  private verifySignedToken(req: Request, cookieName: string, formToken: unknown): boolean {
    const cookieToken = (req as Request & { signedCookies?: Record<string, unknown> })
      .signedCookies?.[cookieName];
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

  /**
   * The authorization response for "Cancel": the client's redirect address
   * with `error=access_denied`, its own `state` and the issuer (RFC 9207, as
   * on the code redirect). Null when the address cannot be parsed.
   */
  private deniedRedirect(req: Request, consent: ConsentContext): string | null {
    try {
      const url = new URL(consent.redirectUri);
      url.searchParams.set('error', 'access_denied');
      url.searchParams.set('error_description', 'The request was cancelled on the consent page');
      if (consent.clientState) url.searchParams.set('state', consent.clientState);
      url.searchParams.set('iss', this.getBaseUrl(req));
      return url.toString();
    } catch {
      return null;
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
      <p class="error" id="pick-error" role="alert" hidden>Choose at least one server, or a whole workspace.</p>
      <button type="submit">Connect</button>
    </form>
    <p class="note">You can change this later from Settings, without reconnecting.</p>
    <script>
    // "Everything in this workspace" and single servers exclude each other
    // (the server reads the workspace first): ticking one unticks the other,
    // so what is ticked is what is granted. An empty choice is stopped here
    // instead of going back to the sign-in page.
    (function () {
      var form = document.querySelector('form[action="/auth/select-servers"]');
      var error = document.getElementById('pick-error');
      if (!form || !error || !form.querySelectorAll) return;
      var servers = form.querySelectorAll('input[name="servers"]');
      var whole = form.querySelectorAll('input[name="workspace"]');
      var untick = function (list) { for (var i = 0; i < list.length; i++) list[i].checked = false; };
      var any = function (list) { for (var i = 0; i < list.length; i++) if (list[i].checked) return true; return false; };
      for (var i = 0; i < servers.length; i++) servers[i].addEventListener('change', function (e) { if (e.target.checked) untick(whole); error.hidden = true; });
      for (var j = 0; j < whole.length; j++) whole[j].addEventListener('change', function (e) { if (e.target.checked) untick(servers); error.hidden = true; });
      form.addEventListener('submit', function (e) {
        if (any(servers) || any(whole)) return;
        e.preventDefault();
        error.hidden = false;
      });
    })();
    </script>`;

    return renderAuthPage({
      title: 'Choose what to connect',
      card,
      trust: this.trust(),
      extraStyles: `
  .sub strong { color: var(--text); font-weight: 600; }
  .error[hidden] { display: none; }
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
    /** Cloud social sign-in providers. Ids are fixed strings, names are ours. */
    socialProviders?: { id: string; name: string }[];
    sessionUser?: SessionUser | null;
    /** The MCP server the client asked for, when the signed-in user may see its name. */
    requestedServer?: string | null;
    /** The browser's language, if one of ours (buttons_first arm only). */
    lang?: PageLanguage | null;
  }): string {
    const { error, serverName, consent, csrfToken, ssoProviders, sessionUser, requestedServer } =
      params;
    // The sign-in page test (A3/A4): the buttons_first arm speaks the
    // browser's language and leads with the provider buttons. The control
    // uses the English texts, which are the page as before.
    const buttonsFirst = consent?.signinArm === 'buttons_first';
    const lang: PageLanguage = buttonsFirst && params.lang ? params.lang : 'en';
    const T = signInTexts(lang);
    const socialProviders = params.socialProviders ?? [];
    const server = this.escapeHtml(serverName);
    const client = consent ? this.escapeHtml(consent.clientName) : '';
    const known = consent ? knownClientFor(consent.redirectHost) : null;
    const signupClient = consent ? signupClientFor(consent.clientName, consent.redirectHost) : null;

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

    // Cloud social sign-in, same shape as the SSO buttons: a submit button on
    // the CSRF-protected form. Signing in here also creates the account, so
    // the terms line sits under the buttons.
    const socialHtml = socialProviders.length
      ? socialProviders
          .map(
            (p) =>
              `<button type="submit" name="action" value="social:${this.escapeHtml(p.id)}" formnovalidate class="sso">` +
              providerMarkSvg(p.id) +
              `<span>${fill(T.continueWith, { provider: this.escapeHtml(p.name) })}</span>` +
              `</button>`,
          )
          .join('') +
        `<p class="links">${fill(T.terms, {
          terms: `<a href="https://anythingmcp.com/en/agb" target="_blank" rel="noopener">${T.termsLabel}</a>`,
          privacy: `<a href="https://anythingmcp.com/datenschutz" target="_blank" rel="noopener">${T.privacyLabel}</a>`,
        })}</p>` +
        `<div class="divider"><span>${T.orEmail}</span></div>`
      : '';

    // The pair of tiles shows the client's logo only when the code goes back
    // to that client's own domain (see knownClientFor); otherwise its initial.
    const top = consent
      ? clientTilePair(consent.clientName, consent.redirectHost)
      : `<div class="pair"><div class="tile" title="AnythingMCP">${AMCP_MARK}</div></div>`;

    const heading = consent ? fill(T.heading, { client, server }) : 'Sign in';
    // A4: on buttons_first a signed-out person reads what they get instead
    // of the general sentence, so the buttons stay high on a phone.
    const valueFirst = buttonsFirst && !sessionUser && !!consent;
    const sub = valueFirst
      ? fill(T.value, { client })
      : consent
        ? fill(sessionUser ? T.subSignedIn : T.subSignedOut, { client, server })
        : `Authorize access to ${server} MCP Server`;

    // Claude's and ChatGPT's directories list AnythingMCP Cloud, so the
    // badge appears only there. Each assistant's users see only its own
    // listing (see directoryBadgesFor); any other client sees both.
    const directoryPill =
      signupClient && this.deployment.isCloud() ? directoryBadgeHtml(directoryBadgesFor(signupClient)) : '';

    const DEFAULT_SCOPE = "Access to your organization's MCP tools and connected servers.";
    const toolsLine = requestedServer
      ? fill(T.toolsOn, { server: `<b>${this.escapeHtml(requestedServer)}</b>` })
      : T.tools;
    // The destination is the security-relevant part: a code sent anywhere
    // else than the client the user means to connect is a stolen session.
    // Unknown destinations are shown in amber.
    const consentHtml = consent
      ? `
    <div class="consent">
      <h2>${fill(T.canDo, { client })}</h2>
      <div class="row"><span class="ok">&#10003;</span><span>${toolsLine}</span></div>
      <div class="row"><span class="ok">&#10003;</span><span>${T.readProfile}</span></div>
      <div class="row muted"><span class="no">&ndash;</span><span>${T.noSecrets}</span></div>${
        consent.scopeText && consent.scopeText !== DEFAULT_SCOPE
          ? `
      <div class="row muted"><span class="no">&middot;</span><span>${T.scope} <span class="host">${this.escapeHtml(consent.scopeText)}</span></span></div>`
          : ''
      }
      <div class="returns${known ? '' : ' unknown'}">${fill(sessionUser ? T.sentIfAllow : T.sentAfterSignIn, { host: `<span class="host">${this.escapeHtml(consent.redirectHost)}</span>` })}
        <p class="warn">${fill(T.warn, { cancel: T.cancel })}</p>
      </div>
    </div>`
      : '';

    const denyButton = consent
      ? `<button type="submit" name="action" value="deny" formnovalidate class="secondary">${T.cancel}</button>`
      : '';

    const submitLabel = consent ? T.signInAllow : 'Sign in';

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
    //
    // `client` tells the sign-up page who sent them: it picks the directory
    // badges the same way this page does.
    const signupHref =
      '/login?mode=register&amp;redirect=%2Fauth%2Flogin' + (signupClient ? `&amp;client=${signupClient}` : '');
    const offerSignup = !sessionUser && this.deployment.isCloud();
    const signupHtml =
      offerSignup && !error && !buttonsFirst
        ? `
    <div class="signup">
      <p class="signup-lead"><strong>New to ${server}?</strong> Create your account first.
        You come straight back here to finish connecting${consent ? ` ${client}` : ''}.</p>
      <a class="signup-btn" href="${signupHref}">Create an account</a>
    </div>
    <div class="divider signup-divider"><span>Already have an account? Sign in</span></div>`
        : '';
    const preAuthLinks = sessionUser
      ? ''
      : `
      <p class="links"><a href="/forgot-password">${T.forgot}</a></p>` +
        (offerSignup && buttonsFirst
          ? `
      <p class="links">${T.noAccount} <a id="signup-link" href="${signupHref}">${T.createWithEmail}</a></p>`
          : '') +
        (offerSignup && error && !buttonsFirst
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
      <div class="acct"><span>${fill(T.signedInAs, { email: `<strong>${this.escapeHtml(sessionUser.email)}</strong>` })}</span><a href="/auth/login?switch=1">${T.switchAccount}</a></div>
      ${buttons(`<button type="submit" name="action" value="approve-session" autofocus>${T.allow}</button>`)}`
      : `
      ${socialHtml}${ssoHtml}
      <label for="email">${T.email}</label>
      <input type="email" id="email" name="email" required${
        // With provider buttons above it, focusing the field scrolled a phone
        // past the heading and the buttons on load.
        socialProviders.length ? '' : ' autofocus'
      } autocomplete="email" placeholder="you@company.com">
      <label for="password">${T.password}</label>
      <input type="password" id="password" name="password" required autocomplete="current-password" placeholder="${T.passwordPlaceholder}">
      ${buttons(`<button type="submit" name="action" value="approve">${submitLabel}</button>`)}
      ${preAuthLinks}`;

    // On a phone the consent box moves under the buttons, and this short
    // form of its last part (where access goes, and to cancel otherwise)
    // stays right above them: the destination warning is never below the
    // button it is about.
    const returnsCompact = consent
      ? `
    <p class="returns-compact${known ? '' : ' unknown'}">${fill(sessionUser ? T.sentIfAllow : T.sentAfterSignIn, { host: `<span class="host">${this.escapeHtml(consent.redirectHost)}</span>` })}. ${fill(T.warn, { cancel: T.cancel })}</p>`
      : '';
    // The click on "Create an account" (authorize_action create_account):
    // a beacon that never delays the link.
    const attempt = consent ? attemptKey(consent.expiresAt) : undefined;
    const signupBeacon =
      offerSignup && attempt && /^[0-9a-z]{6,12}$/.test(attempt)
        ? `
    <script>
    (function () {
      var links = document.querySelectorAll('.signup-btn, #signup-link');
      if (!links.length || !navigator.sendBeacon || !window.URLSearchParams) return;
      for (var i = 0; i < links.length; i++) links[i].addEventListener('click', function () {
        try { navigator.sendBeacon('/auth/beacon', new URLSearchParams({ e: 'create_account', a: '${attempt}' })); } catch (e) {}
      });
    })();
    </script>`
        : '';

    const card = `
    <div class="flow login${buttonsFirst ? ' bf' : ''}">
    ${top}
    <h1>${heading}</h1>
    <p class="sub${valueFirst ? ' value' : ''}">${sub}</p>${directoryPill}${signupHtml}
    ${errorHtml}
    ${consentHtml}${returnsCompact}
    <form method="POST" action="/auth/login">
      <input type="hidden" name="csrf" value="${this.escapeHtml(csrfToken)}">${formHtml}
    </form>
    </div>${signupBeacon}`;

    return renderAuthPage({
      title: `${sessionUser ? T.titleAuthorize : T.titleSignIn} — ${serverName}`,
      lang,
      card,
      trust: this.trust(),
      // On a phone (Claude's in-app browser leaves about 640 px) the buttons
      // come right after the heading: "Allow access", or the provider
      // buttons. The consent box, the sign-up box and the directory badge
      // follow the form.
      extraStyles: `
  .returns-compact { display: none; font-size: 12.5px; color: var(--text-2); line-height: 1.45; margin: 0 0 12px; text-align: center; }
  .returns-compact .host { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; color: var(--text); }
  .returns-compact.unknown { color: #92400e; }
  .returns-compact.unknown .host { color: #b45309; }
  @media (max-width: 480px) {
    .flow.login { display: flex; flex-direction: column; }
    .flow.login > .pair { margin-bottom: 12px; }
    .flow.login > .sub { margin-bottom: 12px; }
    .flow.login > .returns-compact { display: block; }
    .flow.login > form { order: 1; }
    .flow.login > .signup-divider { display: none; }
    .flow.login > .signup { order: 2; margin-top: 18px; }
    .flow.login > .consent { order: 3; margin: 18px 0 0; }
    .flow.login > .consent .returns { display: none; }
    .flow.login > .verified { order: 4; margin: 16px auto 0; }
  }
  .sub.value { color: var(--text); }
  /* buttons_first arm (A3): the phone order on every screen. */
  .flow.login.bf { display: flex; flex-direction: column; }
  .flow.login.bf > .returns-compact { display: block; }
  .flow.login.bf > form { order: 1; }
  .flow.login.bf > .consent { order: 3; margin: 18px 0 0; }
  .flow.login.bf > .consent .returns { display: none; }
  .flow.login.bf > .verified { order: 4; margin: 16px auto 0; }`,
    });
  }

  /** Cloud: the code step of the authorization (see askForEmailCode). */
  private renderEmailCodePage(params: {
    consent: ConsentContext | null;
    maskedEmail: string;
    csrfToken: string;
    socialProviders: { id: string; name: string }[];
    error?: string;
    notice?: string;
  }): string {
    const { consent, maskedEmail, csrfToken, socialProviders, error, notice } = params;
    const serverName = this.configService.get<string>('MCP_SERVER_NAME') || 'AnythingMCP';
    const client = consent ? this.escapeHtml(consent.clientName) : '';
    const top = consent
      ? clientTilePair(consent.clientName, consent.redirectHost)
      : `<div class="pair"><div class="tile" title="AnythingMCP">${AMCP_MARK}</div></div>`;
    const errorHtml = error ? `<div class="error" role="alert">${this.escapeHtml(error)}</div>` : '';
    const noticeHtml = notice ? `<p class="note" role="status">${this.escapeHtml(notice)}</p>` : '';
    const purpose = consent ? `to finish connecting <strong>${client}</strong>` : 'to finish signing in';

    // Same buttons as on the sign-in page; here they verify the address at once.
    const socialHtml = socialProviders.length
      ? '<div class="divider"><span>or</span></div>' +
        socialProviders
          .map(
            (p) =>
              `<button type="submit" formaction="/auth/verify-email/social/${this.escapeHtml(encodeURIComponent(p.id))}" formnovalidate class="sso">` +
              providerMarkSvg(p.id) +
              `<span>Continue with ${this.escapeHtml(p.name)}</span>` +
              `</button>`,
          )
          .join('') +
        `<p class="links">If this address is a ${socialProviders.map((p) => this.escapeHtml(p.name)).join(' or ')} account, continuing with it verifies the address without a code. You then sign in that way instead of with your password.</p>`
      : '';

    // The code field and "Verify and continue" come first in the form, so
    // Enter in the field verifies (the first submit button). Every other
    // button posts the same CSRF field to its own route (`formaction`).
    const card = `
    ${top}
    <h1>Check your email</h1>
    <p class="sub">We sent a 6-digit code to <strong>${this.escapeHtml(maskedEmail)}</strong>. Enter it ${purpose}.</p>
    ${errorHtml}${noticeHtml}
    <form method="POST" action="/auth/verify-email">
      <input type="hidden" name="csrf" value="${this.escapeHtml(csrfToken)}">
      <label for="code">Verification code</label>
      <input type="text" id="code" name="code" required autofocus inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" placeholder="123456">
      <button type="submit">Verify and continue</button>
      <button type="submit" formaction="/auth/verify-email/resend" formnovalidate class="secondary">Send a new code</button>
      <button type="submit" formaction="/auth/verify-email/continue" formnovalidate class="secondary">I opened the link in the email</button>
      ${socialHtml}
    </form>
    <p class="links">No email? Check the spam folder. <a href="/auth/login?switch=1">Use a different account</a></p>`;

    return renderAuthPage({
      title: `Verify your email — ${serverName}`,
      card,
      trust: this.trust(),
      extraStyles: `
  .sub strong { color: var(--text); font-weight: 600; }
  form button.secondary { margin-top: 8px; }
  #code { letter-spacing: .3em; font-variant-numeric: tabular-nums; }`,
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
