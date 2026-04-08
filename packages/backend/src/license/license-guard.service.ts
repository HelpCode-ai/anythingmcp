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

  async checkCanCreateConnector(userId: string, organizationId?: string): Promise<void> {
    if (!this.deployment.isCloud()) return;

    await this.checkLicenseActive(organizationId);

    const license = await this.licenseService.getCurrentLicense(organizationId);
    const maxConnectors = (license?.features as any)?.maxConnectors;
    if (maxConnectors != null) {
      const count = await this.prisma.connector.count({
        where: organizationId ? { organizationId } : { userId },
      });
      if (count >= maxConnectors) {
        throw new ForbiddenException(
          `You have reached the maximum of ${maxConnectors} connectors on your current plan. Upgrade at anythingmcp.com/pricing`,
        );
      }
    }
  }

  async checkCanCreateMcpServer(userId: string, organizationId?: string): Promise<void> {
    if (!this.deployment.isCloud()) return;

    await this.checkLicenseActive(organizationId);

    const license = await this.licenseService.getCurrentLicense(organizationId);
    const maxMcpServers = (license?.features as any)?.maxMcpServers;
    if (maxMcpServers != null) {
      const count = await this.prisma.mcpServerConfig.count({
        where: organizationId ? { organizationId } : { userId },
      });
      if (count >= maxMcpServers) {
        throw new ForbiddenException(
          `You have reached the maximum of ${maxMcpServers} MCP servers on your current plan. Upgrade at anythingmcp.com/pricing`,
        );
      }
    }
  }
}
