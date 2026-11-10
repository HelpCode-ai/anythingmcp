import { Module } from '@nestjs/common';
import { LicenseModule } from '../license/license.module';
import { McpServerModule } from '../mcp-server/mcp-server.module';
import { SettingsModule } from '../settings/settings.module';
import { PlanCapsService } from './plan-caps.service';

/**
 * The automatic downgrade and its undo on Cloud (PlanCapsService). Kept out
 * of LicenseModule, which McpServerModule imports: it listens to plan changes
 * from LicenseService and reloads tools through McpServerService.
 */
@Module({
  imports: [LicenseModule, McpServerModule, SettingsModule],
  providers: [PlanCapsService],
  exports: [PlanCapsService],
})
export class PlanCapsModule {}
