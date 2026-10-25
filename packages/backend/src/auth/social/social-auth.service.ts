import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import * as oidc from 'openid-client';
import type { User } from '../../generated/prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { findUsersByEmail, normalizeEmail } from '../../common/email.util';
import { SecurityEventService, SecurityEvents } from '../../audit/security-event.service';
import { ProductEventService, ProductEvents } from '../../audit/product-event.service';
import { AdsSignupService } from '../../audit/ads-signup.service';
import { SsoEnforcementService } from '../sso-enforcement.service';
import { isDisposableEmail } from '../disposable-email.util';
import { CloudAccountService, LoginResponse } from './cloud-account.service';
import {
  SocialProfile,
  SocialProviderAdapter,
  SocialProviderError,
  SocialProviderId,
  SocialProviderRegistry,
} from './social-providers';

/** One round trip to the provider may take this long, including a slow login there. */
const ATTEMPT_TTL_MS = 10 * 60 * 1000;
/** The dashboard exchanges its one-time code immediately after the redirect. */
const HANDOFF_TTL_MS = 60 * 1000;

/** The cookie that ties a round trip to the browser that started it. */
export const SOCIAL_BIND_COOKIE = 'amcp_social_bind';
/** Only sent to the callback. */
export const SOCIAL_BIND_COOKIE_PATH = '/auth/social';

export type SocialSurface = 'DASHBOARD' | 'LINK' | 'MCP';

/**
 * A refusal. `reason` goes to the audit trail; `userMessage` is the only text
 * the person sees, and never says more than they already know.
 */
export class SocialAuthError extends Error {
  constructor(
    readonly reason: string,
    readonly userMessage = 'Sign-in failed. Please try again.',
    /** Where the browser should be sent back to show the message. */
    readonly surface: SocialSurface | null = null,
  ) {
    super(reason);
  }
}

export type SocialCompletion =
  | { kind: 'LOGIN'; handoffCode: string; returnTo: string }
  | { kind: 'LINK'; returnTo: string; provider: SocialProviderId }
  | { kind: 'MCP'; provider: SocialProviderId; user: { id: string; email: string; name: string | null } };

interface RequestContext {
  ip?: string;
  userAgent?: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Only an internal, absolute path may be returned to. A full URL, a
 * protocol-relative `//evil.tld` or a backslash variant would make the
 * callback an open redirect.
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

/**
 * Cloud social sign-in (Google, Microsoft, GitHub): the round trip to the
 * provider, and turning what it returns into a local account.
 *
 * Three surfaces share one flow:
 *  - DASHBOARD: sign-in or sign-up from /login. Ends with a one-time code the
 *    dashboard exchanges for a session, so no token ever sits in a URL.
 *  - MCP: the consent page an AI client opens to connect. Ends in the same
 *    place a password sign-in there ends.
 *  - LINK: a signed-in user connects a provider in Settings.
 *
 * Accounts are matched on (provider, subject), never on the email. An email
 * only matters the first time, and only when the provider vouches for it:
 * then it may create a workspace, or attach to the account that already has
 * that address.
 */
@Injectable()
export class SocialAuthService {
  private readonly logger = new Logger(SocialAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly providers: SocialProviderRegistry,
    private readonly accounts: CloudAccountService,
    private readonly securityEvents: SecurityEventService,
    private readonly ssoEnforcement: SsoEnforcementService,
    @Optional() private readonly productEvents?: ProductEventService,
    @Optional() private readonly adsSignup?: AdsSignupService,
  ) {}

  /** The providers to offer, for the sign-in pages. */
  enabledProviders() {
    return this.providers.enabled();
  }

  private frontendUrl(): string {
    return (
      this.config.get<string>('FRONTEND_URL') ||
      this.config.get<string>('SERVER_URL') ||
      'http://localhost:3000'
    ).replace(/\/$/, '');
  }

  /**
   * The redirect URI registered at the provider. From server configuration
   * only: a spoofed `x-forwarded-host` must never reach it.
   */
  redirectUri(provider: SocialProviderId): string {
    return `${this.frontendUrl()}/auth/social/${provider}/callback`;
  }

  private adapter(provider: unknown): SocialProviderAdapter {
    const adapter = this.providers.get(provider);
    if (!adapter) {
      throw new SocialAuthError('provider_unavailable', 'This sign-in option is not available.');
    }
    return adapter;
  }

  /**
   * Starts a round trip. Returns the provider URL and the binding token the
   * caller must set as the `amcp_social_bind` cookie; only its hash is stored.
   */
  async start(input: {
    provider: unknown;
    surface: SocialSurface;
    returnTo?: string;
    attribution?: Record<string, unknown> | null;
    linkUserId?: string;
    oauthSessionId?: string;
  }): Promise<{ authorizationUrl: string; bindingToken: string }> {
    const adapter = this.adapter(input.provider);
    if (input.surface === 'MCP' && !input.oauthSessionId) {
      throw new SocialAuthError(
        'mcp_without_oauth_session',
        'Your authorization request expired. Start again from your AI client.',
        'MCP',
      );
    }
    if (input.surface === 'LINK' && !input.linkUserId) {
      throw new SocialAuthError('link_without_user', 'Please sign in again.', 'LINK');
    }

    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const bindingToken = randomBytes(32).toString('base64url');

    const authorizationUrl = await adapter.authorizationUrl({
      redirectUri: this.redirectUri(adapter.id),
      state,
      nonce,
      codeChallenge,
    });

    // Sign-in starts are anonymous, so nothing else would ever clear these.
    void this.prisma.socialLoginAttempt
      .deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } } })
      .catch(() => undefined);

    await this.prisma.socialLoginAttempt.create({
      data: {
        state,
        nonce,
        codeVerifier,
        provider: adapter.id,
        surface: input.surface,
        browserBindingHash: sha256(bindingToken),
        linkUserId: input.linkUserId ?? null,
        oauthSessionId: input.oauthSessionId ?? null,
        returnTo: safeReturnTo(input.returnTo),
        attribution: (input.attribution ?? undefined) as any,
        expiresAt: new Date(Date.now() + ATTEMPT_TTL_MS),
      },
    });

    return { authorizationUrl: authorizationUrl.href, bindingToken };
  }

  /**
   * Finishes a round trip. `currentUrl` is the callback URL as received;
   * `bindingToken` and `oauthSessionId` are the browser's cookies.
   */
  async complete(
    provider: string,
    currentUrl: URL,
    browser: { bindingToken?: string; oauthSessionId?: string },
    ctx: RequestContext = {},
  ): Promise<SocialCompletion> {
    const state = currentUrl.searchParams.get('state');
    if (!state) throw new SocialAuthError('missing_state');

    // Consumed atomically: two concurrent callbacks with the same state cannot
    // both get past this line.
    const claimed = await this.prisma.socialLoginAttempt.updateMany({
      where: { state, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new SocialAuthError('state_replayed_or_expired', 'This sign-in link has expired. Please try again.');
    }
    const attempt = await this.prisma.socialLoginAttempt.findUnique({ where: { state } });
    if (!attempt) throw new SocialAuthError('attempt_vanished');
    const surface = attempt.surface as SocialSurface;
    const fail = (reason: string, message?: string) => new SocialAuthError(reason, message, surface);

    if (attempt.provider !== provider) throw fail('provider_mismatch');

    // The browser that comes back must be the one that left: otherwise a
    // victim could be made to finish an attacker's round trip (or the other
    // way round) and end up signed in to the wrong account.
    if (!browser.bindingToken || !sameHash(sha256(browser.bindingToken), attempt.browserBindingHash)) {
      throw fail('browser_binding_mismatch', 'Sign-in could not be completed in this browser. Please try again.');
    }
    if (surface === 'MCP' && (!browser.oauthSessionId || browser.oauthSessionId !== attempt.oauthSessionId)) {
      throw fail('mcp_session_binding_mismatch', 'Your authorization request expired. Start again from your AI client.');
    }

    const providerError = currentUrl.searchParams.get('error');
    if (providerError) {
      throw fail(
        `provider_error:${providerError.slice(0, 60)}`,
        providerError === 'access_denied'
          ? 'Sign-in was cancelled.'
          : 'The provider could not sign you in. Please try again.',
      );
    }

    const adapter = this.adapter(attempt.provider);
    let profile: SocialProfile;
    try {
      profile = await adapter.complete({
        currentUrl,
        state: attempt.state,
        nonce: attempt.nonce,
        codeVerifier: attempt.codeVerifier,
      });
    } catch (err: any) {
      const reason = err instanceof SocialProviderError ? err.reason : 'token_exchange_failed';
      this.logger.warn(`Social sign-in with ${attempt.provider} failed: ${err?.message ?? err}`);
      throw fail(reason, 'The provider could not sign you in. Please try again.');
    }

    if (surface === 'LINK') {
      await this.link(attempt.linkUserId, adapter, profile, ctx);
      return { kind: 'LINK', returnTo: safeReturnTo(attempt.returnTo), provider: adapter.id };
    }

    const { user, isNewUser } = await this.resolveAccount(adapter, profile, surface, ctx, attempt.attribution);

    await this.securityEvents.log({
      event: SecurityEvents.SOCIAL_LOGIN_SUCCESS,
      actorType: 'USER',
      organizationId: user.organizationId,
      actorUserId: user.id,
      metadata: { provider: adapter.id, surface, isNewUser },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    if (surface === 'MCP') {
      return { kind: 'MCP', provider: adapter.id, user: { id: user.id, email: user.email, name: user.name } };
    }

    const handoffCode = randomBytes(32).toString('base64url');
    await this.prisma.socialLoginAttempt.update({
      where: { id: attempt.id },
      data: {
        handoffCodeHash: sha256(handoffCode),
        resolvedUserId: user.id,
        isNewUser,
        expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
      },
    });
    return { kind: 'LOGIN', handoffCode, returnTo: safeReturnTo(attempt.returnTo) };
  }

  /** Trades the one-time code from the redirect for a dashboard session. Single use. */
  async exchange(code: unknown): Promise<LoginResponse & { isNewUser: boolean }> {
    const invalid = new SocialAuthError('handoff_invalid_or_expired', 'This sign-in link has expired. Please try again.');
    if (typeof code !== 'string' || !code) throw invalid;
    const hash = sha256(code);
    const attempt = await this.prisma.socialLoginAttempt.findUnique({ where: { handoffCodeHash: hash } });
    if (!attempt?.resolvedUserId || attempt.expiresAt <= new Date()) throw invalid;
    // Burned before the session is minted; a second exchange finds nothing.
    const burned = await this.prisma.socialLoginAttempt.deleteMany({
      where: { id: attempt.id, handoffCodeHash: hash },
    });
    if (burned.count !== 1) throw invalid;

    const user = await this.prisma.user.findUnique({ where: { id: attempt.resolvedUserId } });
    if (!user) throw invalid;
    await this.assertMayEnter(user);
    return { ...(await this.accounts.loginResponse(user)), isNewUser: attempt.isNewUser };
  }

  // ── Account resolution ────────────────────────────────────────────────────

  /** An account that exists but must not be entered this way. */
  private async assertMayEnter(user: User): Promise<void> {
    if (user.passwordLoginDisabled || (await this.ssoEnforcement.isPasswordLoginBlocked(user.id))) {
      throw new SocialAuthError(
        'idp_enforced',
        'Your organization requires its own single sign-on for this account.',
      );
    }
    const member = await this.prisma.organizationMember.findFirst({
      where: { userId: user.id, deactivatedAt: null },
      select: { userId: true },
    });
    if (!member) {
      throw new SocialAuthError('no_active_workspace', 'This account has no active workspace.');
    }
  }

  private async resolveAccount(
    adapter: SocialProviderAdapter,
    profile: SocialProfile,
    surface: SocialSurface,
    ctx: RequestContext,
    attribution: unknown,
    retried = false,
  ): Promise<{ user: User; isNewUser: boolean }> {
    const fail = (reason: string, message?: string) => new SocialAuthError(reason, message, surface);

    // 1. Seen before: the subject decides, whatever the email says today.
    const identity = await this.prisma.socialIdentity.findUnique({
      where: { provider_subject: { provider: adapter.id, subject: profile.subject } },
      include: { user: true },
    });
    if (identity) {
      try {
        await this.assertMayEnter(identity.user);
      } catch (err) {
        if (err instanceof SocialAuthError) throw fail(err.reason, err.userMessage);
        throw err;
      }
      await this.prisma.socialIdentity.update({
        where: { id: identity.id },
        data: { lastLoginAt: new Date(), email: profile.email },
      });
      return { user: identity.user, isNewUser: false };
    }

    // 2. First time with this provider account. Only an address the provider
    //    vouches for may create an account or attach to one.
    if (!profile.email) {
      throw fail(
        'provider_no_email',
        `Your ${adapter.label} account did not share a verified email address. Sign up with your email address instead.`,
      );
    }
    if (!profile.emailVerified) {
      throw fail(
        'email_not_verified_by_provider',
        `${adapter.label} could not confirm your email address. Sign up with your email address, then connect ${adapter.label} in Settings.`,
      );
    }
    const email = normalizeEmail(profile.email);
    const owners = await findUsersByEmail<User>(this.prisma, email);
    if (owners.length > 1) {
      throw fail('ambiguous_email', 'Please sign in with your email and password, then connect this account in Settings.');
    }

    // 3. The address has an account: attach to it.
    if (owners.length === 1) {
      const owner = owners[0];
      const sameProvider = await this.prisma.socialIdentity.findUnique({
        where: { userId_provider: { userId: owner.id, provider: adapter.id } },
        select: { id: true },
      });
      if (sameProvider) {
        throw fail(
          'user_already_linked_at_provider',
          `Your account is already connected to a different ${adapter.label} account.`,
        );
      }
      try {
        await this.assertMayEnter(owner);
      } catch (err) {
        if (err instanceof SocialAuthError) throw fail(err.reason, err.userMessage);
        throw err;
      }

      // An address nobody ever verified was typed by someone who never proved
      // they own the mailbox; the provider just did. Whatever that someone set
      // up (a password, live sessions) is dropped, so a sign-up made in
      // advance with a victim's address cannot be used to get into the
      // account the victim is now taking over.
      const reclaim = !owner.emailVerified;
      const now = new Date();
      await this.prisma.$transaction(async (tx) => {
        if (reclaim) {
          await tx.user.update({
            where: { id: owner.id },
            data: { passwordHash: null, sessionsValidFrom: now, emailVerified: true },
          });
          await tx.emailVerificationToken.updateMany({
            where: { userId: owner.id, usedAt: null },
            data: { usedAt: now },
          });
          await tx.passwordResetToken.updateMany({
            where: { userId: owner.id, usedAt: null },
            data: { usedAt: now },
          });
        }
        await tx.socialIdentity.create({
          data: {
            userId: owner.id,
            provider: adapter.id,
            subject: profile.subject,
            tenantId: profile.tenantId ?? null,
            email,
            lastLoginAt: now,
          },
        });
      });

      if (reclaim) {
        await this.securityEvents.log({
          event: SecurityEvents.SOCIAL_ACCOUNT_RECLAIMED,
          actorType: 'USER',
          organizationId: owner.organizationId,
          actorUserId: owner.id,
          targetUserId: owner.id,
          metadata: { provider: adapter.id },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        await this.accounts.ensureCloudTrial(owner.id);
        void this.adsSignup?.onEmailVerified(owner.id);
      }
      await this.securityEvents.log({
        event: SecurityEvents.SOCIAL_IDENTITY_LINKED,
        actorType: 'USER',
        organizationId: owner.organizationId,
        actorUserId: owner.id,
        metadata: { provider: adapter.id, mode: 'email_match', surface },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      const user = await this.prisma.user.findUnique({ where: { id: owner.id } });
      return { user: user ?? owner, isNewUser: false };
    }

    // 4. A new workspace.
    if (this.config.get<string>('ALLOW_OPEN_REGISTRATION') !== 'true') {
      throw fail('registration_closed', 'New sign-ups are closed on this instance.');
    }
    if (isDisposableEmail(email)) {
      throw fail('disposable_email', 'Please use a permanent email address.');
    }

    let user: User;
    try {
      user = await this.accounts.createPasswordlessAccount({
        email,
        name: profile.name,
        emailVerified: true,
      });
      await this.prisma.socialIdentity.create({
        data: {
          userId: user.id,
          provider: adapter.id,
          subject: profile.subject,
          tenantId: profile.tenantId ?? null,
          email,
          lastLoginAt: new Date(),
        },
      });
    } catch (err: any) {
      // Someone created this address, or this provider account, a moment ago.
      if (err?.code === 'P2002' && !retried) {
        return this.resolveAccount(adapter, profile, surface, ctx, attribution, true);
      }
      throw err;
    }

    // Awaited on purpose: the ad report reads this row back.
    if (attribution && typeof attribution === 'object' && this.productEvents) {
      await this.productEvents.log({
        event: ProductEvents.SIGNUP_ATTRIBUTED,
        userId: user.id,
        organizationId: user.organizationId,
        metadata: attribution as Record<string, unknown>,
      });
    }
    // The dashboard runs the same licence step as after a password sign-in
    // (trial or card trial); the MCP page has no such step, so the trial is
    // started here, as the email verification does.
    if (surface === 'MCP') await this.accounts.ensureCloudTrial(user.id);
    void this.adsSignup?.onEmailVerified(user.id);

    await this.securityEvents.log({
      event: SecurityEvents.SOCIAL_SIGNUP,
      actorType: 'USER',
      organizationId: user.organizationId,
      actorUserId: user.id,
      metadata: { provider: adapter.id, surface },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { user, isNewUser: true };
  }

  // ── Connected accounts (Settings) ─────────────────────────────────────────

  private async link(
    userId: string | null,
    adapter: SocialProviderAdapter,
    profile: SocialProfile,
    ctx: RequestContext,
  ): Promise<void> {
    const fail = (reason: string, message: string) => new SocialAuthError(reason, message, 'LINK');
    if (!userId) throw fail('link_without_user', 'Please sign in again.');

    const existing = await this.prisma.socialIdentity.findUnique({
      where: { provider_subject: { provider: adapter.id, subject: profile.subject } },
    });
    if (existing) {
      if (existing.userId === userId) return;
      throw fail(
        'identity_linked_to_another_user',
        `That ${adapter.label} account is already connected to a different AnythingMCP account.`,
      );
    }
    const sameProvider = await this.prisma.socialIdentity.findUnique({
      where: { userId_provider: { userId, provider: adapter.id } },
      select: { id: true },
    });
    if (sameProvider) {
      throw fail(
        'user_already_linked_at_provider',
        `Your account is already connected to ${adapter.label}. Disconnect it first to use a different one.`,
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw fail('link_without_user', 'Please sign in again.');
    await this.prisma.socialIdentity.create({
      data: {
        userId,
        provider: adapter.id,
        subject: profile.subject,
        tenantId: profile.tenantId ?? null,
        email: profile.email ? normalizeEmail(profile.email) : null,
        lastLoginAt: new Date(),
      },
    });
    await this.securityEvents.log({
      event: SecurityEvents.SOCIAL_IDENTITY_LINKED,
      actorType: 'USER',
      organizationId: user.organizationId,
      actorUserId: userId,
      metadata: { provider: adapter.id, mode: 'settings' },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  /** The providers a user may connect, and which are connected. */
  async listForUser(userId: string) {
    const [identities, user] = await Promise.all([
      this.prisma.socialIdentity.findMany({ where: { userId } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } }),
    ]);
    return {
      hasPassword: !!user?.passwordHash,
      providers: this.providers.enabled().map((p) => {
        const identity = identities.find((i) => i.provider === p.id);
        return {
          id: p.id,
          name: p.name,
          connected: !!identity,
          email: identity?.email ?? null,
          connectedAt: identity?.createdAt ?? null,
          lastLoginAt: identity?.lastLoginAt ?? null,
        };
      }),
    };
  }

  /**
   * Disconnects a provider. Refuses when it would leave the account with no
   * way in: no password and no other connected provider.
   */
  async unlink(userId: string, provider: unknown, ctx: RequestContext = {}): Promise<void> {
    const adapterId = typeof provider === 'string' ? provider : '';
    const identity = await this.prisma.socialIdentity.findUnique({
      where: { userId_provider: { userId, provider: adapterId } },
    });
    if (!identity) throw new SocialAuthError('identity_not_linked', 'This account is not connected.', 'LINK');

    const [user, others] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true, organizationId: true } }),
      this.prisma.socialIdentity.count({ where: { userId, id: { not: identity.id } } }),
    ]);
    if (!user?.passwordHash && others === 0) {
      throw new SocialAuthError(
        'would_lock_account_out',
        'Set a password first: this is the only way you can sign in.',
        'LINK',
      );
    }
    await this.prisma.socialIdentity.delete({ where: { id: identity.id } });
    await this.securityEvents.log({
      event: SecurityEvents.SOCIAL_IDENTITY_UNLINKED,
      actorType: 'USER',
      organizationId: user?.organizationId ?? null,
      actorUserId: userId,
      metadata: { provider: identity.provider },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  /** Records a refused sign-in. Never throws. */
  async logFailure(err: unknown, provider: string, ctx: RequestContext = {}): Promise<void> {
    const reason = err instanceof SocialAuthError ? err.reason : 'unexpected_error';
    if (!(err instanceof SocialAuthError)) {
      this.logger.error(`Unexpected social sign-in error: ${(err as any)?.message ?? err}`);
    }
    await this.securityEvents.log({
      event: SecurityEvents.SOCIAL_LOGIN_FAILED,
      actorType: 'ANONYMOUS',
      metadata: { provider: provider.slice(0, 32), reason },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
}
