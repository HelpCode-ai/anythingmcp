import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { LicenseService } from './license.service';
import { DeploymentService } from '../common/deployment.service';

@Injectable()
export class LicenseGuardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly licenseService: LicenseService,
    private readonly deployment: DeploymentService,
  ) {}

  /**
   * Check if the license is active. Only enforced in cloud mode.
   */
  async checkLicenseActive(): Promise<void> {
    if (!this.deployment.isCloud()) return;

    const license = await this.licenseService.getCurrentLicense();
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

    // Check if trial has expired by date
    if (license.plan === 'trial' && license.expiresAt) {
      if (new Date(license.expiresAt) < new Date()) {
        throw new ForbiddenException(
          'Your trial has expired. Please purchase a license at anythingmcp.com/pricing',
        );
      }
    }
  }

  /**
   * Check if the user can create a new connector. Only enforced in cloud mode.
   */
  async checkCanCreateConnector(userId: string): Promise<void> {
    if (!this.deployment.isCloud()) return;

    await this.checkLicenseActive();

    const license = await this.licenseService.getCurrentLicense();
    const maxConnectors = (license?.features as any)?.maxConnectors;
    if (maxConnectors != null) {
      const count = await this.prisma.connector.count({ where: { userId } });
      if (count >= maxConnectors) {
        throw new ForbiddenException(
          `You have reached the maximum of ${maxConnectors} connectors on your current plan. Upgrade at anythingmcp.com/pricing`,
        );
      }
    }
  }

  /**
   * Check if the user can create a new MCP server. Only enforced in cloud mode.
   */
  async checkCanCreateMcpServer(userId: string): Promise<void> {
    if (!this.deployment.isCloud()) return;

    await this.checkLicenseActive();

    const license = await this.licenseService.getCurrentLicense();
    const maxMcpServers = (license?.features as any)?.maxMcpServers;
    if (maxMcpServers != null) {
      const count = await this.prisma.mcpServerConfig.count({ where: { userId } });
      if (count >= maxMcpServers) {
        throw new ForbiddenException(
          `You have reached the maximum of ${maxMcpServers} MCP servers on your current plan. Upgrade at anythingmcp.com/pricing`,
        );
      }
    }
  }
}
