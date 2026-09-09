import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import * as client from 'openid-client';
import { PrismaService } from '../common/prisma.service';
import { RoleSyncService } from './role-sync.service';
import { DeploymentService } from '../common/deployment.service';
import { AuthService } from '../auth/auth.service';
import { assertSafeOutboundUrl } from '../common/ssrf.util';
import {
  SecurityEventService,
  SecurityEvents,
} from '../audit/security-event.service';
import { IdentityProvidersService } from './identity-providers.service';
import { assertIssuerAllowed, MSA_TENANT_ID } from './provider-config';

/**
 * Thrown for every rejection. The `reason` is audited; the message is generic.
 *
 * `audited` marks the reasons the service has ALREADY written a security event
 * for, with the organization, provider and subject attached. The controller
 * logs everything else, but only knows the reason — without this flag those
 * rejections produced two rows for one event, the second one context-free, and
 * an auditor reading the trail would double-count every refusal.
 */
export class SsoError extends Error {
  constructor(
    readonly reason: string,
    message = 'Sign-in failed',
    readonly audited = false,
  ) {
    super(message);
  }
}

/**
 * What the callback produced.
 *
 * Discriminated rather than an optional `handoffCode`, so the controller cannot
 * accidentally mint a session for a link: forgetting to check would not compile.
 */
export type SsoCompletion =
  | { kind: 'LOGIN'; handoffCode: string; returnTo: string }
  | { kind: 'LINK'; returnTo: string }
  /**
   * The MCP authorization surface. Carries the profile the OAuth strategy
   * expects in the short-lived `login_user` cookie — the same shape the
   * password path produces, so the rest of the authorization flow cannot tell
   * the two apart.
   */
  | {
      kind: 'MCP';
      profile: { id: string; email: string; name: string | null; username: string };
    };

/** How long a user has to complete the trip to the provider and back. */
const ATTEMPT_TTL_MS = 5 * 60 * 1000;
/** How long the SPA has to trade the one-time code for a session. */
const HANDOFF_TTL_MS = 30 * 1000;

@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly deployment: DeploymentService,
    private readonly providers: IdentityProvidersService,
    private readonly authService: AuthService,
    private readonly securityEvents: SecurityEventService,
    private readonly roleSync: RoleSyncService,
  ) {}

  /**
   * The redirect URI registered at the provider.
   *
   * Built from server-side config ONLY. `login.controller.ts` has a sibling
   * helper that trusts `x-forwarded-host` because the MCP flow must work behind
   * tunnels — using that one here would let a spoofed header redirect the OIDC
   * callback to a host of the attacker's choosing. It must also match the
   * registered value byte-for-byte, which a header-derived value cannot promise.
   */
  private redirectUri(): string {
    const base =
      this.config.get<string>('FRONTEND_URL') ||
      this.config.get<string>('SERVER_URL') ||
      'http://localhost:3000';
    return `${base.replace(/\/$/, '')}/auth/sso/callback`;
  }

  /** Builds an openid-client configuration, guarding the outbound fetch. */
  private async discoverFor(provider: {
    id: string;
    type: string;
    issuer: string;
    clientId: string;
    organizationId?: string;
  }, clientSecret: string) {
    // Re-checked here, not only on write: the allowlist may have tightened
    // since the provider was configured, and this is the call that leaves.
    assertIssuerAllowed(provider.type, provider.issuer, {
      allowArbitraryIssuer: this.deployment.isSelfHosted(),
    });
    await assertSafeOutboundUrl(provider.issuer);

    return client.discovery(
      new URL(provider.issuer),
      provider.clientId,
      clientSecret,
    );
  }

  // ── Step 1: start ─────────────────────────────────────────────────────────

  /**
   * Begins a sign-in. Returns the provider URL to send the browser to.
   *
   * `initiateId` is opaque and rotatable; an unknown one is refused with the
   * same shape as any other failure so this cannot enumerate workspaces.
   */
  async start(
    initiateId: string,
    returnTo?: string,
  ): Promise<{ authorizationUrl: string }> {
    const provider = await this.prisma.identityProvider.findUnique({
      where: { initiateId },
      select: {
        id: true,
        type: true,
        issuer: true,
        clientId: true,
        isActive: true,
        organizationId: true,
        config: true,
      },
    });
    if (!provider || !provider.isActive) {
      throw new SsoError('unknown_or_inactive_provider');
    }

    return this.beginAuthorization(provider, {
      surface: 'DASHBOARD',
      returnTo,
    });
  }

  /**
   * Begins a link: attaches an external identity to the CALLER'S OWN account.
   *
   * The user id comes from the caller's session and is written into the attempt
   * now, before the browser ever leaves. The callback then has nothing to
   * decide — which is the point, because everything that arrives there travels
   * through the user agent and is attacker-influenced.
   */
  async startLink(
    userId: string,
    providerId: string,
    returnTo?: string,
  ): Promise<{ authorizationUrl: string }> {
    const provider = await this.prisma.identityProvider.findUnique({
      where: { id: providerId },
      select: {
        id: true,
        type: true,
        issuer: true,
        clientId: true,
        isActive: true,
        organizationId: true,
        config: true,
      },
    });
    if (!provider || !provider.isActive) {
      throw new SsoError('unknown_or_inactive_provider');
    }

    // Membership, not just authentication: a signed-in user from workspace A
    // must not be able to start a link against workspace B's provider by
    // guessing its id. `identityProvider.id` is a cuid rather than the opaque
    // `initiateId`, and cuids are not secrets.
    await this.assertMember(userId, provider.organizationId);

    return this.beginAuthorization(provider, {
      surface: 'LINK',
      returnTo,
      linkUserId: userId,
    });
  }

  /**
   * Begins a sign-in from the MCP authorization page.
   *
   * This is the surface that matters most: it is where a user authorizes an AI
   * client, and until now it accepted only a password — so an SSO-enforced
   * account could not connect a client at all, and everyone else bypassed the
   * IdP's MFA and Conditional Access on exactly the flow worth protecting.
   *
   * `oauthSessionId` is the pending mcp-nest session this login belongs to. It
   * is recorded now and ASSERTED on return, so the identity can only ever be
   * attached to the authorization that the same browser started.
   */
  async startMcp(
    providerId: string,
    oauthSessionId: string,
  ): Promise<{ authorizationUrl: string }> {
    if (!oauthSessionId) throw new SsoError('mcp_without_oauth_session');

    const provider = await this.prisma.identityProvider.findUnique({
      where: { id: providerId },
      select: {
        id: true,
        type: true,
        issuer: true,
        clientId: true,
        isActive: true,
        organizationId: true,
        config: true,
      },
    });
    if (!provider || !provider.isActive) {
      throw new SsoError('unknown_or_inactive_provider');
    }

    return this.beginAuthorization(provider, {
      surface: 'MCP',
      oauthSessionId,
    });
  }

  /** Shared by both entry points: PKCE, state, nonce and the stored attempt. */
  private async beginAuthorization(
    provider: {
      id: string;
      type: string;
      issuer: string;
      clientId: string;
      organizationId: string;
      config: any;
    },
    opts: {
      surface: string;
      returnTo?: string;
      linkUserId?: string;
      oauthSessionId?: string;
    },
  ): Promise<{ authorizationUrl: string }> {
    const clientSecret = await this.providers.getClientSecret(
      provider.id,
      provider.organizationId,
    );
    if (!clientSecret) throw new SsoError('provider_missing_secret');

    const config = await this.discoverFor(provider, clientSecret);

    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();

    await this.prisma.ssoLoginAttempt.create({
      data: {
        state,
        nonce,
        codeVerifier,
        providerId: provider.id,
        surface: opts.surface,
        linkUserId: opts.linkUserId ?? null,
        oauthSessionId: opts.oauthSessionId ?? null,
        returnTo: this.safeReturnTo(opts.returnTo),
        expiresAt: new Date(Date.now() + ATTEMPT_TTL_MS),
      },
    });

    const params: Record<string, string> = {
      redirect_uri: this.redirectUri(),
      scope: 'openid profile email offline_access',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
      // `query` rather than `form_post`: the response then arrives as a
      // same-site top-level GET, so SameSite=Lax cookies survive it. The only
      // advantage of form_post — keeping the code out of the URL — is covered
      // by consuming the code immediately and redirecting to a query-less URL.
      response_mode: 'query',
    };

    // Entra: pin the tenant so the account picker cannot wander to another one.
    const tenantId = (provider.config as any)?.tenantId;
    if (provider.type === 'ENTRA' && tenantId) {
      params.domain_hint = 'organizations';
    }

    const url = client.buildAuthorizationUrl(config, params);
    return { authorizationUrl: url.href };
  }

  // ── Step 2: callback ──────────────────────────────────────────────────────

  /**
   * Completes the round trip. Returns a one-time code for the SPA.
   *
   * The JWT is deliberately NOT minted here: putting it in the redirect would
   * write a bearer token into browser history, the `Referer` header and every
   * proxy log between here and the user.
   */
  async complete(
    currentUrl: URL,
    ctx: { ip?: string; userAgent?: string; oauthSessionId?: string },
  ): Promise<SsoCompletion> {
    const state = currentUrl.searchParams.get('state');
    if (!state) throw new SsoError('missing_state');

    // Atomic single-use consumption. A findFirst-then-update would leave a
    // replay window between the two statements.
    const claimed = await this.prisma.ssoLoginAttempt.updateMany({
      where: { state, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) throw new SsoError('state_replayed_or_expired');

    const attempt = await this.prisma.ssoLoginAttempt.findUnique({
      where: { state },
      include: {
        provider: {
          select: {
            id: true,
            type: true,
            issuer: true,
            clientId: true,
            organizationId: true,
            jitProvisioning: true,
            jitDefaultRole: true,
            config: true,
            roleSyncEnabled: true,
            roleSyncSource: true,
            roleSyncFallback: true,
            roleSyncDefaultRoleIds: true,
          },
        },
      },
    });
    if (!attempt) throw new SsoError('attempt_vanished');
    const provider = attempt.provider;

    const clientSecret = await this.providers.getClientSecret(
      provider.id,
      provider.organizationId,
    );
    if (!clientSecret) throw new SsoError('provider_missing_secret');

    const config = await this.discoverFor(provider, clientSecret);

    let claims: Record<string, any>;
    try {
      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: attempt.codeVerifier,
        expectedNonce: attempt.nonce,
        expectedState: attempt.state,
        // RFC 9207: openid-client compares a present `iss` against the
        // discovered issuer for us.
      });
      claims = tokens.claims() as Record<string, any>;
    } catch (e: any) {
      this.logger.warn(`SSO token exchange failed: ${e?.message}`);
      throw new SsoError('token_exchange_failed');
    }

    this.assertClaimsAcceptable(provider, claims);

    const subject = String(claims.oid ?? claims.sub);
    const tid = claims.tid ? String(claims.tid) : null;

    // A link attaches an identity to a session that already exists, so it must
    // NOT mint a second one. Returning a handoff code here would turn "connect
    // your Microsoft account" into a login — and, for an admin who linked the
    // wrong directory, into a way to hand out a session they never intended.
    if (attempt.surface === 'LINK') {
      const returnTo = await this.completeLink(
        attempt,
        provider,
        subject,
        tid,
        ctx,
      );
      return { kind: 'LINK', returnTo };
    }

    if (attempt.surface === 'MCP') {
      // Bind the return to the browser that started it. Without this an
      // attacker could open an authorization on their own machine, get the
      // victim to complete the IdP leg, and have the victim's identity
      // attached to the attacker's pending authorization.
      //
      // ASSERTED, never restored: re-planting the cookie would reduce
      // mcp-nest's own binding check to comparing a value against itself.
      await this.assertMcpBinding(attempt, provider, subject, ctx);

      const userId = await this.resolveUser(provider, subject, tid, claims, ctx);
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true },
      });
      if (!user) throw new SsoError('user_vanished');

      // Synced BEFORE the profile is returned: the MCP surface is where the
      // roles are actually spent, so a session must never be handed out with
      // yesterday's group membership still in force.
      const sync = await this.roleSync.syncOnLogin(provider, user.id, claims, ctx);

      await this.securityEvents.log({
        event: SecurityEvents.SSO_LOGIN_SUCCESS,
        actorType: 'USER',
        organizationId: provider.organizationId,
        actorUserId: user.id,
        metadata: {
          providerId: provider.id,
          oid: subject,
          tid,
          surface: 'MCP',
          ...this.claimShape(claims),
          roleSync: sync.reason,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });

      return {
        kind: 'MCP',
        profile: {
          id: user.id,
          email: user.email,
          name: user.name,
          username: user.email,
        },
      };
    }

    const userId = await this.resolveUser(provider, subject, tid, claims, ctx);

    const sync = await this.roleSync.syncOnLogin(provider, userId, claims, ctx);

    // Recorded here rather than in the MCP branch as well, because this is the
    // signal `enforceSso` is gated on: it must mean "a human completed this
    // provider's flow in a browser", which is exactly the dashboard surface.
    await this.prisma.identityProvider.update({
      where: { id: provider.id },
      data: { lastSuccessfulLoginAt: new Date() },
    });

    const handoffCode = randomBytes(32).toString('base64url');
    await this.prisma.ssoLoginAttempt.update({
      where: { id: attempt.id },
      data: {
        handoffCode,
        resolvedUserId: userId,
        expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
      },
    });

    await this.securityEvents.log({
      event: SecurityEvents.SSO_LOGIN_SUCCESS,
      actorType: 'USER',
      organizationId: provider.organizationId,
      actorUserId: userId,
      metadata: {
        providerId: provider.id,
        oid: subject,
        tid,
        surface: 'DASHBOARD',
        ...this.claimShape(claims),
        roleSync: sync.reason,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return { kind: 'LOGIN', handoffCode, returnTo: attempt.returnTo ?? '/' };
  }

  /**
   * What the token carried, as SHAPE only.
   *
   * The counts answer the first question asked when role sync misbehaves —
   * did the directory send any groups at all? — which an absent claim and a
   * claim matching no mapping otherwise look identical for. The ids
   * themselves are directory structure and are deliberately not persisted in
   * a long-lived audit row.
   */
  private claimShape(claims: Record<string, any>) {
    return {
      groupCount: Array.isArray(claims.groups) ? claims.groups.length : 0,
      appRoleCount: Array.isArray(claims.roles) ? claims.roles.length : 0,
      groupsOverage: Boolean(claims._claim_names?.groups),
    };
  }

  // ── Linking ───────────────────────────────────────────────────────────────

  /**
   * Attaches the authenticated identity to the user recorded at start time.
   *
   * Returns the path to send the browser back to. Never returns a session:
   * the caller already had one before the round trip began.
   */
  private async completeLink(
    attempt: { id: string; linkUserId: string | null; returnTo: string | null },
    provider: { id: string; organizationId: string },
    subject: string,
    tid: string | null,
    ctx: { ip?: string; userAgent?: string },
  ): Promise<string> {
    // A LINK attempt without a user is a bug, not a login. Falling through to
    // the sign-in path here would authenticate whoever completed the round
    // trip, so refuse instead of guessing.
    if (!attempt.linkUserId) throw new SsoError('link_without_user');

    // Re-checked on return, not only at start: the round trip is minutes long
    // and the member could have been removed from the workspace in between.
    await this.assertMember(attempt.linkUserId, provider.organizationId);

    const existing = await this.prisma.userIdentity.findUnique({
      where: {
        providerId_externalSubject: {
          providerId: provider.id,
          externalSubject: subject,
        },
      },
      select: { userId: true },
    });

    if (existing && existing.userId !== attempt.linkUserId) {
      // This directory account is already somebody else's way in. Re-pointing
      // it would silently transfer their access, so the losing party has to
      // unlink first.
      await this.logLinkFailure(
        'identity_already_linked_to_another_user',
        provider,
        attempt.linkUserId,
        subject,
        ctx,
      );
      throw new SsoError('identity_already_linked_to_another_user', 'Sign-in failed', true);
    }

    if (existing) {
      // Already linked to this same user: nothing to do. Idempotent rather
      // than an error, because a double-click must not look like a failure.
      await this.prisma.userIdentity.update({
        where: {
          providerId_externalSubject: {
            providerId: provider.id,
            externalSubject: subject,
          },
        },
        data: { externalTid: tid },
      });
      return this.safeReturnTo(attempt.returnTo ?? undefined);
    }

    const otherAtSameProvider = await this.prisma.userIdentity.findUnique({
      where: {
        userId_providerId: {
          userId: attempt.linkUserId,
          providerId: provider.id,
        },
      },
      select: { externalSubject: true },
    });
    if (otherAtSameProvider) {
      // Silently replacing it would change which directory account can sign in
      // without the user being told, so require an explicit unlink.
      await this.logLinkFailure(
        'user_already_linked_at_provider',
        provider,
        attempt.linkUserId,
        subject,
        ctx,
      );
      throw new SsoError('user_already_linked_at_provider', 'Sign-in failed', true);
    }

    await this.prisma.userIdentity.create({
      data: {
        userId: attempt.linkUserId,
        providerId: provider.id,
        externalSubject: subject,
        externalTid: tid,
        lastLoginAt: new Date(),
      },
    });

    await this.securityEvents.log({
      event: SecurityEvents.IDENTITY_LINKED,
      actorType: 'USER',
      organizationId: provider.organizationId,
      actorUserId: attempt.linkUserId,
      targetUserId: attempt.linkUserId,
      metadata: { providerId: provider.id, oid: subject, tid },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return this.safeReturnTo(attempt.returnTo ?? undefined);
  }

  /**
   * Detaches an external identity from the caller's own account.
   *
   * Refuses when it would leave the account with no way in at all — an unlink
   * that reports success and locks the user out is worse than a refusal.
   */
  async unlink(
    userId: string,
    providerId: string,
    ctx: { ip?: string; userAgent?: string },
  ): Promise<void> {
    const identity = await this.prisma.userIdentity.findUnique({
      where: { userId_providerId: { userId, providerId } },
      select: { id: true, externalSubject: true, provider: { select: { organizationId: true } } },
    });
    if (!identity) throw new SsoError('identity_not_linked');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true, passwordLoginDisabled: true },
    });
    const remaining = await this.prisma.userIdentity.count({
      where: { userId, providerId: { not: providerId } },
    });
    const canUsePassword = Boolean(user?.passwordHash) && !user?.passwordLoginDisabled;
    if (!canUsePassword && remaining === 0) {
      throw new SsoError('would_lock_account_out');
    }

    await this.prisma.userIdentity.delete({ where: { id: identity.id } });

    await this.securityEvents.log({
      event: SecurityEvents.IDENTITY_UNLINKED,
      actorType: 'USER',
      organizationId: identity.provider.organizationId,
      actorUserId: userId,
      targetUserId: userId,
      metadata: { providerId, oid: identity.externalSubject },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  /** The identities the caller has already connected, for the settings page. */
  async listIdentities(userId: string) {
    return this.prisma.userIdentity.findMany({
      where: { userId },
      select: {
        providerId: true,
        externalTid: true,
        lastLoginAt: true,
        createdAt: true,
        provider: { select: { name: true, type: true, isActive: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Providers the caller may connect, with whether they already have. */
  async availableForUser(userId: string, organizationId: string) {
    const [providers, identities] = await Promise.all([
      this.prisma.identityProvider.findMany({
        where: { organizationId, isActive: true },
        // Never the client id or issuer: this is a member-level endpoint, and
        // the configuration belongs to the admin page behind @Roles('ADMIN').
        select: { id: true, name: true, type: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.userIdentity.findMany({
        where: { userId },
        select: { providerId: true, lastLoginAt: true, createdAt: true },
      }),
    ]);
    const linked = new Map(identities.map((i) => [i.providerId, i]));
    return providers.map((p) => ({
      ...p,
      linked: linked.has(p.id),
      linkedAt: linked.get(p.id)?.createdAt ?? null,
      lastLoginAt: linked.get(p.id)?.lastLoginAt ?? null,
    }));
  }

  /**
   * The returning browser must be the one that started this authorization.
   *
   * Without it an attacker could open an authorization on their own machine,
   * get a victim to complete the identity-provider leg, and end up with the
   * victim's identity attached to the attacker's pending authorization — and
   * therefore an access token for the victim's workspace.
   *
   * The recorded value is ASSERTED against the cookie the browser presents
   * now, never restored onto the response. Re-planting it would reduce
   * mcp-nest's own session check to comparing a value with itself.
   */
  private async assertMcpBinding(
    attempt: { oauthSessionId: string | null },
    provider: { id: string; organizationId: string },
    subject: string,
    ctx: { ip?: string; userAgent?: string; oauthSessionId?: string },
  ): Promise<void> {
    if (
      !attempt.oauthSessionId ||
      !ctx.oauthSessionId ||
      attempt.oauthSessionId !== ctx.oauthSessionId
    ) {
      await this.securityEvents.log({
        event: SecurityEvents.SSO_LOGIN_FAILED,
        actorType: 'ANONYMOUS',
        organizationId: provider.organizationId,
        metadata: {
          providerId: provider.id,
          reason: 'mcp_session_binding_mismatch',
          oid: subject,
          surface: 'MCP',
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      throw new SsoError('mcp_session_binding_mismatch', 'Sign-in failed', true);
    }
  }

  /** Fails closed: a non-member is treated exactly like an unknown provider. */
  private async assertMember(userId: string, organizationId: string) {
    const member = await this.prisma.organizationMember.findFirst({
      where: { userId, organizationId, deactivatedAt: null },
      select: { id: true },
    });
    if (!member) throw new SsoError('not_a_member');
  }

  private async logLinkFailure(
    reason: string,
    provider: { id: string; organizationId: string },
    userId: string,
    subject: string,
    ctx: { ip?: string; userAgent?: string },
  ) {
    await this.securityEvents.log({
      event: SecurityEvents.SSO_LOGIN_FAILED,
      actorType: 'USER',
      organizationId: provider.organizationId,
      actorUserId: userId,
      metadata: { providerId: provider.id, reason, oid: subject, surface: 'LINK' },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  // ── Step 3: exchange ──────────────────────────────────────────────────────

  /** Trades the one-time code for a session. Single-use, 30 seconds. */
  async exchange(handoffCode: string) {
    const attempt = await this.prisma.ssoLoginAttempt.findUnique({
      where: { handoffCode },
      select: { id: true, resolvedUserId: true, expiresAt: true },
    });
    if (
      !attempt?.resolvedUserId ||
      attempt.expiresAt.getTime() < Date.now()
    ) {
      throw new SsoError('handoff_invalid_or_expired');
    }

    // Burn the code before minting, so a replay finds nothing.
    await this.prisma.ssoLoginAttempt.delete({ where: { id: attempt.id } });

    const user = await this.prisma.user.findUnique({
      where: { id: attempt.resolvedUserId },
    });
    if (!user) throw new SsoError('user_vanished');

    return {
      accessToken: this.authService.generateToken({
        sub: user.id,
        email: user.email,
        role: user.role,
        organizationId: user.organizationId,
      }),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organizationId: user.organizationId,
        emailVerified: user.emailVerified,
      },
    };
  }

  // ── Validation ────────────────────────────────────────────────────────────

  /**
   * Rejects a token that is technically valid but must not be trusted here.
   *
   * openid-client has already checked the signature, `aud`, `nonce`, `exp` and
   * that `iss` matches the discovered issuer. What remains is the tenant and
   * guest policy, which is ours to decide.
   */
  private assertClaimsAcceptable(
    provider: { type: string; issuer: string; config: any },
    claims: Record<string, any>,
  ) {
    if (provider.type === 'ENTRA') {
      const tid = String(claims.tid ?? '');
      const expected = String(provider.config?.tenantId ?? '');
      if (!tid || tid.toLowerCase() !== expected.toLowerCase()) {
        throw new SsoError('tid_mismatch');
      }
      // Every consumer Microsoft account lives in this single tenant, so it
      // identifies no organization.
      if (tid.toLowerCase() === MSA_TENANT_ID) throw new SsoError('msa_tenant');

      // Guests. A tenant admin can invite ANY address as a B2B guest, so a
      // guest token carries an `email` the inviting tenant does not own — the
      // exact primitive behind nOAuth. `acct: 1` marks a guest; `idp` differing
      // from `iss` and a UPN containing #EXT# are the other tells.
      if (claims.acct === 1) throw new SsoError('guest_account');
      if (claims.idp && claims.idp !== claims.iss) {
        throw new SsoError('guest_external_idp');
      }
      const upn = String(claims.preferred_username ?? claims.upn ?? '');
      if (upn.includes('#EXT#')) throw new SsoError('guest_ext_upn');
    }

    if (!claims.oid && !claims.sub) throw new SsoError('missing_subject');
  }

  /**
   * Finds the local user behind this identity, or provisions one.
   *
   * SECURITY: there is deliberately NO lookup by email. `User.email` is globally
   * unique and users are shared across workspaces, so matching on an
   * IdP-supplied address would let anyone who controls any tenant bind their
   * identity to another workspace's user. Linking an existing account happens
   * through an explicit, authenticated action instead (PR 6).
   */
  private async resolveUser(
    provider: {
      id: string;
      organizationId: string;
      jitProvisioning: boolean;
      jitDefaultRole: any;
    },
    subject: string,
    tid: string | null,
    claims: Record<string, any>,
    ctx: { ip?: string; userAgent?: string },
  ): Promise<string> {
    const existing = await this.prisma.userIdentity.findUnique({
      where: {
        providerId_externalSubject: { providerId: provider.id, externalSubject: subject },
      },
      select: { id: true, userId: true },
    });

    if (existing) {
      await this.prisma.userIdentity.update({
        where: { id: existing.id },
        data: { lastLoginAt: new Date(), externalTid: tid },
      });
      return existing.userId;
    }

    if (!provider.jitProvisioning) {
      await this.securityEvents.log({
        event: SecurityEvents.SSO_LOGIN_FAILED,
        actorType: 'ANONYMOUS',
        organizationId: provider.organizationId,
        metadata: { providerId: provider.id, reason: 'no_identity_and_jit_disabled', oid: subject },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      throw new SsoError('no_identity_and_jit_disabled', 'Sign-in failed', true);
    }

    // Provision. The email is used ONLY to populate a display field on a
    // brand-new row — never to find or claim an existing account.
    const email = String(claims.email ?? claims.preferred_username ?? '').toLowerCase();
    if (!email) throw new SsoError('jit_without_email');

    const collision = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (collision) {
      // A local account already owns this address. Auto-linking here is the
      // takeover we refuse; the user must link it deliberately while signed in.
      await this.securityEvents.log({
        event: SecurityEvents.SSO_LOGIN_FAILED,
        actorType: 'ANONYMOUS',
        organizationId: provider.organizationId,
        metadata: { providerId: provider.id, reason: 'email_belongs_to_existing_account', oid: subject },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      throw new SsoError('email_belongs_to_existing_account', 'Sign-in failed', true);
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          name: claims.name ? String(claims.name) : null,
          // No password: this account exists only through the provider.
          passwordHash: null,
          emailVerified: true,
          role: provider.jitDefaultRole,
          organizationId: provider.organizationId,
        },
        select: { id: true },
      });
      await tx.organizationMember.create({
        data: {
          userId: user.id,
          organizationId: provider.organizationId,
          role: provider.jitDefaultRole,
        },
      });
      await tx.userIdentity.create({
        data: {
          userId: user.id,
          providerId: provider.id,
          externalSubject: subject,
          externalTid: tid,
          lastLoginAt: new Date(),
        },
      });
      return user;
    });

    await this.securityEvents.log({
      event: SecurityEvents.JIT_PROVISIONED,
      actorType: 'SYSTEM',
      organizationId: provider.organizationId,
      targetUserId: created.id,
      metadata: { providerId: provider.id, oid: subject, tid, role: provider.jitDefaultRole },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return created.id;
  }

  /**
   * Only an internal, absolute path may be returned to. Anything else — a full
   * URL, a protocol-relative `//evil.tld`, a backslash variant — would make the
   * callback an open redirect.
   */
  private safeReturnTo(value?: string): string {
    if (!value) return '/';
    if (!value.startsWith('/')) return '/';
    if (value.startsWith('//') || value.startsWith('/\\')) return '/';
    return value;
  }
}
