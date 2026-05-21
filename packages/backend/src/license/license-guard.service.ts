import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { LicenseService } from './license.service';
import { DeploymentService } from '../common/deployment.service';

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
      throw new ForbiddenException(
        'No active license. Please purchase a license at anythingmcp.com/pricing',
      );
    }

    if (license.status !== 'active') {
      throw new ForbiddenException(
        'Your license has expired. Please purchase a license at anythingmcp.com/pricing',
      );
    }

    if (license.plan === 'trial' && license.expiresAt) {
      if (new Date(license.expiresAt) < new Date()) {
        throw new ForbiddenException(
          'Your trial has expired. Please purchase a license at anythingmcp.com/pricing',
        );
      }
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
        `Trial limit reached (${maxConnectors} connectors). Upgrade at anythingmcp.com/pricing`,
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
        `Trial limit reached (${maxMcpServers} MCP servers). Upgrade at anythingmcp.com/pricing`,
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
      organizationId
        ? this.prisma.user.count({ where: { organizationId } })
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
}
