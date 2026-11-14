import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { LicenseService, type PlanChange } from '../license/license.service';
import { PlanFitService } from '../license/plan-fit.service';
import { CLOUD_PLAN_LIMITS, isFitPlan, type FitRanked } from '../license/plan-fit';
import {
  PAUSED_BY_PLAN_KEY,
  parsePausedByPlan,
  planCapsMode,
  planRank,
  type PausedByPlan,
} from '../license/plan-caps';
import { McpServerService } from '../mcp-server/mcp-server.service';
import { OrgSettingsService } from '../settings/org-settings.service';
import { EmailService } from '../settings/email.service';
import { ProductEventService, ProductEvents } from '../audit/product-event.service';

/**
 * The automatic downgrade and its undo (Cloud, Team trial plan 2026-11-09).
 *
 * When a workspace's plan changes to one with smaller caps (the Team-level
 * trial or Team → Starter), the connectors, MCP servers and File Search
 * folders above the new caps are paused (`isActive=false`, nothing deleted):
 * the most used in the last 30 days stay active, the same ranking the
 * paywall showed before checkout (PlanFitService). The admins get an email,
 * the ids are kept in OrgSettings, and the dashboard marks them so the user
 * can swap. When the plan grows again, the items still paused come back, up
 * to the new caps.
 *
 * Only a plan change triggers it, so paying workspaces already above their
 * cap are never touched. PLAN_CAPS_ENFORCE=dry-run (the default) only logs.
 */
@Injectable()
export class PlanCapsService implements OnModuleInit {
  private readonly logger = new Logger(PlanCapsService.name);
  /** One reconcile per workspace at a time; a second change waits for the first. */
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployment: DeploymentService,
    private readonly licenses: LicenseService,
    private readonly planFit: PlanFitService,
    private readonly mcpServer: McpServerService,
    private readonly orgSettings: OrgSettingsService,
    private readonly email: EmailService,
    private readonly productEvents: ProductEventService,
  ) {}

  onModuleInit(): void {
    if (!this.deployment.isCloud()) return;
    this.licenses.onPlanChange((change) => this.reconcile(change));
  }

  async reconcile(change: PlanChange): Promise<void> {
    const previous = this.running.get(change.organizationId) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(() => this.apply(change))
      .finally(() => {
        if (this.running.get(change.organizationId) === run) this.running.delete(change.organizationId);
      });
    this.running.set(change.organizationId, run);
    return run;
  }

  private async apply({ organizationId, from, to }: PlanChange): Promise<void> {
    if (!this.deployment.isCloud()) return;
    const mode = planCapsMode();
    if (mode === 'off') return;
    const toRank = planRank(to);
    const fromRank = planRank(from);
    if (toRank == null || toRank === 0) return; // unknown plan, or no licence any more

    if (isFitPlan(to)) await this.pauseOverCap(organizationId, from, to, mode === 'dry-run');
    if (fromRank != null && toRank > fromRank) await this.restore(organizationId, to!, mode === 'dry-run');
  }

  /** Pause what goes past `plan`'s caps, least used first. */
  private async pauseOverCap(organizationId: string, from: string | null, plan: 'starter' | 'team', dryRun: boolean): Promise<void> {
    const fit = await this.planFit.fit(organizationId, plan);
    const connectors = fit.connectors.pause;
    const servers = fit.mcpServers.pause;
    const folders = fit.fileSearch.connectors.pause;
    const total = connectors.length + servers.length + folders.length;
    if (total === 0) return;

    const summary = `${connectors.length} connectors, ${servers.length} MCP servers, ${folders.length} File Search folders`;
    await this.productEvents.log({
      event: ProductEvents.PLAN_CAPS_APPLIED,
      organizationId,
      metadata: { plan, kind: 'downgrade', status: dryRun ? 'dry-run' : 'on', calls: total },
    });
    if (dryRun) {
      this.logger.log(`[plan caps dry-run] ${from ?? 'none'} → ${plan} for org ${organizationId}: would pause ${summary}`);
      return;
    }

    const connectorIds = [...connectors, ...folders].map((c) => c.id);
    const serverIds = servers.map((s) => s.id);
    if (connectorIds.length) {
      await this.prisma.connector.updateMany({
        where: { organizationId, id: { in: connectorIds } },
        data: { isActive: false },
      });
    }
    if (serverIds.length) {
      await this.prisma.mcpServerConfig.updateMany({
        where: { organizationId, id: { in: serverIds } },
        data: { isActive: false },
      });
    }
    await this.reloadTools(connectorIds);

    // Keep what was paused before and is still paused, so an upgrade later
    // brings back everything this workspace lost to plan changes.
    const earlier = parsePausedByPlan(await this.orgSettings.get(organizationId, PAUSED_BY_PLAN_KEY));
    const merge = (now: string[], before: string[] = []) => [...new Set([...now, ...before])];
    const record: PausedByPlan = {
      plan,
      at: new Date().toISOString(),
      connectors: merge(connectors.map((c) => c.id), earlier?.connectors),
      mcpServers: merge(serverIds, earlier?.mcpServers),
      fileSearch: merge(folders.map((c) => c.id), earlier?.fileSearch),
    };
    await this.orgSettings.setJson(organizationId, PAUSED_BY_PLAN_KEY, record);
    this.logger.log(`Plan caps: ${from ?? 'none'} → ${plan} for org ${organizationId}: paused ${summary}`);

    await this.emailAdmins(organizationId, plan, fit.connectors, fit.mcpServers, fit.fileSearch.connectors).catch((err) =>
      this.logger.warn(`Plan caps email failed for ${organizationId}: ${err?.message ?? err}`),
    );
  }

  /** Bring back what plan changes paused, up to `plan`'s caps (unlimited above Team). */
  private async restore(organizationId: string, plan: string, dryRun: boolean): Promise<void> {
    const stored = parsePausedByPlan(await this.orgSettings.get(organizationId, PAUSED_BY_PLAN_KEY));
    if (!stored) return;
    const limits = isFitPlan(plan) ? CLOUD_PLAN_LIMITS[plan] : null;
    const snap = await this.planFit.snapshot(organizationId);

    const stillPaused = async (ids: string[], table: 'connector' | 'mcpServerConfig') => {
      if (ids.length === 0) return [] as string[];
      const rows =
        table === 'connector'
          ? await this.prisma.connector.findMany({ where: { organizationId, id: { in: ids }, isActive: false }, select: { id: true } })
          : await this.prisma.mcpServerConfig.findMany({ where: { organizationId, id: { in: ids }, isActive: false }, select: { id: true } });
      const found = new Set(rows.map((r) => r.id));
      return ids.filter((id) => found.has(id)); // keep the stored order
    };
    const room = (max: number | null | undefined, active: number) => (max == null ? Infinity : Math.max(0, max - active));

    const connectors = (await stillPaused(stored.connectors, 'connector')).slice(0, room(limits?.connectors, snap.connectors.length));
    const servers = (await stillPaused(stored.mcpServers, 'mcpServerConfig')).slice(0, room(limits?.mcpServers, snap.mcpServers.length));
    // File Search folders follow the File Search quota; the plan fit knows it.
    const folderMax = isFitPlan(plan) ? (await this.planFit.fit(organizationId, plan)).fileSearch.connectors.max : null;
    const folders = (await stillPaused(stored.fileSearch, 'connector')).slice(0, room(folderMax, snap.fileSearchConnectors.length));
    const total = connectors.length + servers.length + folders.length;
    if (total === 0) return;

    await this.productEvents.log({
      event: ProductEvents.PLAN_CAPS_APPLIED,
      organizationId,
      metadata: { ...(isFitPlan(plan) && { plan }), kind: 'restore', status: dryRun ? 'dry-run' : 'on', calls: total },
    });
    if (dryRun) {
      this.logger.log(`[plan caps dry-run] upgrade to ${plan} for org ${organizationId}: would restore ${total} items`);
      return;
    }

    const connectorIds = [...connectors, ...folders];
    if (connectorIds.length) {
      await this.prisma.connector.updateMany({ where: { organizationId, id: { in: connectorIds } }, data: { isActive: true } });
    }
    if (servers.length) {
      await this.prisma.mcpServerConfig.updateMany({ where: { organizationId, id: { in: servers } }, data: { isActive: true } });
    }
    await this.reloadTools(connectorIds);

    const left: PausedByPlan = {
      ...stored,
      connectors: stored.connectors.filter((id) => !connectors.includes(id)),
      mcpServers: stored.mcpServers.filter((id) => !servers.includes(id)),
      fileSearch: stored.fileSearch.filter((id) => !folders.includes(id)),
    };
    if (left.connectors.length + left.mcpServers.length + left.fileSearch.length === 0) {
      await this.orgSettings.delete(organizationId, PAUSED_BY_PLAN_KEY);
    } else {
      await this.orgSettings.setJson(organizationId, PAUSED_BY_PLAN_KEY, left);
    }
    this.logger.log(`Plan caps: upgrade to ${plan} for org ${organizationId}: restored ${total} items`);
  }

  /** Tools of paused or restored connectors leave or join the MCP surface at once. */
  private async reloadTools(connectorIds: string[]): Promise<void> {
    for (const id of connectorIds) {
      await this.mcpServer
        .reloadConnectorTools(id, { notifySessions: false, syncKg: false })
        .catch((err) => this.logger.warn(`Tool reload failed for ${id}: ${err?.message ?? err}`));
    }
  }

  private async emailAdmins(
    organizationId: string,
    plan: 'starter' | 'team',
    connectors: FitRanked,
    servers: FitRanked,
    folders: FitRanked,
  ): Promise<void> {
    const admins = await this.prisma.organizationMember.findMany({
      where: { organizationId, role: 'ADMIN', deactivatedAt: null },
      select: { user: { select: { email: true, name: true } } },
    });
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } });
    for (const { user } of admins) {
      if (!user?.email) continue;
      await this.email.sendPlanCapsAppliedEmail(
        user.email,
        {
          name: user.name ?? null,
          workspaceName: org?.name ?? '',
          planName: plan === 'starter' ? 'Starter' : 'Team',
          paused: {
            connectors: connectors.pause.map((c) => c.name),
            mcpServers: servers.pause.map((s) => s.name),
            fileSearch: folders.pause.map((f) => f.name),
          },
          kept: { connectors: connectors.keep.length, mcpServers: servers.keep.length },
        },
        organizationId,
      );
    }
  }
}
