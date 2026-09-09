import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import {
  SecurityEventService,
  SecurityEvents,
} from '../../audit/security-event.service';
import { UserLifecycleService } from '../../users/user-lifecycle.service';
import { RoleSyncService } from '../role-sync.service';
import { ScimError } from './scim.errors';
import {
  coerceActive,
  displayNameOf,
  memberIdFromPath,
  parsePatch,
  pickEmail,
  readUser,
  ParsedUser,
  PatchOp,
  ScimFilter,
} from './scim.parser';
import { SCIM_LIST_SCHEMA, SCIM_USER_SCHEMA } from './scim.schemas';
import type { ScimProvider } from './scim-auth.guard';

export interface ScimCtx {
  baseUrl: string;
  ip?: string | null;
  userAgent?: string | null;
}

/** The identity row plus everything needed to render a SCIM User. */
const IDENTITY_INCLUDE = {
  user: {
    select: {
      id: true,
      email: true,
      name: true,
      passwordHash: true,
      createdAt: true,
      updatedAt: true,
      memberships: { select: { organizationId: true, deactivatedAt: true } },
    },
  },
} as const;

type IdentityRow = {
  id: string;
  userId: string;
  externalSubject: string;
  scimManagedAt: Date | null;
  createdAt: Date;
  user: {
    id: string;
    email: string;
    name: string | null;
    passwordHash: string | null;
    createdAt: Date;
    updatedAt: Date;
    memberships: { organizationId: string; deactivatedAt: Date | null }[];
  };
};

interface UserChanges {
  active?: boolean;
  email?: string;
  name?: string | null;
  externalId?: string;
}

/**
 * SCIM Users for one identity provider.
 *
 * Scope is the set of `user_identities` rows for that provider: a user with
 * no identity here does not exist as far as this SCIM client is concerned,
 * whatever their email says. That is the same rule SSO sign-in applies
 * (`providerId_externalSubject`, never email), and it is what keeps a
 * directory from reaching accounts it does not own.
 */
@Injectable()
export class ScimUsersService {
  private readonly logger = new Logger(ScimUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly securityEvents: SecurityEventService,
    private readonly lifecycle: UserLifecycleService,
    private readonly roleSync: RoleSyncService,
  ) {}

  // ── Read ──────────────────────────────────────────────────────────────────

  async list(
    provider: ScimProvider,
    filter: ScimFilter | null,
    page: { startIndex: number; count: number },
    ctx: ScimCtx,
  ) {
    const where = { providerId: provider.id, ...this.whereFor(filter) };
    const [total, rows] = await Promise.all([
      this.prisma.userIdentity.count({ where }),
      this.prisma.userIdentity.findMany({
        where,
        include: IDENTITY_INCLUDE,
        orderBy: { createdAt: 'asc' },
        skip: page.startIndex - 1,
        take: page.count,
      }),
    ]);
    return {
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: total,
      startIndex: page.startIndex,
      itemsPerPage: rows.length,
      Resources: rows.map((r) => this.toScim(provider, r as IdentityRow, ctx)),
    };
  }

  async get(provider: ScimProvider, userId: string, ctx: ScimCtx) {
    const row = await this.find(provider, userId);
    return this.toScim(provider, row, ctx);
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async create(provider: ScimProvider, body: unknown, ctx: ScimCtx) {
    const parsed = readUser(body);

    // The identity key. Entra maps objectId → externalId by default; without
    // it there is nothing immutable to anchor the account to.
    if (!parsed.externalId) {
      throw new ScimError(400, 'externalId is required (map it to objectId in Entra)', 'invalidValue');
    }

    const existing = await this.prisma.userIdentity.findUnique({
      where: {
        providerId_externalSubject: { providerId: provider.id, externalSubject: parsed.externalId },
      },
      select: { id: true },
    });
    if (existing) {
      throw new ScimError(409, 'User already provisioned', 'uniqueness');
    }

    const email = parsed.primaryEmail ?? parsed.userName.toLowerCase();

    // The same anti-takeover rule as JIT provisioning: a local account that
    // owns this address is never claimed by a directory. Binding this
    // provider's object id to it would let whoever controls the tenant sign
    // in as that person everywhere they are a member.
    const collision = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (collision) {
      throw new ScimError(
        409,
        'An account with this email already exists and is not linked to this identity provider. The user can link it by signing in with Microsoft from Settings → Connected accounts, or an administrator can remove the local account.',
        'uniqueness',
      );
    }

    const now = new Date();
    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          name: displayNameOf(parsed),
          passwordHash: null,
          emailVerified: true,
          role: provider.jitDefaultRole,
          organizationId: provider.organizationId,
        },
        select: { id: true },
      });
      await tx.organizationMember.create({
        data: { userId: user.id, organizationId: provider.organizationId, role: provider.jitDefaultRole },
      });
      await tx.userIdentity.create({
        data: {
          userId: user.id,
          providerId: provider.id,
          externalSubject: parsed.externalId!,
          scimManagedAt: now,
        },
      });
      return user;
    });

    await this.securityEvents.log({
      event: SecurityEvents.SCIM_USER_PROVISIONED,
      actorType: 'SYSTEM',
      organizationId: provider.organizationId,
      targetUserId: created.id,
      metadata: { providerId: provider.id, oid: parsed.externalId, role: provider.jitDefaultRole },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    if (!parsed.active) {
      await this.lifecycle.deactivateInOrganization(created.id, provider.organizationId, this.lifecycleCtx(provider, ctx));
    }

    // A brand-new member with no role is UNRESTRICTED under getAllowedToolIds.
    // Run the sync with nothing presented so the provider's fallback (DENY_ALL
    // by default) applies from the first request, not from the first login.
    await this.roleSync.syncOnLogin(provider, created.id, {}, { ip: ctx.ip, userAgent: ctx.userAgent });

    return this.get(provider, created.id, ctx);
  }

  // ── Update ────────────────────────────────────────────────────────────────

  async replace(provider: ScimProvider, userId: string, body: unknown, ctx: ScimCtx) {
    const row = await this.find(provider, userId);
    const parsed = readUser(body);
    const changes: UserChanges = {
      // PUT with `active` absent must not silently reactivate.
      ...(body && typeof (body as any).active !== 'undefined' ? { active: parsed.active } : {}),
      email: parsed.primaryEmail ?? parsed.userName.toLowerCase(),
      name: displayNameOf(parsed),
      externalId: parsed.externalId,
    };
    await this.apply(provider, row, changes, ctx);
    return this.get(provider, userId, ctx);
  }

  async patch(provider: ScimProvider, userId: string, body: unknown, ctx: ScimCtx) {
    const row = await this.find(provider, userId);
    const changes = this.changesFromPatch(row, parsePatch(body));
    await this.apply(provider, row, changes, ctx);
    return this.get(provider, userId, ctx);
  }

  /**
   * DELETE is deprovisioning, not erasure. Entra sends it when a user is purged
   * or when soft-delete is turned off; either way the outcome wanted is "no
   * access", which deactivation already guarantees. Hard-deleting would
   * dissolve the audit trail, tool-invocation attribution and the admin-count
   * checks at exactly the moment an investigation would want them — and a
   * user restored in Entra would come back as a second account.
   */
  async remove(provider: ScimProvider, userId: string, ctx: ScimCtx): Promise<void> {
    const row = await this.find(provider, userId);
    await this.apply(provider, row, { active: false }, ctx);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async find(provider: ScimProvider, userId: string): Promise<IdentityRow> {
    const row = await this.prisma.userIdentity.findUnique({
      where: { userId_providerId: { userId, providerId: provider.id } },
      include: IDENTITY_INCLUDE,
    });
    // A user from another organization, or one without an identity here, is
    // indistinguishable from nonexistent — 404 either way.
    if (!row) throw new ScimError(404, 'User not found', 'noTarget');
    return row as IdentityRow;
  }

  private whereFor(filter: ScimFilter | null) {
    if (!filter) return {};
    switch (filter.attr) {
      case 'userName':
      case 'emails.value':
        return { user: { email: filter.value.toLowerCase() } };
      case 'externalId':
        return { externalSubject: filter.value };
      case 'id':
        return { userId: filter.value };
      default:
        throw new ScimError(400, `Unsupported filter attribute: ${filter.attr}`, 'invalidFilter');
    }
  }

  private changesFromPatch(row: IdentityRow, ops: PatchOp[]): UserChanges {
    const c: UserChanges = {};
    let given: string | undefined;
    let family: string | undefined;
    let display: string | undefined;
    let formatted: string | undefined;
    let touchedName = false;

    for (const op of ops) {
      const path = (op.path ?? '').replace(/^urn:ietf:params:scim:schemas:core:2\.0:User:/i, '');
      const lower = path.toLowerCase();
      if (memberIdFromPath(op.path)) continue; // group membership lives on /Groups

      if (lower === 'active') {
        c.active = op.op === 'remove' ? false : coerceActive(op.value);
      } else if (lower === 'username') {
        if (typeof op.value === 'string' && op.value.trim()) c.email = op.value.trim().toLowerCase();
      } else if (lower === 'emails') {
        const e = pickEmail(op.value);
        if (e) c.email = e;
      } else if (/^emails\[.*\]\.value$/i.test(path)) {
        if (typeof op.value === 'string' && op.value.trim()) c.email = op.value.trim().toLowerCase();
      } else if (lower === 'externalid') {
        if (typeof op.value === 'string') c.externalId = op.value;
      } else if (lower === 'displayname') {
        display = typeof op.value === 'string' ? op.value : undefined; touchedName = true;
      } else if (lower === 'name.givenname') {
        given = typeof op.value === 'string' ? op.value : undefined; touchedName = true;
      } else if (lower === 'name.familyname') {
        family = typeof op.value === 'string' ? op.value : undefined; touchedName = true;
      } else if (lower === 'name.formatted') {
        formatted = typeof op.value === 'string' ? op.value : undefined; touchedName = true;
      }
      // Anything else (title, department, enterprise extension, …) is an
      // attribute the admin mapped that we have no column for. Ignored, never
      // 400: Entra pushes whatever is mapped.
    }

    if (touchedName) {
      // A PATCH may carry only one part of the name; keep the rest.
      const current = row.user.name ?? '';
      c.name = displayNameOf({
        displayName: display,
        formattedName: formatted,
        givenName: given,
        familyName: family,
      }) ?? (display === undefined && formatted === undefined && !given && !family ? current : null);
    }
    return c;
  }

  private async apply(provider: ScimProvider, row: IdentityRow, changes: UserChanges, ctx: ScimCtx) {
    const orgId = provider.organizationId;
    const membership = row.user.memberships.find((m) => m.organizationId === orgId);
    const isActive = Boolean(membership) && membership!.deactivatedAt === null;
    const metadata: Record<string, unknown> = { providerId: provider.id, oid: row.externalSubject };

    if (changes.externalId !== undefined && changes.externalId !== row.externalSubject) {
      throw new ScimError(400, 'externalId is immutable', 'mutability');
    }

    // Mark the identity as SCIM-managed on first touch, so the role sync can
    // tell "SCIM says no groups" from "SCIM never mentioned this user".
    if (!row.scimManagedAt) {
      await this.prisma.userIdentity.update({
        where: { id: row.id },
        data: { scimManagedAt: new Date() },
      });
    }

    const data: { name?: string | null; email?: string } = {};
    if (changes.name !== undefined && changes.name !== row.user.name) data.name = changes.name;

    if (changes.email && changes.email !== row.user.email) {
      // `users.email` is global and is where password-reset mail goes. Only
      // rewrite it for an account this provider fully owns: no password, no
      // other workspace, and the address unclaimed. Otherwise keep the old
      // address and carry on — a deactivation in the same request must never
      // be blocked by an email conflict.
      const skipped = row.user.passwordHash
        ? 'has_password'
        : row.user.memberships.some((m) => m.organizationId !== orgId)
          ? 'multi_org'
          : (await this.prisma.user.findUnique({ where: { email: changes.email }, select: { id: true } }))
            ? 'conflict'
            : null;
      if (skipped) metadata.emailChangeSkipped = skipped;
      else data.email = changes.email;
    }

    if (Object.keys(data).length > 0) {
      await this.prisma.user.update({ where: { id: row.userId }, data });
      metadata.updated = Object.keys(data);
    }

    if (changes.active === false && isActive) {
      const result = await this.lifecycle.deactivateInOrganization(row.userId, orgId, this.lifecycleCtx(provider, ctx));
      await this.securityEvents.log({
        event: SecurityEvents.SCIM_USER_DEPROVISIONED,
        actorType: 'SYSTEM',
        organizationId: orgId,
        targetUserId: row.userId,
        metadata: { ...metadata, outcome: result.status },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      if (result.status === 'last_admin_retained') {
        // Sessions and keys are already revoked. Tell Entra so the failure is
        // visible in its provisioning log instead of silently succeeding.
        throw new ScimError(
          409,
          'This user is the only administrator of the workspace. Their sessions and MCP keys were revoked, but the membership was kept so the workspace stays recoverable. Promote another administrator and retry.',
          'mutability',
        );
      }
      return;
    }

    if (changes.active === true && membership && !isActive) {
      await this.lifecycle.reactivateInOrganization(row.userId, orgId, this.lifecycleCtx(provider, ctx));
      await this.securityEvents.log({
        event: SecurityEvents.SCIM_USER_REACTIVATED,
        actorType: 'SYSTEM',
        organizationId: orgId,
        targetUserId: row.userId,
        metadata,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      await this.roleSync.syncOnLogin(provider, row.userId, {}, { ip: ctx.ip, userAgent: ctx.userAgent });
      return;
    }

    if (metadata.updated || metadata.emailChangeSkipped) {
      await this.securityEvents.log({
        event: SecurityEvents.SCIM_USER_UPDATED,
        actorType: 'SYSTEM',
        organizationId: orgId,
        targetUserId: row.userId,
        metadata,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }
  }

  private lifecycleCtx(provider: ScimProvider, ctx: ScimCtx) {
    return {
      reason: 'scim' as const,
      actor: { type: 'SYSTEM' as const },
      providerId: provider.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    };
  }

  private toScim(provider: ScimProvider, row: IdentityRow, ctx: ScimCtx) {
    const membership = row.user.memberships.find((m) => m.organizationId === provider.organizationId);
    const active = Boolean(membership) && membership!.deactivatedAt === null;
    return {
      schemas: [SCIM_USER_SCHEMA],
      id: row.userId,
      externalId: row.externalSubject,
      userName: row.user.email,
      active,
      ...(row.user.name ? { displayName: row.user.name, name: { formatted: row.user.name } } : {}),
      emails: [{ value: row.user.email, type: 'work', primary: true }],
      meta: {
        resourceType: 'User',
        created: row.user.createdAt.toISOString(),
        lastModified: row.user.updatedAt.toISOString(),
        location: `${ctx.baseUrl}/Users/${row.userId}`,
      },
    };
  }
}

export type { ParsedUser };
