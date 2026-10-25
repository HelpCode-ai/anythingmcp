import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { boundPayload, boundText } from './bound-payload';

/** Bytes of a call's input / output kept in tool_invocations, and error chars. */
const envInt = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
const INVOCATION_LOG_INPUT_BYTES = envInt('INVOCATION_LOG_INPUT_BYTES', 8 * 1024);
const INVOCATION_LOG_OUTPUT_BYTES = envInt('INVOCATION_LOG_OUTPUT_BYTES', 16 * 1024);
const INVOCATION_LOG_ERROR_CHARS = envInt('INVOCATION_LOG_ERROR_CHARS', 4000);
/**
 * A failure that repeats with the same connector, tool and error inside this
 * window is counted on the row already stored (repeat_count) instead of being
 * stored again. 1885Data's own gateway answered 21,000 calls a day with the
 * same 429; every one of them used to become a row.
 */
const INVOCATION_REPEAT_WINDOW_MS = envInt('INVOCATION_REPEAT_WINDOW_SECONDS', 60) * 1000;
/**
 * Calls an organisation may log per hour with their full input/output
 * excerpts. Past it, rows keep status, timing and error but only a short
 * excerpt: a backend calling at 80 a minute filled 1.8 GB of payloads that
 * nobody reads, while counts and errors are what the dashboards use.
 */
const INVOCATION_FULL_PAYLOADS_PER_HOUR = envInt('INVOCATION_FULL_PAYLOADS_PER_HOUR', 1000);
const INVOCATION_LOG_VOLUME_EXCERPT_BYTES = 512;
const REPEAT_KEYS_MAX = 10_000;
import { PrismaService } from '../common/prisma.service';
import { findUserByEmail, normalizeEmail } from '../common/email.util';
import { InvocationStatus, Prisma } from '../generated/prisma/client';
import { AdsActivationService } from './ads-activation.service';
import { FirstSuccessService } from './first-success.service';
import { AlertsService } from '../alerts/alerts.service';
import { ANALYTICS_DEFAULT_DAYS, ANALYTICS_MAX_DAYS } from './analytics-query.dto';

@Injectable()
export class AuditService implements OnModuleDestroy {
  private readonly logger = new Logger(AuditService.name);
  /** Recent failures by signature: the row they were stored as, and how many repeats since. */
  private readonly repeats = new Map<string, { rowId: string; since: number; extra: number }>();
  /** Rows per organisation in the current hour, for the full-payload budget. */
  private volume = { hour: -1, perOrg: new Map<string, number>() };
  private readonly flushTimer: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly adsActivation?: AdsActivationService,
    @Optional() private readonly alerts?: AlertsService,
    @Optional() private readonly firstSuccess?: FirstSuccessService,
  ) {
    this.flushTimer = setInterval(() => void this.flushRepeats(false), 30_000);
    this.flushTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.flushTimer);
    await this.flushRepeats(true);
  }

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
    /** The caller contributed to skill learning when the call was made. */
    learnable?: boolean;
    input: Record<string, unknown>;
    output?: Record<string, unknown>;
    status: 'SUCCESS' | 'ERROR' | 'TIMEOUT';
    durationMs?: number;
    error?: string;
    clientInfo?: string;
  }): Promise<void> {
    // Every failing call, not just the ones that end up as a fresh row: the
    // repeat-dedup check just below collapses an identical, fast-repeating
    // failure into a counter on the first row instead of writing it again,
    // so a hook placed after that check (or after the DB write) would miss
    // most of a real outage. Fire-and-forget; recordFailure never throws,
    // and this catch is defense in depth so it can never affect the call
    // that triggered it either way.
    if (data.status !== 'SUCCESS' && data.organizationId && data.connectorId) {
      this.alerts
        ?.recordFailure({
          organizationId: data.organizationId,
          connectorId: data.connectorId,
          toolId: data.toolId,
          error: data.error,
        })
        .catch((err: any) => this.logger.warn(`Alert dispatch failed: ${err?.message || err}`));
    }

    const repeatKey = data.status === 'SUCCESS' ? null : repeatSignature(data);
    if (repeatKey && this.countRepeat(repeatKey)) return;

    const resolvedUserId = await this.resolveUserId(data.userId, data.userEmail);
    // Store an excerpt, not the whole payload (see bound-payload.ts). The
    // caller already has the full response; this is only the log.
    const overBudget = this.overPayloadBudget(data.organizationId);
    const input = boundPayload(data.input, {
      maxBytes: overBudget ? INVOCATION_LOG_VOLUME_EXCERPT_BYTES : INVOCATION_LOG_INPUT_BYTES,
    });
    const output = boundPayload(data.output, {
      maxBytes: overBudget ? INVOCATION_LOG_VOLUME_EXCERPT_BYTES : INVOCATION_LOG_OUTPUT_BYTES,
    });
    const error = boundText(data.error, INVOCATION_LOG_ERROR_CHARS);

    try {
      const row = await this.prisma.toolInvocation.create({
        select: { id: true },
        data: {
          toolId: data.toolId,
          userId: resolvedUserId,
          mcpServerId: data.mcpServerId,
          organizationId: data.organizationId,
          connectorId: data.connectorId,
          usedProxy: data.usedProxy ?? false,
          intent: data.intent,
          learnable: data.learnable ?? false,
          input: input as any,
          output: output as any,
          status: data.status as InvocationStatus,
          durationMs: data.durationMs,
          error,
          clientInfo: data.clientInfo,
        },
      });
      if (repeatKey && row?.id) await this.startRepeat(repeatKey, row.id);
      // Activation milestone: stamp the user's first successful call. The
      // conditional where makes this a no-op after the first success, so it
      // stays cheap on the hot path and never overwrites the original time.
      if (data.status === 'SUCCESS' && resolvedUserId) {
        await this.stampFirstSuccess(resolvedUserId);
      }
      if (data.status === 'SUCCESS') this.reportActivation(data);
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
          if (data.status === 'SUCCESS') this.reportActivation(data);
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
   * Cloud: a workspace's first success may be a Google Ads activation (see
   * ads-activation.service.ts), and on the no-card trial it makes the
   * workspace eligible for the card-trial offer (first-success.service.ts).
   * Both run in the background and never throw here.
   */
  private reportActivation(data: { organizationId?: string; connectorId?: string; toolId: string }): void {
    try {
      void this.adsActivation?.onSuccessfulInvocation(data.organizationId);
    } catch (err: any) {
      this.logger.debug(`Ads activation hook failed: ${err?.message ?? err}`);
    }
    try {
      void this.firstSuccess?.onSuccessfulInvocation(data.organizationId, {
        connectorId: data.connectorId,
        toolId: data.toolId,
      });
    } catch (err: any) {
      this.logger.debug(`First-success hook failed: ${err?.message ?? err}`);
    }
  }

  /**
   * True when this failure repeats one stored less than a window ago: it is
   * then counted on that row and not stored again.
   */
  private countRepeat(key: string): boolean {
    const seen = this.repeats.get(key);
    if (!seen || Date.now() - seen.since >= INVOCATION_REPEAT_WINDOW_MS) return false;
    seen.extra += 1;
    return true;
  }

  /** Remember a stored failure as the row its repeats count on. */
  private async startRepeat(key: string, rowId: string): Promise<void> {
    const previous = this.repeats.get(key);
    if (previous?.extra) await this.writeRepeatCount(previous.rowId, previous.extra);
    this.repeats.delete(key);
    this.repeats.set(key, { rowId, since: Date.now(), extra: 0 });
    if (this.repeats.size > REPEAT_KEYS_MAX) await this.flushRepeats(false, true);
  }

  /**
   * Write the counted repeats onto their rows. `all` flushes everything (on
   * shutdown); `trim` also drops the oldest half when the map is full.
   */
  async flushRepeats(all: boolean, trim = false): Promise<void> {
    const now = Date.now();
    const entries = [...this.repeats.entries()];
    const drop = trim ? new Set(entries.slice(0, Math.ceil(entries.length / 2)).map(([k]) => k)) : new Set<string>();
    for (const [key, seen] of entries) {
      const expired = now - seen.since >= INVOCATION_REPEAT_WINDOW_MS;
      if (!all && !expired && !drop.has(key)) continue;
      this.repeats.delete(key);
      if (seen.extra) await this.writeRepeatCount(seen.rowId, seen.extra);
    }
  }

  private async writeRepeatCount(rowId: string, extra: number): Promise<void> {
    try {
      await this.prisma.toolInvocation.update({
        where: { id: rowId },
        data: { repeatCount: { increment: extra } },
      });
    } catch (err: any) {
      // The row may have been pruned meanwhile; a lost count is not worth more.
      this.logger.debug(`Could not record ${extra} repeats on ${rowId}: ${err?.message ?? err}`);
    }
  }

  /** Calls matching `where`, counting the repeats a row stands for. */
  private async countCalls(where: Prisma.ToolInvocationWhereInput): Promise<number> {
    const agg = await this.prisma.toolInvocation.aggregate({ where, _sum: { repeatCount: true } });
    return agg._sum.repeatCount ?? 0;
  }

  /** Whether this organisation has used its hourly budget of full payloads. */
  private overPayloadBudget(organizationId?: string): boolean {
    if (!organizationId) return false;
    const hour = Math.floor(Date.now() / 3_600_000);
    if (this.volume.hour !== hour) this.volume = { hour, perOrg: new Map() };
    const n = (this.volume.perOrg.get(organizationId) ?? 0) + 1;
    this.volume.perOrg.set(organizationId, n);
    return n > INVOCATION_FULL_PAYLOADS_PER_HOUR;
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
    const key = normalizeEmail(userEmail);
    const cached = this.emailToIdCache.get(key);
    if (cached) return cached;

    const byEmail = await findUserByEmail<{ id: string; email: string }>(this.prisma, userEmail, { id: true });
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
      this.countCalls({ createdAt: { gte: last24h }, ...scope }),
      this.countCalls({ createdAt: { gte: last24h }, status: 'ERROR', ...scope }),
      this.countCalls({ createdAt: { gte: last7d }, ...scope }),
      this.countCalls(scope),
    ]);

    return {
      invocations24h: total24h,
      errors24h,
      invocations7d: total7d,
      totalInvocations: totalAll,
    };
  }

  /**
   * Analytics for the last `days` (capped at ANALYTICS_MAX_DAYS): calls per
   * UTC day by status, the 10 most used tools, success rate and durations.
   *
   * Postgres does the aggregation and returns one row per day and one per
   * tool name. This used to load every row of the window into Node and loop
   * over it: about 200k rows for a busy workspace over 7 days, which blocked
   * the event loop (and every other tenant) for 4.6 s.
   *
   * Semantics are unchanged: a row counts `repeat_count` calls (repeats of
   * the same failure), while durations are averaged per stored row for days
   * and the whole window and per call for tools, as before.
   */
  async getAnalytics(organizationId: string, days = ANALYTICS_DEFAULT_DAYS) {
    const safeDays = Math.min(
      Math.max(Math.floor(days) || ANALYTICS_DEFAULT_DAYS, 1),
      ANALYTICS_MAX_DAYS,
    );
    const now = new Date();
    const since = new Date(now.getTime() - safeDays * 24 * 60 * 60 * 1000);

    const groups = organizationId
      ? await this.prisma.$queryRaw<AnalyticsGroupRow[]>(analyticsQuery(organizationId, since))
      : [];

    const dailyMap = new Map<string, AnalyticsGroupRow>();
    const toolRows: AnalyticsGroupRow[] = [];
    let totalCalls = 0;
    let successCalls = 0;
    let totalDuration = 0;
    let storedRows = 0;
    for (const g of groups) {
      if (Number(g.by_tool) === 1) {
        toolRows.push(g);
        continue;
      }
      dailyMap.set(g.day as string, g);
      totalCalls += Number(g.calls);
      successCalls += Number(g.success);
      totalDuration += Number(g.duration);
      storedRows += Number(g.row_count);
    }

    // Daily timeline (empty days filled) across the selected window. The
    // partial UTC day `since` falls on stays out of it, as before, but its
    // calls count in the totals and top tools.
    const daily: Array<{ date: string; success: number; error: number; timeout: number; avgDuration: number }> = [];
    for (let i = safeDays - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      const g = dailyMap.get(key);
      const rows = g ? Number(g.row_count) : 0;
      daily.push({
        date: key,
        success: g ? Number(g.success) : 0,
        error: g ? Number(g.error) : 0,
        timeout: g ? Number(g.timeout) : 0,
        avgDuration: rows > 0 ? Math.round(Number(g!.duration) / rows) : 0,
      });
    }

    // Most used first; ties keep the order tools were first called in, as
    // the old in-memory loop (rows sorted by time) did.
    const topTools = toolRows
      .map((g) => {
        const count = Number(g.calls);
        return {
          name: g.tool_name as string,
          count,
          errors: Number(g.error),
          avgDuration: count > 0 ? Math.round(Number(g.duration) / count) : 0,
          firstAt: new Date(g.first_at).getTime(),
        };
      })
      .sort((a, b) => b.count - a.count || a.firstAt - b.firstAt || a.name.localeCompare(b.name))
      .slice(0, 10)
      .map(({ firstAt: _firstAt, ...tool }) => tool);

    return {
      daily,
      topTools,
      totalInvocations: totalCalls,
      successRate: totalCalls > 0 ? Math.round((successCalls / totalCalls) * 100) : 0,
      avgDuration: storedRows > 0 ? Math.round(totalDuration / storedRows) : 0,
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
      this.prisma.toolInvocation.groupBy({ by: ['connectorId'], where, _count: { _all: true }, _sum: { repeatCount: true } }),
      this.prisma.toolInvocation.groupBy({ by: ['connectorId'], where: errWhere, _count: { _all: true }, _sum: { repeatCount: true } }),
      this.prisma.toolInvocation.groupBy({ by: ['mcpServerId'], where, _count: { _all: true }, _sum: { repeatCount: true } }),
      this.prisma.toolInvocation.groupBy({ by: ['mcpServerId'], where: errWhere, _count: { _all: true }, _sum: { repeatCount: true } }),
      this.prisma.toolInvocation.groupBy({ by: ['userId'], where, _count: { _all: true }, _sum: { repeatCount: true } }),
      this.prisma.toolInvocation.groupBy({ by: ['userId'], where: errWhere, _count: { _all: true }, _sum: { repeatCount: true } }),
      this.countCalls(where),
      this.countCalls(errWhere),
      this.countCalls({ ...where, usedProxy: true }),
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
      rows: Array<{ _count: { _all: number }; _sum?: { repeatCount: number | null } } & Record<string, any>>,
      errRows: Array<{ _count: { _all: number }; _sum?: { repeatCount: number | null } } & Record<string, any>>,
      key: string,
      label: (id: string | null) => string,
    ) => {
      const calls = (r: { _count: { _all: number }; _sum?: { repeatCount: number | null } }) =>
        r._sum?.repeatCount ?? r._count._all;
      const errById = new Map(errRows.map((r) => [r[key] ?? '__null__', calls(r)]));
      return rows
        .map((r) => {
          const id = r[key] as string | null;
          return {
            id,
            label: label(id),
            count: calls(r),
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

/** One row of analyticsQuery: a UTC day (by_tool 0) or a tool name (by_tool 1). */
export interface AnalyticsGroupRow {
  by_tool: number | bigint;
  day: string | null;
  tool_name: string | null;
  calls: bigint | number;
  success: bigint | number;
  error: bigint | number;
  timeout: bigint | number;
  /** Sum of duration_ms over stored rows (null counts as 0). */
  duration: bigint | number;
  /** Stored rows, not calls: a row may stand for repeats. */
  row_count: bigint | number;
  first_at: Date | string;
}

/**
 * One pass over the workspace's calls since `since`, grouped both by UTC day
 * and by tool name (GROUPING SETS). Scoped like the rest of AuditService:
 * calls of tools whose connector belongs to the organisation. created_at is
 * a UTC `timestamp without time zone`, so to_char gives the same UTC date as
 * `toISOString().slice(0, 10)` whatever the session time zone is, and the
 * bound is converted to UTC explicitly for the same reason.
 */
export function analyticsQuery(organizationId: string, since: Date): Prisma.Sql {
  return Prisma.sql`
    WITH scoped AS (
      SELECT
        to_char(ti.created_at, 'YYYY-MM-DD') AS day,
        COALESCE(NULLIF(t.name, ''), 'unknown') AS tool_name,
        ti.status::text AS status,
        ti.repeat_count,
        COALESCE(ti.duration_ms, 0) AS duration_ms,
        ti.created_at
      FROM tool_invocations ti
      JOIN mcp_tools t ON t.id = ti.tool_id
      JOIN connectors c ON c.id = t.connector_id
      WHERE c.organization_id = ${organizationId}
        AND ti.created_at >= (${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
    )
    SELECT
      GROUPING(day) AS by_tool,
      day,
      tool_name,
      COALESCE(SUM(repeat_count), 0)::bigint AS calls,
      COALESCE(SUM(repeat_count) FILTER (WHERE status = 'SUCCESS'), 0)::bigint AS success,
      COALESCE(SUM(repeat_count) FILTER (WHERE status = 'ERROR'), 0)::bigint AS error,
      COALESCE(SUM(repeat_count) FILTER (WHERE status = 'TIMEOUT'), 0)::bigint AS timeout,
      COALESCE(SUM(duration_ms), 0)::bigint AS duration,
      COUNT(*)::bigint AS row_count,
      MIN(created_at) AS first_at
    FROM scoped
    GROUP BY GROUPING SETS ((day), (tool_name))
  `;
}

/**
 * What makes two failures "the same" for repeat counting: connector, tool,
 * status and the error text with numbers blanked (ids, timestamps and counts
 * differ between otherwise identical upstream errors).
 */
export function repeatSignature(data: {
  connectorId?: string;
  toolId: string;
  status: string;
  error?: string;
}): string {
  const text = (data.error ?? '').slice(0, 300).replace(/\d+/g, '#');
  return `${data.connectorId ?? ''}|${data.toolId}|${data.status}|${text}`;
}
