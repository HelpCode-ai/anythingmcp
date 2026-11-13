import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { RolesService } from '../roles/roles.service';
import { OrgSettingsService } from './org-settings.service';

/**
 * Member visibility: what a workspace member who is not an admin sees in the
 * dashboard and the REST API.
 *
 *   open        every member sees every connector, server and call of the
 *               workspace (the behaviour before this setting existed)
 *   restricted  a member who is not an admin sees only what their AI client
 *               can use: their own calls, the connectors their roles reach,
 *               and the servers that hold one of those connectors
 *
 * Stored in `org_settings` under `member_visibility`. No row, or any value
 * other than `restricted`, reads as `open`, so a workspace that never touched
 * the setting keeps today's behaviour.
 */
export const MEMBER_VISIBILITY_KEY = 'member_visibility';
export const MEMBER_VISIBILITY_MODES = ['open', 'restricted'] as const;
export type MemberVisibilityMode = (typeof MEMBER_VISIBILITY_MODES)[number];

/** How long a workspace's mode is kept in memory, per process. */
export const MEMBER_VISIBILITY_CACHE_TTL_MS = 30_000;
/** Upper bound on cached workspaces, so the map cannot grow without limit. */
const MAX_CACHED_WORKSPACES = 5_000;

/**
 * The result of `scopeFor`. Callers branch on `restricted`: when it is false
 * they run today's code unchanged.
 *
 * `allowedToolIds` is what `RolesService.getAllowedToolIds` returns for the
 * caller: `null` when the roles do not narrow anything (the workspace has no
 * tool whitelist), otherwise the ids of every tool the caller may call.
 */
export type VisibilityScope =
  | { restricted: false }
  | { restricted: true; userId: string; allowedToolIds: string[] | null };

/** The fields of `req.user` the decision needs. */
export interface VisibilityUser {
  sub: string;
  role: string;
  organizationId: string;
}

const UNRESTRICTED: VisibilityScope = Object.freeze({ restricted: false as const });

/** `restricted` only for the exact stored value; anything else is `open`. */
export function parseMemberVisibilityMode(raw: string | null | undefined): MemberVisibilityMode {
  return raw === 'restricted' ? 'restricted' : 'open';
}

/**
 * Prisma `where` for connectors the scope may see: owned by the caller, or
 * holding at least one tool the caller may call. `{}` when nothing narrows
 * (not restricted, or no tool whitelist). Always combine it with the
 * `organizationId` filter using AND, never instead of it.
 */
export function connectorWhere(scope: VisibilityScope): Prisma.ConnectorWhereInput {
  if (!scope.restricted || scope.allowedToolIds === null) return {};
  if (scope.allowedToolIds.length === 0) return { userId: scope.userId };
  return {
    OR: [
      { userId: scope.userId },
      { tools: { some: { id: { in: scope.allowedToolIds } } } },
    ],
  };
}

/** In-memory twin of `connectorWhere` for one connector loaded with its tool ids. */
export function canSeeConnector(
  scope: VisibilityScope,
  connector: { userId: string; tools: ReadonlyArray<{ id: string }> },
): boolean {
  if (!scope.restricted || scope.allowedToolIds === null) return true;
  if (connector.userId === scope.userId) return true;
  const allowed = new Set(scope.allowedToolIds);
  return connector.tools.some((tool) => allowed.has(tool.id));
}

/**
 * The tools of a connector the scope may see: all of them for the owner (and
 * when nothing narrows), otherwise only the allowed ones. Keeps the order.
 */
export function visibleTools<T extends { id: string }>(
  scope: VisibilityScope,
  connector: { userId: string },
  tools: T[],
): T[] {
  if (!scope.restricted || scope.allowedToolIds === null) return tools;
  if (connector.userId === scope.userId) return tools;
  const allowed = new Set(scope.allowedToolIds);
  return tools.filter((tool) => allowed.has(tool.id));
}

/**
 * SQL twin of `visibleTools`: Prisma `where` for the tools of one connector
 * the scope may see. `{}` for the owner and when nothing narrows, otherwise
 * the allowed ids only. Combine it with the `connectorId` filter using AND.
 */
export function toolWhere(scope: VisibilityScope, connector: { userId: string }): Prisma.McpToolWhereInput {
  if (!scope.restricted || scope.allowedToolIds === null) return {};
  if (connector.userId === scope.userId) return {};
  return { id: { in: scope.allowedToolIds } };
}

/**
 * Prisma `where` for MCP servers the scope may see: owned by the caller, or
 * holding at least one connector the caller may see. `{}` when not
 * restricted. A server with no connector is visible to its owner only. Always
 * combine it with the `organizationId` filter using AND.
 */
export function serverWhere(scope: VisibilityScope): Prisma.McpServerConfigWhereInput {
  if (!scope.restricted) return {};
  return {
    OR: [
      { userId: scope.userId },
      { connectors: { some: { connector: connectorWhere(scope) } } },
    ],
  };
}

/**
 * Decides, per request, whether the caller's view of the workspace is
 * narrowed. The single place every controller asks.
 *
 * - An ADMIN of the active workspace is never restricted, and the answer
 *   comes before any database read.
 * - The mode is cached per workspace for 30 s in this process and dropped when
 *   `setMode` writes it. A stale `open` for up to 30 s after another process
 *   switched to `restricted` is accepted.
 * - Allowed tool ids are read on every call, never cached: a role change must
 *   apply at once, as on the MCP endpoint.
 * - Fails closed: if the mode or the role lookup throws, the error reaches the
 *   caller (500); there is no fallback to the unrestricted answer.
 */
@Injectable()
export class MemberVisibilityService {
  private readonly logger = new Logger(MemberVisibilityService.name);
  private readonly cache = new Map<string, { mode: MemberVisibilityMode; expiresAt: number }>();

  constructor(
    private readonly orgSettings: OrgSettingsService,
    private readonly roles: RolesService,
  ) {}

  async scopeFor(user: VisibilityUser): Promise<VisibilityScope> {
    if (user?.role === 'ADMIN') return UNRESTRICTED;
    if (!user?.sub || !user.organizationId) {
      // Every auth path sets both; without them there is nothing safe to answer.
      throw new Error('Member visibility needs the caller and the workspace');
    }
    if ((await this.mode(user.organizationId)) === 'open') return UNRESTRICTED;
    const allowedToolIds = await this.roles.getAllowedToolIds(user.sub, user.organizationId);
    return { restricted: true, userId: user.sub, allowedToolIds };
  }

  /** The workspace's mode, from the 30 s cache when fresh. */
  async mode(organizationId: string): Promise<MemberVisibilityMode> {
    const now = Date.now();
    const hit = this.cache.get(organizationId);
    if (hit && hit.expiresAt > now) return hit.mode;

    const mode = parseMemberVisibilityMode(
      await this.orgSettings.get(organizationId, MEMBER_VISIBILITY_KEY),
    );
    this.cache.delete(organizationId);
    if (this.cache.size >= MAX_CACHED_WORKSPACES) {
      // Map keeps insertion order: drop the oldest entry.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(organizationId, { mode, expiresAt: now + MEMBER_VISIBILITY_CACHE_TTL_MS });
    return mode;
  }

  /**
   * Stores a new mode and drops the cached one. Reads the previous value from
   * the database (not the cache) and writes only when it changes.
   */
  async setMode(
    organizationId: string,
    mode: MemberVisibilityMode,
  ): Promise<{ before: MemberVisibilityMode; after: MemberVisibilityMode; changed: boolean }> {
    const before = parseMemberVisibilityMode(
      await this.orgSettings.get(organizationId, MEMBER_VISIBILITY_KEY),
    );
    const changed = before !== mode;
    if (changed) {
      await this.orgSettings.set(organizationId, MEMBER_VISIBILITY_KEY, mode);
      this.logger.log(`Member visibility of workspace ${organizationId} changed from ${before} to ${mode}`);
    }
    this.cache.delete(organizationId);
    return { before, after: mode, changed };
  }
}
