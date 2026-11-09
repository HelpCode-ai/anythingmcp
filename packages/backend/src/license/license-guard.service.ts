import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { LicenseService } from './license.service';
import { DeploymentService } from '../common/deployment.service';
import { cardTrialEnd } from './license-checkout';
import { codeToolCapForPlan, inlineCodeAllowedForPlan, effectiveCodeModePlan } from './code-mode-quotas';
import { codeRunQuotaPlan } from './code-run-quotas';
import type { LicenseInfo } from './license.service';

export interface UsageCap {
  current: number;
  max: number | null;
  isOver: boolean;
}

export interface LicenseUsage {
  plan: string | null;
  connectors: UsageCap;
  mcpServers: UsageCap;
  users: UsageCap;
  // True when any axis is over its cap. Frontend uses this to render the
  // soft-warn upgrade banner. Caps on paid tiers are advisory only — we no
  // longer throw 403 when exceeded (per product decision May 2026).
  isOverAny: boolean;
}

/** What an AI client is told when a Cloud workspace's free trial has ended. */
export const TRIAL_ENDED_MESSAGE =
  'This workspace\'s trial has ended. Ask a workspace administrator to activate a license.';

/**
 * The licence check refused a call because the workspace's free trial ended
 * (Cloud only). A ForbiddenException like the guard's other refusals, so every
 * caller that only reads `message` keeps working; the MCP tool path tells it
 * apart to answer with a reactivation link and to record the blocked call.
 * `trialEndedAt` is null only when the licence carries no end date.
 */
export class TrialEndedException extends ForbiddenException {
  constructor(readonly trialEndedAt: Date | null) {
    super(TRIAL_ENDED_MESSAGE);
    this.name = 'TrialEndedException';
  }
}

/** A Cloud workspace's free trial, as the setup tools report it. */
export interface TrialState {
  endsAt: Date;
  /** False once the end has passed or the licence is no longer active. */
  active: boolean;
  /** Enough of the trial left (48 h) for a card trial ending at the same time. */
  cardTrialAvailable: boolean;
}

/**
 * The connectors and MCP servers that count against a plan's limits: active
 * ones only (a paused one can be swapped back in), and File Search folders
 * apart, since File Search has its own limits per plan. `PlanFitService`
 * counts the same way.
 */
const PLAN_COUNTED_CONNECTOR = { isActive: true, type: { not: 'FILE_SEARCH' as const } };
const PLAN_COUNTED_SERVER = { isActive: true };

@Injectable()
export class LicenseGuardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly licenseService: LicenseService,
    private readonly deployment: DeploymentService,
  ) {}

  async checkLicenseActive(organizationId?: string): Promise<void> {
    if (!this.deployment.isCloud()) return;

    const license = await this.licenseService.getCurrentLicense(organizationId);
    if (!license) {
      // The hourly cron flips an ended trial to status 'expired' (see
      // markExpiredTrials), after which it is no longer the current licence.
      // Still a trial that ended, not a workspace without a licence: only the
      // newest inactive licence counts, so a paid one revoked after the trial
      // keeps the message below.
      if (organizationId) {
        const last = await this.licenseService.getLatestInactiveLicense(organizationId);
        if (last?.plan === 'trial' && last.status === 'expired') {
          throw new TrialEndedException(last.expiresAt ? new Date(last.expiresAt) : null);
        }
      }
      throw new ForbiddenException(
        'This workspace has no active license. Ask a workspace administrator to activate one.',
      );
    }

    if (license.status !== 'active') {
      throw new ForbiddenException(
        'This workspace\'s license is not active. Ask a workspace administrator to renew it.',
      );
    }

    // Every plan, not only trials: a paid licence carries an expiresAt while
    // its renewal payment is failing (the end of the grace period), and must
    // stop on that date even if nobody has re-verified it since.
    if (license.expiresAt && new Date(license.expiresAt) < new Date()) {
      if (license.plan === 'trial') throw new TrialEndedException(new Date(license.expiresAt));
      throw new ForbiddenException(
        'This workspace\'s license has expired. Ask a workspace administrator to renew it.',
      );
    }
  }

  /**
   * Soft-warn policy: connector/MCP-server caps on paid tiers DO NOT BLOCK.
   * The cap is exposed via getUsage() so the frontend can render an upgrade
   * banner. Trial keeps a hard cap because it's a sales tool — abuse risk
   * outweighs the friction.
   */
  async checkCanCreateConnector(userId: string, organizationId?: string): Promise<void> {
    if (!this.deployment.isCloud()) return;
    await this.checkLicenseActive(organizationId);

    const license = await this.licenseService.getCurrentLicense(organizationId);
    if (license?.plan !== 'trial') return;

    const maxConnectors = (license?.features as any)?.maxConnectors;
    if (maxConnectors == null) return;

    const count = await this.prisma.connector.count({
      where: { ...(organizationId ? { organizationId } : { userId }), ...PLAN_COUNTED_CONNECTOR },
    });
    if (count >= maxConnectors) {
      throw new ForbiddenException(
        `Trial limit reached (${maxConnectors} connectors). A workspace administrator can activate a license to add more.`,
      );
    }
  }

  async checkCanCreateMcpServer(userId: string, organizationId?: string): Promise<void> {
    if (!this.deployment.isCloud()) return;
    await this.checkLicenseActive(organizationId);

    const license = await this.licenseService.getCurrentLicense(organizationId);
    if (license?.plan !== 'trial') return;

    const maxMcpServers = (license?.features as any)?.maxMcpServers;
    if (maxMcpServers == null) return;

    const count = await this.prisma.mcpServerConfig.count({
      where: { ...(organizationId ? { organizationId } : { userId }), ...PLAN_COUNTED_SERVER },
    });
    if (count >= maxMcpServers) {
      throw new ForbiddenException(
        `Trial limit reached (${maxMcpServers} MCP servers). A workspace administrator can activate a license to add more.`,
      );
    }
  }

  /**
   * Saved code tools are capped like connectors/servers: a hard cap on the
   * Cloud trial (abuse control), soft elsewhere (paid tiers do not block). The
   * number is a licence feature (`features.maxCodeTools`), set per plan on the
   * licensing site, so no plan→number mapping is hardcoded here. Self-hosted is
   * never capped. Counting is by the tool's endpoint method, joined to the
   * connector for the org scope.
   */
  async checkCanCreateCodeTool(organizationId?: string): Promise<void> {
    // On Cloud an active licence is required first (and an ended trial gets the
    // reactivation message); self-hosted self-guards this to a no-op.
    await this.checkLicenseActive(organizationId);

    const license = await this.licenseService.getCurrentLicense(organizationId);
    const plan = this.codeModePlan(license);
    const cap = codeToolCapForPlan(plan, (license?.features as any)?.maxCodeTools);
    // Unlimited (Enterprise), or no org to count against: nothing to enforce.
    if (cap == null || !organizationId) return;

    const count = await this.countCodeTools(organizationId);
    if (count >= cap) {
      throw new ForbiddenException(
        `Plan limit reached (${cap} code tools on the ${plan} plan). Upgrade the plan to add more.`,
      );
    }
  }

  /**
   * Whether this workspace's plan includes inline code — the generic
   * `code_execute` and `code_propose_tool` tools (Team and above). Gates their
   * exposure on the MCP endpoint, in addition to the per-server `codeMode` and
   * the caller's `inlineCode` role capability. Applies on Cloud and self-hosted.
   */
  async canUseInlineCode(organizationId?: string): Promise<boolean> {
    const license = await this.licenseService.getCurrentLicense(organizationId);
    return inlineCodeAllowedForPlan(this.codeModePlan(license));
  }

  /**
   * The plan this workspace is treated as for code mode. Every Cloud trial is
   * promoted to the Team experience (inline code and the Team code-tool cap)
   * so a new workspace can try everything. Self-hosted trials carry no Stripe
   * billing and are not promoted.
   */
  private codeModePlan(license: LicenseInfo | null): string {
    return effectiveCodeModePlan(license?.plan, this.isCardTrial(license), this.deployment.isCloud());
  }

  /** A Cloud trial with a card on file (`billing.status='trialing'`). */
  private isCardTrial(license: LicenseInfo | null): boolean {
    return license?.plan === 'trial' && license?.billing?.status === 'trialing';
  }

  /**
   * The plan whose code-run quotas apply to a workspace: Team for a card-backed
   * trial, `trial` (a small budget) for a trial without a card, otherwise the
   * licence plan. `community` when there is no resolvable licence.
   */
  async codeRunPlanForOrg(organizationId?: string): Promise<string> {
    const license = await this.licenseService.getCurrentLicense(organizationId);
    return codeRunQuotaPlan(license?.plan, this.isCardTrial(license));
  }

  /**
   * The effective code-mode plan for a workspace (a Cloud trial resolves to
   * `team`). Plan resolution stays here, next to the other code-mode gating.
   * Returns `community` when there is no resolvable licence.
   */
  async codeModePlanForOrg(organizationId?: string): Promise<string> {
    const license = await this.licenseService.getCurrentLicense(organizationId);
    return this.codeModePlan(license);
  }

  /** How many saved code tools an organization has (endpoint method 'code'). */
  private async countCodeTools(organizationId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM mcp_tools t
      JOIN connectors c ON c.id = t.connector_id
      WHERE c.organization_id = ${organizationId}
        AND t.endpoint_mapping->>'method' = 'code'`;
    return rows[0]?.count ?? 0;
  }

  /**
   * Report current usage and caps so the frontend can render an upgrade
   * nudge. Used by GET /license/usage.
   */
  async getUsage(userId?: string, organizationId?: string): Promise<LicenseUsage> {
    const license = await this.licenseService.getCurrentLicense(organizationId);
    const features = (license?.features as any) ?? {};
    const where = organizationId ? { organizationId } : userId ? { userId } : undefined;

    const [connectorCount, mcpCount, userCount] = await Promise.all([
      where ? this.prisma.connector.count({ where: { ...where, ...PLAN_COUNTED_CONNECTOR } }) : Promise.resolve(0),
      where ? this.prisma.mcpServerConfig.count({ where: { ...where, ...PLAN_COUNTED_SERVER } }) : Promise.resolve(0),
      // Active members of the workspace, not users whose primary workspace it
      // is: someone invited into a second workspace keeps their first one as
      // User.organizationId, and a deactivated member holds no seat.
      organizationId
        ? this.prisma.organizationMember.count({ where: { organizationId, deactivatedAt: null } })
        : Promise.resolve(userId ? 1 : 0),
    ]);

    const wrap = (current: number, max: number | null | undefined): UsageCap => ({
      current,
      max: max ?? null,
      isOver: max != null && current > max,
    });

    const connectors = wrap(connectorCount, features.maxConnectors);
    const mcpServers = wrap(mcpCount, features.maxMcpServers);
    const users = wrap(userCount, features.maxUsers);

    return {
      plan: license?.plan ?? null,
      connectors,
      mcpServers,
      users,
      isOverAny: connectors.isOver || mcpServers.isOver || users.isOver,
    };
  }

  /**
   * Cloud only: the workspace's free trial, running or ended. Null on a paid
   * plan, with no licence at all, and on self-hosted (whose trial is the
   * instance's, handled in the app).
   */
  async getTrialState(organizationId?: string, now: Date = new Date()): Promise<TrialState | null> {
    if (!this.deployment.isCloud() || !organizationId) return null;
    const current = await this.licenseService.getCurrentLicense(organizationId);
    if (current) {
      if (current.plan !== 'trial' || !current.expiresAt) return null;
      const endsAt = new Date(current.expiresAt);
      return {
        endsAt,
        active: current.status === 'active' && endsAt.getTime() > now.getTime(),
        cardTrialAvailable: cardTrialEnd(current, now) !== null,
      };
    }
    const last = await this.licenseService.getLatestInactiveLicense(organizationId);
    if (last?.plan !== 'trial' || !last.expiresAt) return null;
    return { endsAt: new Date(last.expiresAt), active: false, cardTrialAvailable: false };
  }
}
