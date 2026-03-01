import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { InvocationStatus } from '../generated/prisma/client';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async logInvocation(data: {
    toolId: string;
    userId?: string;
    input: Record<string, unknown>;
    output?: Record<string, unknown>;
    status: 'SUCCESS' | 'ERROR' | 'TIMEOUT';
    durationMs?: number;
    error?: string;
    clientInfo?: string;
  }): Promise<void> {
    try {
      await this.prisma.toolInvocation.create({
        data: {
          toolId: data.toolId,
          userId: data.userId,
          input: data.input as any,
          output: data.output as any,
          status: data.status as InvocationStatus,
          durationMs: data.durationMs,
          error: data.error,
          clientInfo: data.clientInfo,
        },
      });
    } catch (error: any) {
      this.logger.warn(
        `Failed to persist invocation for tool ${data.toolId}: ${error.message}`,
      );
    }
    this.logger.debug(
      `Tool invocation: ${data.toolId} [${data.status}] ${data.durationMs ?? 0}ms`,
    );
  }

  async getRecentInvocations(
    limit = 100,
    offset = 0,
    filters?: { toolId?: string; status?: InvocationStatus },
  ) {
    const where: any = {};
    if (filters?.toolId) where.toolId = filters.toolId;
    if (filters?.status) where.status = filters.status;

    return this.prisma.toolInvocation.findMany({
      where,
      take: limit,
      skip: offset,
      orderBy: { createdAt: 'desc' },
      include: {
        tool: { select: { name: true, connectorId: true } },
      },
    });
  }

  async getStats() {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [total24h, errors24h, total7d, totalAll] = await Promise.all([
      this.prisma.toolInvocation.count({
        where: { createdAt: { gte: last24h } },
      }),
      this.prisma.toolInvocation.count({
        where: { createdAt: { gte: last24h }, status: 'ERROR' },
      }),
      this.prisma.toolInvocation.count({
        where: { createdAt: { gte: last7d } },
      }),
      this.prisma.toolInvocation.count(),
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
  async getAnalytics() {
    const now = new Date();
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Get all invocations for the last 7 days
    const invocations = await this.prisma.toolInvocation.findMany({
      where: { createdAt: { gte: last7d } },
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

    // Build daily timeline (fill empty days)
    const daily: Array<{ date: string; success: number; error: number; timeout: number; avgDuration: number }> = [];
    for (let i = 6; i >= 0; i--) {
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
}
