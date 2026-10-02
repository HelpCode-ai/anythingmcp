import { Injectable, Logger } from '@nestjs/common';
import { boundPayload, boundText } from './bound-payload';

/** Bytes of a call's input / output kept in tool_invocations, and error chars. */
const envInt = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
const INVOCATION_LOG_INPUT_BYTES = envInt('INVOCATION_LOG_INPUT_BYTES', 8 * 1024);
const INVOCATION_LOG_OUTPUT_BYTES = envInt('INVOCATION_LOG_OUTPUT_BYTES', 16 * 1024);
const INVOCATION_LOG_ERROR_CHARS = envInt('INVOCATION_LOG_ERROR_CHARS', 4000);
import { PrismaService } from '../common/prisma.service';
import { InvocationStatus } from '../generated/prisma/client';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async logInvocation(data: {
    toolId: string;
    userId?: string;
    /**
     * Email from the JWT (OAuth or app-token). When `userId` doesn't
     * resolve to a real users row — common for MCP OAuth JWTs whose
     * `sub` is an external subject like `claude:user:xxx` rather than
     * our cuid — we look the user up by email and stamp `userId`
     * before persisting. Until this was added, 90% of cloud
     * tool_invocations were saved with `user_id = NULL` even though
     * the user was clearly authenticated.
     */
    userEmail?: string;
    mcpServerId?: string;
    /** Denormalized tenant + connector scope for per-org analytics and the KG. */
    organizationId?: string;
    connectorId?: string;
    /** Whether the call was routed through the proxy/unblocker (metering). */
    usedProxy?: boolean;
    /** Natural-language user intent that led to the call (opt-in capture). */
    intent?: string;
    input: Record<string, unknown>;
    output?: Record<string, unknown>;
    status: 'SUCCESS' | 'ERROR' | 'TIMEOUT';
    durationMs?: number;
    error?: string;
    clientInfo?: string;
  }): Promise<void> {
    const resolvedUserId = await this.resolveUserId(data.userId, data.userEmail);
    // Store an excerpt, not the whole payload (see bound-payload.ts). The
    // caller already has the full response; this is only the log.
    const input = boundPayload(data.input, { maxBytes: INVOCATION_LOG_INPUT_BYTES });
    const output = boundPayload(data.output, { maxBytes: INVOCATION_LOG_OUTPUT_BYTES });
    const error = boundText(data.error, INVOCATION_LOG_ERROR_CHARS);

    try {
      await this.prisma.toolInvocation.create({
        data: {
          toolId: data.toolId,
          userId: resolvedUserId,
          mcpServerId: data.mcpServerId,
          organizationId: data.organizationId,
          connectorId: data.connectorId,
          usedProxy: data.usedProxy ?? false,
          intent: data.intent,
          input: input as any,
          output: output as any,
          status: data.status as InvocationStatus,
          durationMs: data.durationMs,
          error,
          clientInfo: data.clientInfo,
        },
      });
      // Activation milestone: stamp the user's first successful call. The
      // conditional where makes this a no-op after the first success, so it
      // stays cheap on the hot path and never overwrites the original time.
      if (data.status === 'SUCCESS' && resolvedUserId) {
        await this.stampFirstSuccess(resolvedUserId);
      }
    } catch (error: any) {
      // FK violation should be impossible after resolveUserId, but
      // keep the safety net: if it still trips, retry without user_id
      // so we at least keep the row for aggregate metrics.
      if (error.message?.includes('user_id_fkey') && resolvedUserId) {
        try {
          await this.prisma.toolInvocation.create({
            data: {
              toolId: data.toolId,
              mcpServerId: data.mcpServerId,
              organizationId: data.organizationId,
              connectorId: data.connectorId,
              usedProxy: data.usedProxy ?? false,
              input: input as any,
              output: output as any,
              status: data.status as InvocationStatus,
              durationMs: data.durationMs,
              error,
              clientInfo: data.clientInfo,
            },
          });
          return;
        } catch (retryError: any) {
          this.logger.warn(
            `Failed to persist invocation for tool ${data.toolId} (retry): ${retryError.message}`,
          );
          return;
        }
      }
      this.logger.warn(
        `Failed to persist invocation for tool ${data.toolId}: ${error.message}`,
      );
    }
    this.logger.debug(
      `Tool invocation: ${data.toolId} [${data.status}] ${data.durationMs ?? 0}ms`,
    );
  }

  /**
   * Return a `user_id` that is guaranteed to satisfy the FK constraint,
   * or `undefined`. Order of preference:
   *   1. The `userId` we were given, IF it exists in users.
   *   2. A user matched by `userEmail` (case-insensitive, single row).
   *   3. undefined (genuinely anonymous — e.g. static bearer token).
   *
   * Small in-memory cache on email so the hot MCP path doesn't issue
   * a SELECT on every single tool invocation.
   */
  private emailToIdCache = new Map<string, string>();

  private async resolveUserId(
    userId: string | undefined,
    userEmail: string | undefined,
  ): Promise<string | undefined> {
    if (userId) {
      const exists = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (exists) return userId;
    }

    if (!userEmail) return undefined;
    const key = userEmail.toLowerCase();
    const cached = this.emailToIdCache.get(key);
    if (cached) return cached;

    const byEmail = await this.prisma.user.findUnique({
      where: { email: key },
      select: { id: true },
    });
    if (!byEmail) return undefined;

    this.emailToIdCache.set(key, byEmail.id);
    return byEmail.id;
  }

  /**
   * Record the user's first successful tool invocation. `updateMany` with a
   * `firstSuccessfulInvocationAt: null` guard updates exactly zero rows once
   * the milestone is set, so this is a single cheap indexed write that runs
   * harmlessly on every success. Best-effort: never let it break logging.
   */
  private async stampFirstSuccess(userId: string): Promise<void> {
    try {
      await this.prisma.user.updateMany({
        where: { id: userId, firstSuccessfulInvocationAt: null },
        data: { firstSuccessfulInvocationAt: new Date() },
      });
    } catch (error: any) {
      this.logger.debug(
        `Could not stamp first-success for user ${userId}: ${error.message}`,
      );
    }
  }

  private orgScope(organizationId?: string): any {
    if (!organizationId) return {};
    return { tool: { connector: { organizationId } } };
  }

  async getRecentInvocations(
    limit = 100,
    offset = 0,
    filters?: {
      toolId?: string;
      status?: InvocationStatus;
      search?: string;
      connectorId?: string;
      mcpServerId?: string;
      organizationId?: string;
    },
  ) {
    const where: any = { ...this.orgScope(filters?.organizationId) };
    if (filters?.toolId) where.toolId = filters.toolId;
    if (filters?.status) where.status = filters.status;
    if (filters?.mcpServerId) where.mcpServerId = filters.mcpServerId;
    if (filters?.search) {
      where.tool = { ...where.tool, name: { contains: filters.search, mode: 'insensitive' } };
    }
    if (filters?.connectorId) {
      where.tool = { ...where.tool, connectorId: filters.connectorId };
    }

    return this.prisma.toolInvocation.findMany({
      where,
      take: limit,
      skip: offset,
      orderBy: { createdAt: 'desc' },
      include: {
        tool: {
          select: {
            name: true,
            connectorId: true,
            connector: { select: { name: true, type: true } },
          },
        },
        user: {
          select: { id: true, email: true, name: true },
        },
        mcpServer: {
          select: { id: true, name: true, slug: true },
        },
      },
    });
  }

  async getStats(organizationId?: string) {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const scope = this.orgScope(organizationId);

    const [total24h, errors24h, total7d, totalAll] = await Promise.all([
      this.prisma.toolInvocation.count({
        where: { createdAt: { gte: last24h }, ...scope },
      }),
      this.prisma.toolInvocation.count({
        where: { createdAt: { gte: last24h }, status: 'ERROR', ...scope },
      }),
      this.prisma.toolInvocation.count({
        where: { createdAt: { gte: last7d }, ...scope },
      }),
      this.prisma.toolInvocation.count({ where: scope }),
    ]);

    return {
      invocations24h: total24h,
      errors24h,
      invocations7d: total7d,
      totalInvocations: totalAll,
    };
  }

  /**
   * Analytics: time-series invocation data for the last 7 days,
   * grouped by day and status. Also returns top tools by usage.
   */
  async getAnalytics(organizationId?: string, days = 7) {
    const safeDays = Math.min(Math.max(days || 7, 1), 365);
    const now = new Date();
    const since = new Date(now.getTime() - safeDays * 24 * 60 * 60 * 1000);
    const scope = this.orgScope(organizationId);

    // Get all invocations for the selected window
    const invocations = await this.prisma.toolInvocation.findMany({
      where: { createdAt: { gte: since }, ...scope },
      select: {
        status: true,
        durationMs: true,
        createdAt: true,
        tool: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Group by day
    const dailyMap = new Map<string, { success: number; error: number; timeout: number; totalDuration: number; count: number }>();
    const toolUsageMap = new Map<string, { count: number; errors: number; avgDuration: number; totalDuration: number }>();

    for (const inv of invocations) {
      // Daily aggregation
      const dayKey = inv.createdAt.toISOString().slice(0, 10);
      if (!dailyMap.has(dayKey)) {
        dailyMap.set(dayKey, { success: 0, error: 0, timeout: 0, totalDuration: 0, count: 0 });
      }
      const day = dailyMap.get(dayKey)!;
      if (inv.status === 'SUCCESS') day.success++;
      else if (inv.status === 'ERROR') day.error++;
      else if (inv.status === 'TIMEOUT') day.timeout++;
      day.totalDuration += inv.durationMs || 0;
      day.count++;

      // Tool usage aggregation
      const toolName = inv.tool?.name || 'unknown';
      if (!toolUsageMap.has(toolName)) {
        toolUsageMap.set(toolName, { count: 0, errors: 0, avgDuration: 0, totalDuration: 0 });
      }
      const toolStats = toolUsageMap.get(toolName)!;
      toolStats.count++;
      if (inv.status === 'ERROR') toolStats.errors++;
      toolStats.totalDuration += inv.durationMs || 0;
    }

    // Build daily timeline (fill empty days) across the selected window
    const daily: Array<{ date: string; success: number; error: number; timeout: number; avgDuration: number }> = [];
    for (let i = safeDays - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      const stats = dailyMap.get(key) || { success: 0, error: 0, timeout: 0, totalDuration: 0, count: 0 };
      daily.push({
        date: key,
        success: stats.success,
        error: stats.error,
        timeout: stats.timeout,
        avgDuration: stats.count > 0 ? Math.round(stats.totalDuration / stats.count) : 0,
      });
    }

    // Top tools sorted by usage
    const topTools = Array.from(toolUsageMap.entries())
      .map(([name, stats]) => ({
        name,
        count: stats.count,
        errors: stats.errors,
        avgDuration: stats.count > 0 ? Math.round(stats.totalDuration / stats.count) : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      daily,
      topTools,
      totalInvocations: invocations.length,
      successRate: invocations.length > 0
        ? Math.round((invocations.filter(i => i.status === 'SUCCESS').length / invocations.length) * 100)
        : 0,
      avgDuration: invocations.length > 0
        ? Math.round(invocations.reduce((sum, i) => sum + (i.durationMs || 0), 0) / invocations.length)
        : 0,
    };
  }

  /**
   * Usage & cost breakdowns over the last `days`, grouped by connector, MCP
   * server and user — plus proxy-call metering and a volume-based cost estimate.
   *
   * Uses the denormalized `organizationId` column (PR-0a) with `groupBy` so it
   * scales far better than loading every row. Cost has no LLM-token component:
   * estimate = calls × COST_PER_CALL_MICROS + proxyCalls × COST_PER_PROXY_CALL_MICROS
   * (both env-configurable, default 0 → shows 0 until an operator sets rates).
   */
  async getBreakdowns(organizationId: string, days = 30) {
    const safeDays = Math.min(Math.max(days || 30, 1), 365);
    const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
    const where = { organizationId, createdAt: { gte: since } };
    const errWhere = { ...where, status: 'ERROR' as InvocationStatus };

    const [
      byConnector, byConnectorErr,
      byServer, byServerErr,
      byUser, byUserErr,
      total, errors, proxyCalls,
    ] = await Promise.all([
      this.prisma.toolInvocation.groupBy({ by: ['connectorId'], where, _count: { _all: true } }),
      this.prisma.toolInvocation.groupBy({ by: ['connectorId'], where: errWhere, _count: { _all: true } }),
      this.prisma.toolInvocation.groupBy({ by: ['mcpServerId'], where, _count: { _all: true } }),
      this.prisma.toolInvocation.groupBy({ by: ['mcpServerId'], where: errWhere, _count: { _all: true } }),
      this.prisma.toolInvocation.groupBy({ by: ['userId'], where, _count: { _all: true } }),
      this.prisma.toolInvocation.groupBy({ by: ['userId'], where: errWhere, _count: { _all: true } }),
      this.prisma.toolInvocation.count({ where }),
      this.prisma.toolInvocation.count({ where: errWhere }),
      this.prisma.toolInvocation.count({ where: { ...where, usedProxy: true } }),
    ]);

    // Resolve display names for the grouped ids (one query per dimension).
    const connIds = byConnector.map((r) => r.connectorId).filter(Boolean) as string[];
    const srvIds = byServer.map((r) => r.mcpServerId).filter(Boolean) as string[];
    const userIds = byUser.map((r) => r.userId).filter(Boolean) as string[];
    const [conns, srvs, users] = await Promise.all([
      connIds.length
        ? this.prisma.connector.findMany({ where: { id: { in: connIds } }, select: { id: true, name: true } })
        : [],
      srvIds.length
        ? this.prisma.mcpServerConfig.findMany({ where: { id: { in: srvIds } }, select: { id: true, name: true } })
        : [],
      userIds.length
        ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, name: true } })
        : [],
    ]);
    const connName = new Map(conns.map((c) => [c.id, c.name]));
    const srvName = new Map(srvs.map((s) => [s.id, s.name]));
    const userName = new Map(users.map((u) => [u.id, u.name || u.email]));

    const merge = (
      rows: Array<{ _count: { _all: number } } & Record<string, any>>,
      errRows: Array<{ _count: { _all: number } } & Record<string, any>>,
      key: string,
      label: (id: string | null) => string,
    ) => {
      const errById = new Map(errRows.map((r) => [r[key] ?? '__null__', r._count._all]));
      return rows
        .map((r) => {
          const id = r[key] as string | null;
          return {
            id,
            label: label(id),
            count: r._count._all,
            errors: errById.get(id ?? '__null__') ?? 0,
          };
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);
    };

    const callRate = Number(process.env.COST_PER_CALL_MICROS) || 0;
    const proxyRate = Number(process.env.COST_PER_PROXY_CALL_MICROS) || 0;

    return {
      days: safeDays,
      total,
      errors,
      proxyCalls,
      estCostMicros: total * callRate + proxyCalls * proxyRate,
      rates: { callMicros: callRate, proxyCallMicros: proxyRate },
      byConnector: merge(byConnector, byConnectorErr, 'connectorId', (id) =>
        id ? (connName.get(id) ?? 'Unknown connector') : 'No connector',
      ),
      byServer: merge(byServer, byServerErr, 'mcpServerId', (id) =>
        id ? (srvName.get(id) ?? 'Unknown server') : 'Direct / no server',
      ),
      byUser: merge(byUser, byUserErr, 'userId', (id) =>
        id ? (userName.get(id) ?? 'Unknown user') : 'Anonymous',
      ),
    };
  }
}
