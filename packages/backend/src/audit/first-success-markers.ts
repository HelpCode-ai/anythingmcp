import type { PrismaService } from '../common/prisma.service';
import { FIRST_SUCCESS_KEY } from '../license/card-trial-offer';

/**
 * When a workspace first made a successful tool call, from the markers that
 * outlive its tool_invocations rows.
 *
 * Cloud deletes tool_invocations older than INVOCATION_RETENTION_DAYS (90 by
 * default, KgCronService), and deleting a tool deletes its rows anywhere. So
 * "no SUCCESS row" does not mean "never used". Two stored markers survive:
 *
 * - OrgSettings `first_successful_call_at` (FIRST_SUCCESS_KEY), written by
 *   FirstSuccessService on the workspace's first success since Oct 2026;
 * - users.first_successful_invocation_at, stamped by AuditService on a
 *   user's first success since Jun 2026. It is per user, not per workspace:
 *   a member's stamp counts only when it is not older than the membership, so
 *   a call made before joining (in another workspace) is left out.
 *
 * Every query is filtered by the workspace's organizationId.
 */

type MarkerPrisma = Pick<PrismaService, 'orgSettings' | 'organizationMember'>;

/** The stored OrgSettings first success, or null when it is missing or not a date. */
export async function storedFirstSuccessAt(prisma: MarkerPrisma, organizationId: string): Promise<Date | null> {
  const row = await prisma.orgSettings.findUnique({
    where: { organizationId_key: { organizationId, key: FIRST_SUCCESS_KEY } },
    select: { value: true },
  });
  const at = row?.value ? Date.parse(row.value) : NaN;
  return Number.isFinite(at) ? new Date(at) : null;
}

/**
 * The earliest first success of the workspace's members, deactivated ones
 * included (their calls are part of its history), counting a stamp only when
 * it is not older than the membership. Null when none qualifies.
 */
export async function membersFirstSuccessAt(prisma: MarkerPrisma, organizationId: string): Promise<Date | null> {
  const members = await prisma.organizationMember.findMany({
    where: { organizationId, user: { firstSuccessfulInvocationAt: { not: null } } },
    select: { joinedAt: true, user: { select: { firstSuccessfulInvocationAt: true } } },
  });
  let earliest: Date | null = null;
  for (const m of members) {
    const at = m.user?.firstSuccessfulInvocationAt;
    if (!(at instanceof Date)) continue;
    if (m.joinedAt instanceof Date && at < m.joinedAt) continue;
    if (!earliest || at < earliest) earliest = at;
  }
  return earliest;
}

/** The workspace's first success from the stored marker, else from its members' stamps. */
export async function workspaceFirstSuccessAt(prisma: MarkerPrisma, organizationId: string): Promise<Date | null> {
  return (await storedFirstSuccessAt(prisma, organizationId)) ?? (await membersFirstSuccessAt(prisma, organizationId));
}

/** The earlier of two optional dates. */
export function earliestDate(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a <= b ? a : b;
}
