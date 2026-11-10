import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { FileSearchRepository } from '../file-search/file-search.repository';
import { startOfUtcMonth } from './code-run-quotas';
import { evaluatePlanFit, FIT_PLANS, type FitItem, type FitPlan, type FitSnapshot, type PlanFit } from './plan-fit';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reads what a workspace uses today and evaluates it against the Cloud plans
 * (see `plan-fit.ts`). Every query is scoped to the organization.
 */
@Injectable()
export class PlanFitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fileRepo: FileSearchRepository,
  ) {}

  async fit(organizationId: string, plan: FitPlan, now = new Date()): Promise<PlanFit> {
    return evaluatePlanFit(await this.snapshot(organizationId, now), plan);
  }

  /** Both checkout plans from one read. */
  async fitAll(organizationId: string, now = new Date()): Promise<Record<FitPlan, PlanFit>> {
    const snap = await this.snapshot(organizationId, now);
    return Object.fromEntries(FIT_PLANS.map((p) => [p, evaluatePlanFit(snap, p)])) as Record<FitPlan, PlanFit>;
  }

  async snapshot(organizationId: string, now = new Date()): Promise<FitSnapshot> {
    const since = new Date(now.getTime() - 30 * DAY_MS);
    const [connectors, servers, users, byConnector, byServer, codeTools, runs, files] = await Promise.all([
      this.prisma.connector.findMany({
        where: { organizationId, isActive: true },
        select: { id: true, name: true, type: true, config: true, updatedAt: true },
      }),
      this.prisma.mcpServerConfig.findMany({
        where: { organizationId, isActive: true },
        select: { id: true, name: true, codeMode: true, updatedAt: true },
      }),
      this.prisma.organizationMember.count({ where: { organizationId, deactivatedAt: null } }),
      this.prisma.toolInvocation.groupBy({
        by: ['connectorId'],
        where: { organizationId, createdAt: { gte: since }, connectorId: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.toolInvocation.groupBy({
        by: ['mcpServerId'],
        where: { organizationId, createdAt: { gte: since }, mcpServerId: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM mcp_tools t
        JOIN connectors c ON c.id = t.connector_id
        WHERE c.organization_id = ${organizationId}
          AND t.endpoint_mapping->>'method' = 'code'`,
      this.prisma.codeRun.count({ where: { organizationId, createdAt: { gte: startOfUtcMonth(now) } } }),
      this.fileRepo
        .withTenant(organizationId, (tx) =>
          tx.fileEntry.aggregate({ where: { organizationId }, _count: true, _sum: { size: true } }),
        )
        .catch(() => null),
    ]);

    const connectorCalls = new Map(byConnector.map((r) => [r.connectorId as string, r._count._all]));
    const serverCalls = new Map(byServer.map((r) => [r.mcpServerId as string, r._count._all]));
    const item = (calls: Map<string, number>) => (c: { id: string; name: string; updatedAt: Date }): FitItem => ({
      id: c.id,
      name: c.name,
      calls30d: calls.get(c.id) ?? 0,
      updatedAt: c.updatedAt,
    });

    const isFileSearch = (c: { type: unknown }) => String(c.type) === 'FILE_SEARCH';
    const isFileShare = (c: { config: unknown }) => !!(c.config as { fileShare?: unknown } | null)?.fileShare;

    return {
      connectors: connectors.filter((c) => !isFileSearch(c)).map(item(connectorCalls)),
      mcpServers: servers.map(item(serverCalls)),
      users,
      fileSearchConnectors: connectors.filter((c) => isFileSearch(c) && !isFileShare(c)).map(item(connectorCalls)),
      fileSearchFiles: files?._count ?? 0,
      fileSearchBytes: Number(files?._sum.size ?? 0),
      codeTools: codeTools[0]?.count ?? 0,
      inlineCodeInUse: servers.some((s) => s.codeMode === 'inline'),
      codeRunsThisMonth: runs,
    };
  }
}
