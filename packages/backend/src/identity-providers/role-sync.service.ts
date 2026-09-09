import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import {
  SecurityEventService,
  SecurityEvents,
} from '../audit/security-event.service';
import type { RoleSyncFallback, RoleSyncSource, UserRole } from '../generated/prisma/client';

/**
 * `source` written on every assignment this service owns. It is part of the
 * unique key on `user_roles`, which is what keeps a sync from ever deleting a
 * grant an admin made by hand — and vice versa.
 *
 * ONE source for both the sign-in path and the SCIM path, deliberately. Both
 * project the same directory; `writeAssignments` rewrites the whole synced set
 * on every run, so the last writer wins and that is correct. Two sources would
 * be two independent projections merged by union in `getAllowedToolIds`: the
 * more permissive one would always win, and neither writer could ever revoke
 * what the other granted — a SCIM removal would leave the last login's grant
 * in place, which is precisely the leaver problem SCIM exists to close.
 */
export const SYNC_SOURCE = 'entra';

/**
 * Name of the per-organization role that expresses "role sync ran and matched
 * nothing". See `applyDenyAll` for why this exists instead of simply deleting
 * the user's grants.
 */
export const DENY_ALL_ROLE_NAME = 'No access (SSO)';

/** Ordered least- to most-privileged. Index is the comparison key. */
const ORG_ROLE_RANK: UserRole[] = ['VIEWER', 'EDITOR', 'ADMIN'];

export interface RoleSyncProvider {
  id: string;
  organizationId: string;
  roleSyncEnabled: boolean;
  roleSyncSource: RoleSyncSource;
  roleSyncFallback: RoleSyncFallback;
  roleSyncDefaultRoleIds: string[];
  /** When true, stored SCIM memberships outrank the token's groups claim. */
  scimEnabled: boolean;
}

/** The provider projection every caller of this service should select. */
export const ROLE_SYNC_PROVIDER_SELECT = {
  id: true,
  organizationId: true,
  roleSyncEnabled: true,
  roleSyncSource: true,
  roleSyncFallback: true,
  roleSyncDefaultRoleIds: true,
  scimEnabled: true,
} as const;

export type RoleSyncTrigger = 'login' | 'scim' | 'resync';
/** Which statement of the user's groups decided the outcome. */
export type MembershipSource = 'claims' | 'scim' | 'none';

export type RoleSyncReason =
  | 'disabled'
  | 'overage'
  | 'no_claim'
  | 'matched'
  | 'fallback_deny_all'
  | 'fallback_keep_existing'
  | 'fallback_default_role'
  /** A SCIM trigger while the provider reads APP_ROLES — groups mean nothing. */
  | 'source_not_groups'
  /** A SCIM trigger for a user SCIM has never described. */
  | 'no_directory_state';

export interface RoleSyncOutcome {
  /** False means nothing was written. */
  applied: boolean;
  reason: RoleSyncReason;
  trigger: RoleSyncTrigger;
  membershipSource: MembershipSource;
  /** How many ids were presented. */
  presented: number;
  /** How many mappings those ids hit. */
  matched: number;
  grantedRoleIds: string[];
  orgRoleBefore?: UserRole;
  orgRoleAfter?: UserRole;
  /** True when a demotion was refused because it would empty the org of admins. */
  lastAdminProtected?: boolean;
}

export interface ResyncSummary {
  providerId: string;
  trigger: RoleSyncTrigger;
  total: number;
  applied: number;
  unchanged: number;
  failed: number;
  lastAdminProtected: number;
  durationMs: number;
}

type SyncCtx = { ip?: string | null; userAgent?: string | null; actorUserId?: string | null };

/** Order- and duplicate-insensitive comparison of two role-id lists. */
const sameSet = (a: string[], b: string[]): boolean => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
};

const NOTHING = (trigger: RoleSyncTrigger, reason: RoleSyncReason, membershipSource: MembershipSource = 'none'): RoleSyncOutcome => ({
  applied: false,
  reason,
  trigger,
  membershipSource,
  presented: 0,
  matched: 0,
  grantedRoleIds: [],
});

/**
 * Projects an external directory's groups (or application roles) onto
 * AnythingMCP roles.
 *
 * Two entry points, one core. `syncOnLogin` reads the token's claims;
 * `syncFromScim` reads the memberships the directory pushed over SCIM. When
 * SCIM is enabled the stored memberships win even at sign-in: they are fresher
 * for removals (a token's groups claim is minted at sign-in and lives as long
 * as the session), and a token that arrives WITHOUT a groups claim — an MCP
 * surface token, a claim that stopped after an app-registration edit — must
 * not be read as "member of nothing" and wipe what SCIM granted.
 *
 * Three properties this service is built around:
 *
 * 1. It matches on OBJECT IDS, never display names. Entra group names are not
 *    unique and anyone able to create a group could otherwise mint one whose
 *    name matches a privileged mapping.
 *
 * 2. It refuses to act on incomplete claims. A token that overflowed the group
 *    limit carries a `_claim_names` pointer instead of the list; treating that
 *    as "member of nothing" would revoke access from exactly the people who
 *    belong to the most groups.
 *
 * 3. It never touches assignments a human made. Only rows with
 *    `source = 'entra'` are its to rewrite.
 */
@Injectable()
export class RoleSyncService {
  private readonly logger = new Logger(RoleSyncService.name);
  /** Single-flight per provider: a second resync during a run joins it. */
  private readonly inflight = new Map<string, Promise<ResyncSummary>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  // ── Entry points ──────────────────────────────────────────────────────────

  /**
   * Runs a sync for one sign-in. Never throws: a directory that returns
   * something unexpected must not turn a valid authentication into a failed
   * login, so problems are logged and audited and the user keeps whatever
   * they already had.
   */
  async syncOnLogin(
    provider: RoleSyncProvider,
    userId: string,
    claims: Record<string, any>,
    ctx: SyncCtx = {},
  ): Promise<RoleSyncOutcome> {
    return this.guarded(provider, userId, ctx, 'login', async () => {
      if (!provider.roleSyncEnabled) return NOTHING('login', 'disabled');

      if (provider.roleSyncSource === 'GROUPS' && provider.scimEnabled) {
        const stored = await this.scimPresentedIds(provider.id, userId);
        // null: SCIM has never described this user — the claims are all we
        // have. [] or more: SCIM is authoritative, the claim is not consulted.
        if (stored !== null) {
          return this.syncFromDirectoryState(provider, userId, stored, ctx, 'login', 'scim');
        }
      }

      // Entra replaces the claim with a Graph URL past ~150 groups (~200 for
      // SAML). The list we would read is then simply absent, and every mapping
      // would miss. Acting on that would silently strip the roles of the most
      // heavily-grouped users in the directory — so we do nothing at all and
      // say so loudly. Resolving the overage needs Graph `GroupMember.Read.All`,
      // which this product deliberately does not ask for. (SCIM has no such
      // cap: Entra pushes membership per group, not a bounded list per user.)
      if (this.hasOverage(provider.roleSyncSource, claims)) {
        this.logger.warn(
          `Role sync skipped: token from provider ${provider.id} signalled a groups overage`,
        );
        await this.securityEvents.log({
          event: SecurityEvents.ROLE_SYNC_SKIPPED,
          actorType: 'SYSTEM',
          organizationId: provider.organizationId,
          targetUserId: userId,
          metadata: { providerId: provider.id, reason: 'overage' },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return NOTHING('login', 'overage', 'claims');
      }

      return this.syncFromDirectoryState(
        provider,
        userId,
        this.extractIds(provider.roleSyncSource, claims),
        ctx,
        'login',
        'claims',
      );
    });
  }

  /**
   * Re-derives one user's roles from the group memberships SCIM has stored.
   * Called after every membership change Entra pushes, and by `resyncUsers`.
   * Never throws.
   */
  async syncFromScim(
    provider: RoleSyncProvider,
    userId: string,
    ctx: SyncCtx = {},
    trigger: 'scim' | 'resync' = 'scim',
  ): Promise<RoleSyncOutcome> {
    return this.guarded(provider, userId, ctx, trigger, async () => {
      if (!provider.roleSyncEnabled) return NOTHING(trigger, 'disabled');
      // SCIM groups only ever describe groups. Under APP_ROLES the roles come
      // from the token's `roles` claim at sign-in, exactly as before.
      if (provider.roleSyncSource !== 'GROUPS') return NOTHING(trigger, 'source_not_groups');
      const stored = await this.scimPresentedIds(provider.id, userId);
      if (stored === null) return NOTHING(trigger, 'no_directory_state');
      return this.syncFromDirectoryState(provider, userId, stored, ctx, trigger, 'scim');
    });
  }

  /**
   * Re-syncs every SCIM-managed user of a provider. Used after a mapping edit
   * (with SCIM the memberships are known, so there is no reason to wait for
   * each user's next login) and after role sync is switched on.
   */
  async resyncProvider(providerId: string, ctx: SyncCtx = {}, opts: { concurrency?: number } = {}): Promise<ResyncSummary> {
    const running = this.inflight.get(providerId);
    if (running) return running;

    const job = (async () => {
      const started = Date.now();
      const provider = await this.prisma.identityProvider.findUnique({
        where: { id: providerId },
        select: ROLE_SYNC_PROVIDER_SELECT,
      });
      const empty: ResyncSummary = {
        providerId, trigger: 'resync', total: 0, applied: 0, unchanged: 0, failed: 0, lastAdminProtected: 0, durationMs: 0,
      };
      if (!provider || !provider.roleSyncEnabled || provider.roleSyncSource !== 'GROUPS' || !provider.scimEnabled) {
        return empty;
      }
      const identities = await this.prisma.userIdentity.findMany({
        where: { providerId, scimManagedAt: { not: null } },
        select: { userId: true },
      });
      const summary = await this.resyncUsers(provider, identities.map((i) => i.userId), ctx, 'resync', opts);
      return { ...summary, durationMs: Date.now() - started };
    })().finally(() => this.inflight.delete(providerId));

    this.inflight.set(providerId, job);
    return job;
  }

  /** Re-syncs an explicit set of users — e.g. the former members of a deleted group. */
  async resyncUsers(
    provider: RoleSyncProvider,
    userIds: string[],
    ctx: SyncCtx = {},
    trigger: RoleSyncTrigger = 'resync',
    opts: { concurrency?: number } = {},
  ): Promise<ResyncSummary> {
    const started = Date.now();
    const concurrency = Math.max(1, opts.concurrency ?? 4);
    const summary: ResyncSummary = {
      providerId: provider.id, trigger, total: userIds.length, applied: 0, unchanged: 0, failed: 0, lastAdminProtected: 0, durationMs: 0,
    };
    const unique = [...new Set(userIds)];
    for (let i = 0; i < unique.length; i += concurrency) {
      const results = await Promise.allSettled(
        unique.slice(i, i + concurrency).map((u) => this.syncFromScim(provider, u, ctx, trigger === 'login' ? 'scim' : trigger)),
      );
      for (const r of results) {
        if (r.status !== 'fulfilled') { summary.failed++; continue; }
        if (r.value.applied) summary.applied++; else summary.unchanged++;
        if (r.value.lastAdminProtected) summary.lastAdminProtected++;
      }
    }
    summary.durationMs = Date.now() - started;

    if (unique.length > 0) {
      await this.securityEvents.log({
        event: SecurityEvents.ROLE_SYNC_BATCH_COMPLETED,
        actorType: ctx.actorUserId ? 'USER' : 'SYSTEM',
        actorUserId: ctx.actorUserId ?? null,
        organizationId: provider.organizationId,
        metadata: { ...summary },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }
    return summary;
  }

  // ── The core ──────────────────────────────────────────────────────────────

  /**
   * `presentedIds` is the directory's complete statement of the user's groups
   * (or app roles). Matches them against the provider's mappings and writes
   * the result.
   */
  private async syncFromDirectoryState(
    provider: RoleSyncProvider,
    userId: string,
    presentedIds: string[],
    ctx: SyncCtx,
    trigger: RoleSyncTrigger,
    membershipSource: MembershipSource,
  ): Promise<RoleSyncOutcome> {
    const mappings = await this.prisma.identityProviderRoleMapping.findMany({
      where: { providerId: provider.id },
      select: { externalId: true, userRole: true, mcpRoleIds: true },
    });

    // Set membership rather than a nested loop: a Führungskreis member can
    // easily present a hundred groups against a few dozen mappings.
    const presentedSet = new Set(presentedIds);
    const matches = mappings.filter((m) => presentedSet.has(m.externalId));

    const desiredMcpRoleIds = [...new Set(matches.flatMap((m) => m.mcpRoleIds))];
    // Being in more groups can only ever widen access, so the org role is the
    // most privileged of the matches — not the last one read.
    const desiredOrgRole = this.highestOrgRole(
      matches.map((m) => m.userRole).filter((r): r is UserRole => r != null),
    );

    // A match that grants nothing is treated as no match. Writing an empty
    // synced set would leave the user with no role at all — which
    // `getAllowedToolIds` reads as UNRESTRICTED. A mapping row an admin has
    // not finished (or a SCIM group nobody has assigned roles to yet) must
    // land the user on the fallback, not on full access.
    if (matches.length === 0 || (desiredMcpRoleIds.length === 0 && desiredOrgRole === null)) {
      return this.applyFallback(provider, userId, presentedIds.length, ctx, trigger, membershipSource);
    }

    const { granted, changed } = await this.writeAssignments(provider, userId, desiredMcpRoleIds);
    const org = await this.writeOrgRole(provider, userId, desiredOrgRole, ctx);

    // A refused demotion is not a no-op: the directory asked for a change and
    // was denied, which is precisely what an auditor needs to see.
    const applied = changed || org.before !== org.after || Boolean(org.lastAdminProtected);
    if (applied) {
      await this.securityEvents.log({
        event: SecurityEvents.ROLE_SYNC_APPLIED,
        actorType: 'SYSTEM',
        organizationId: provider.organizationId,
        targetUserId: userId,
        metadata: {
          providerId: provider.id,
          source: provider.roleSyncSource,
          trigger,
          membershipSource,
          presented: presentedIds.length,
          matched: matches.length,
          grantedRoleIds: granted,
          orgRoleBefore: org.before,
          orgRoleAfter: org.after,
          lastAdminProtected: org.lastAdminProtected,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }

    return {
      applied,
      reason: 'matched',
      trigger,
      membershipSource,
      presented: presentedIds.length,
      matched: matches.length,
      grantedRoleIds: granted,
      orgRoleBefore: org.before,
      orgRoleAfter: org.after,
      lastAdminProtected: org.lastAdminProtected,
    };
  }

  /** The never-throws wrapper shared by every entry point. */
  private async guarded(
    provider: RoleSyncProvider,
    userId: string,
    ctx: SyncCtx,
    trigger: RoleSyncTrigger,
    fn: () => Promise<RoleSyncOutcome>,
  ): Promise<RoleSyncOutcome> {
    try {
      return await fn();
    } catch (e: any) {
      this.logger.error(`Role sync failed for provider ${provider.id}: ${e?.message}`);
      await this.securityEvents.log({
        event: SecurityEvents.ROLE_SYNC_FAILED,
        actorType: 'SYSTEM',
        organizationId: provider.organizationId,
        targetUserId: userId,
        metadata: { providerId: provider.id, trigger, error: String(e?.message ?? e) },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return NOTHING(trigger, 'disabled');
    }
  }

  // ── Directory state ───────────────────────────────────────────────────────

  /**
   * The group object ids SCIM has placed this user in.
   *
   *   null  → SCIM has never described this user at this provider. The
   *           caller must fall back to the token's claims.
   *   []    → SCIM manages this user and they are in no group. Authoritative.
   *   [...] → the group object ids.
   *
   * The null/[] distinction rests on `user_identities.scim_managed_at`, set
   * by the SCIM layer on create and on first touch. Without it a user in no
   * group would be indistinguishable from one SCIM has never seen.
   */
  private async scimPresentedIds(providerId: string, userId: string): Promise<string[] | null> {
    const identity = await this.prisma.userIdentity.findUnique({
      where: { userId_providerId: { userId, providerId } },
      select: { scimManagedAt: true },
    });
    if (!identity?.scimManagedAt) return null;
    const rows = await this.prisma.identityProviderGroupMember.findMany({
      where: { userId, group: { providerId, externalId: { not: null } } },
      select: { group: { select: { externalId: true } } },
    });
    return rows.map((r) => r.group.externalId).filter((id): id is string => Boolean(id));
  }

  // ── Claim reading ─────────────────────────────────────────────────────────

  private hasOverage(source: RoleSyncSource, claims: Record<string, any>) {
    if (source !== 'GROUPS') return false;
    const names = claims._claim_names;
    return Boolean(names && typeof names === 'object' && 'groups' in names);
  }

  /**
   * Entra puts group object ids in `groups` and application role `value`s in
   * `roles`. Both are arrays of strings; anything else is treated as absent
   * rather than coerced, because a directory that suddenly sends a different
   * shape is a reason to grant nothing, not to guess.
   */
  private extractIds(source: RoleSyncSource, claims: Record<string, any>): string[] {
    const raw = source === 'APP_ROLES' ? claims.roles : claims.groups;
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
  }

  private highestOrgRole(roles: UserRole[]): UserRole | null {
    let best: UserRole | null = null;
    for (const r of roles) {
      if (best === null || ORG_ROLE_RANK.indexOf(r) > ORG_ROLE_RANK.indexOf(best)) {
        best = r;
      }
    }
    return best;
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  /**
   * Rewrites this user's SYNCED role grants in the provider's organization to
   * exactly `roleIds`, leaving manual grants untouched.
   *
   * Ids are re-validated against the organization before use: a mapping row
   * can outlive the role it points at, or name a role belonging to another
   * workspace if one was ever moved.
   */
  private async writeAssignments(
    provider: RoleSyncProvider,
    userId: string,
    roleIds: string[],
  ): Promise<{ granted: string[]; changed: boolean }> {
    const valid =
      roleIds.length === 0
        ? []
        : (
            await this.prisma.role.findMany({
              where: {
                id: { in: roleIds },
                OR: [{ organizationId: provider.organizationId }, { isSystem: true }],
              },
              select: { id: true },
            })
          ).map((r) => r.id);

    if (valid.length !== roleIds.length) {
      this.logger.warn(
        `Role sync for provider ${provider.id} dropped ${roleIds.length - valid.length} mapped role id(s) not visible to org ${provider.organizationId}`,
      );
    }

    // A directory that has not moved must not look like one that has. Compare
    // the synced set we already hold against the one we are about to write:
    // equal sets mean no rows change, so the write is skipped and the caller
    // reports `applied: false`. Without this every re-run of a batch resync
    // would emit one ROLE_SYNC_APPLIED per user and report them all as
    // changed — noise that buries the syncs that did move someone's access.
    const existing = (
      await this.prisma.userRoleAssignment.findMany({
        where: { userId, source: SYNC_SOURCE, organizationId: provider.organizationId },
        select: { roleId: true },
      })
    ).map((a) => a.roleId);
    const changed = !sameSet(existing, valid);
    if (!changed) return { granted: valid, changed };

    await this.prisma.$transaction(async (tx) => {
      await tx.userRoleAssignment.deleteMany({
        where: {
          userId,
          source: SYNC_SOURCE,
          organizationId: provider.organizationId,
          ...(valid.length > 0 ? { roleId: { notIn: valid } } : {}),
        },
      });
      if (valid.length > 0) {
        await tx.userRoleAssignment.createMany({
          data: valid.map((roleId) => ({
            userId,
            roleId,
            organizationId: provider.organizationId,
            source: SYNC_SOURCE,
            externalRef: provider.id,
          })),
          skipDuplicates: true,
        });
      }
    });

    // `users.mcp_role_id` is deliberately NOT written here. It holds one role
    // where a sync produces N, and it is dropped in the contract migration; a
    // release rolled back to before role sync existed should see no synced
    // roles, which is exactly what leaving it alone produces.
    return { granted: valid, changed };
  }

  /**
   * Moves the user's organization role, refusing any change that would leave
   * the workspace with no ACTIVE administrator. A deactivated membership is
   * left alone entirely: its role is inert and comes back on reactivation.
   */
  private async writeOrgRole(
    provider: RoleSyncProvider,
    userId: string,
    desired: UserRole | null,
    ctx: SyncCtx,
  ): Promise<{ before?: UserRole; after?: UserRole; lastAdminProtected?: boolean }> {
    if (desired === null) return {};

    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        userId_organizationId: { userId, organizationId: provider.organizationId },
      },
      select: { role: true, deactivatedAt: true },
    });
    if (!membership || membership.deactivatedAt) return {};
    if (membership.role === desired) return { before: membership.role, after: desired };

    // A directory edit must not be able to lock every human out of a
    // workspace. Only the demotion direction can do that, so only it is
    // guarded — promotion is always allowed.
    if (membership.role === 'ADMIN' && desired !== 'ADMIN') {
      const admins = await this.prisma.organizationMember.count({
        where: { organizationId: provider.organizationId, role: 'ADMIN', deactivatedAt: null },
      });
      if (admins <= 1) {
        this.logger.warn(
          `Role sync refused to demote the last admin of org ${provider.organizationId}`,
        );
        await this.securityEvents.log({
          event: SecurityEvents.LAST_ADMIN_PROTECTION_TRIGGERED,
          actorType: 'SYSTEM',
          organizationId: provider.organizationId,
          targetUserId: userId,
          metadata: { providerId: provider.id, attemptedRole: desired },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return { before: membership.role, after: membership.role, lastAdminProtected: true };
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.organizationMember.update({
        where: {
          userId_organizationId: { userId, organizationId: provider.organizationId },
        },
        data: { role: desired },
      });
      // Keep the active-org cache honest, as the admin path does.
      const user = await tx.user.findUnique({ where: { id: userId }, select: { organizationId: true } });
      if (user?.organizationId === provider.organizationId) {
        await tx.user.update({ where: { id: userId }, data: { role: desired } });
      }
    });
    await this.securityEvents.log({
      event: SecurityEvents.ROLE_CHANGED,
      actorType: 'SYSTEM',
      organizationId: provider.organizationId,
      targetUserId: userId,
      metadata: { providerId: provider.id, from: membership.role, to: desired, via: 'role_sync' },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { before: membership.role, after: desired };
  }

  // ── Fallbacks ─────────────────────────────────────────────────────────────

  private async applyFallback(
    provider: RoleSyncProvider,
    userId: string,
    presented: number,
    ctx: SyncCtx,
    trigger: RoleSyncTrigger,
    membershipSource: MembershipSource,
  ): Promise<RoleSyncOutcome> {
    const base = { trigger, membershipSource, presented, matched: 0 };

    if (provider.roleSyncFallback === 'KEEP_EXISTING') {
      return { ...base, applied: false, reason: 'fallback_keep_existing', grantedRoleIds: [] };
    }

    if (provider.roleSyncFallback === 'DEFAULT_ROLE') {
      const { granted, changed } = await this.writeAssignments(provider, userId, provider.roleSyncDefaultRoleIds);
      if (changed) await this.audit(provider, userId, 'fallback_default_role', base, granted, ctx);
      return { ...base, applied: changed, reason: 'fallback_default_role', grantedRoleIds: granted };
    }

    const { granted, changed } = await this.applyDenyAll(provider, userId);
    if (changed) await this.audit(provider, userId, 'fallback_deny_all', base, granted, ctx);
    return { ...base, applied: changed, reason: 'fallback_deny_all', grantedRoleIds: granted };
  }

  /**
   * DENY_ALL cannot be implemented by deleting the user's grants.
   *
   * `RolesService.getAllowedToolIds` returns `null` — meaning UNRESTRICTED —
   * for a user with no role at all, which is the behaviour inherited from the
   * single-FK era. So "revoke everything" written the obvious way produces
   * full access: the precise failure this fallback exists to prevent.
   *
   * Instead the user is given a real role that whitelists nothing. The union
   * of an empty whitelist is empty, so every existing access check already
   * does the right thing with it, and an admin can see in the roles UI why
   * someone has no tools rather than having to infer it from an absence.
   */
  private async applyDenyAll(
    provider: RoleSyncProvider,
    userId: string,
  ): Promise<{ granted: string[]; changed: boolean }> {
    const role = await this.prisma.role.upsert({
      where: {
        organizationId_name: {
          organizationId: provider.organizationId,
          name: DENY_ALL_ROLE_NAME,
        },
      },
      create: {
        organizationId: provider.organizationId,
        name: DENY_ALL_ROLE_NAME,
        description:
          'Assigned automatically when SSO role sync finds no matching group mapping. Grants no tools. Do not add tool access to this role.',
      },
      update: {},
      select: { id: true },
    });
    return this.writeAssignments(provider, userId, [role.id]);
  }

  private async audit(
    provider: RoleSyncProvider,
    userId: string,
    reason: RoleSyncReason,
    base: { trigger: RoleSyncTrigger; membershipSource: MembershipSource; presented: number; matched: number },
    grantedRoleIds: string[],
    ctx: SyncCtx,
  ) {
    await this.securityEvents.log({
      event: SecurityEvents.ROLE_SYNC_APPLIED,
      actorType: 'SYSTEM',
      organizationId: provider.organizationId,
      targetUserId: userId,
      metadata: { providerId: provider.id, source: provider.roleSyncSource, reason, ...base, grantedRoleIds },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
}
