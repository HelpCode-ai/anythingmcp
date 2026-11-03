import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { LicenseService } from './license.service';
import { DeploymentService } from '../common/deployment.service';
import { cardTrialEnd } from './license-checkout';

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
      where: organizationId ? { organizationId } : { userId },
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
      where: organizationId ? { organizationId } : { userId },
    });
    if (count >= maxMcpServers) {
      throw new ForbiddenException(
        `Trial limit reached (${maxMcpServers} MCP servers). A workspace administrator can activate a license to add more.`,
      );
    }
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
      where ? this.prisma.connector.count({ where }) : Promise.resolve(0),
      where ? this.prisma.mcpServerConfig.count({ where }) : Promise.resolve(0),
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
