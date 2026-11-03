import type { PrismaService } from '../common/prisma.service';
import { APP_VERSION } from '../common/app-version';

/**
 * Usage figures a self-hosted instance adds to its licence verification
 * (GET /api/license/verify), so instances that outgrow Community can be told
 * apart. Only counts and the version: no names, emails, URLs or content.
 * Never sent from AnythingMCP Cloud. LICENSE_USAGE_REPORT=false turns it off.
 */
export interface UsageReport {
  activeUsers: string;
  connectors: string;
  mcpServers: string;
  version: string;
}

/** False when the operator opted out with LICENSE_USAGE_REPORT=false (or 0, no, off). */
export function usageReportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.LICENSE_USAGE_REPORT ?? '').trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(v);
}

/**
 * Users with at least one active membership, across the instance. The seat
 * count of the self-hosted edition limit (EditionService) uses the same query.
 */
export function countActiveSeats(prisma: PrismaService): Promise<number> {
  return prisma.user.count({
    where: { memberships: { some: { deactivatedAt: null } } },
  });
}

/**
 * Instance-wide counts (a self-hosted instance is a single tenant). Throws
 * when a count fails; the caller then verifies without them.
 */
export async function collectUsageReport(prisma: PrismaService): Promise<UsageReport> {
  const [activeUsers, connectors, mcpServers] = await Promise.all([
    countActiveSeats(prisma),
    prisma.connector.count(),
    prisma.mcpServerConfig.count(),
  ]);
  return {
    activeUsers: String(activeUsers),
    connectors: String(connectors),
    mcpServers: String(mcpServers),
    version: APP_VERSION,
  };
}
