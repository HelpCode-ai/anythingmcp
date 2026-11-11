import { PrismaService } from '../common/prisma.service';

/** Whether a user is an active member of an organization. */
export type MembershipLookup = (userId: string, organizationId: string) => Promise<boolean>;

/**
 * THE rule for "may this user reach a resource of this organization": the
 * organization is the user's primary one, or the user holds an active
 * (`deactivatedAt: null`) `organization_members` row for it.
 *
 * One rule, three places: the consent page (no token for a server the user
 * cannot reach), the per-server MCP endpoint (refuses every call of such a
 * token) and the refresh grant (no new token for it). They must never
 * disagree, or a token refused by one is kept alive by another (#1609).
 *
 * Switching the active workspace changes only the primary org; the membership
 * row stays, so a switch never makes a server unreachable.
 */
export async function userReachesOrganization(
  userId: string | null | undefined,
  organizationId: string | null | undefined,
  primaryOrgId: string | null | undefined,
  isActiveMember: MembershipLookup,
): Promise<boolean> {
  if (!organizationId) return false;
  if (primaryOrgId && primaryOrgId === organizationId) return true;
  if (!userId) return false;
  return isActiveMember(userId, organizationId);
}

/** The membership lookup straight from Prisma (same query as McpServersService). */
export function prismaMembershipLookup(prisma: PrismaService): MembershipLookup {
  return async (userId, organizationId) => {
    const member = await prisma.organizationMember.findFirst({
      where: { userId, organizationId, deactivatedAt: null },
      select: { userId: true },
    });
    return !!member;
  };
}

export type ServerReachability = 'reachable' | 'unreachable' | 'unknown';

/**
 * Whether a user can reach one MCP server, by the rule above.
 *
 * 'unknown' when the server does not exist or a lookup fails. Callers use
 * this to refuse, never to grant, so they treat 'unknown' like 'reachable'
 * and leave the decision to the existing flow (the endpoint answers 404 for
 * an unknown server).
 *
 * `primaryOrgId` may be passed when the caller already loaded the user row,
 * which saves a query; `undefined` means "look it up".
 */
export async function serverReachability(
  prisma: PrismaService,
  userId: string,
  serverId: string,
  primaryOrgId?: string | null,
): Promise<ServerReachability> {
  try {
    const server = await prisma.mcpServerConfig.findUnique({
      where: { id: serverId },
      select: { organizationId: true },
    });
    if (!server?.organizationId) return 'unknown';
    if (primaryOrgId === undefined) {
      const account = await prisma.user.findUnique({
        where: { id: userId },
        select: { organizationId: true },
      });
      primaryOrgId = account?.organizationId ?? null;
    }
    const reachable = await userReachesOrganization(
      userId,
      server.organizationId,
      primaryOrgId,
      prismaMembershipLookup(prisma),
    );
    return reachable ? 'reachable' : 'unreachable';
  } catch {
    return 'unknown';
  }
}
