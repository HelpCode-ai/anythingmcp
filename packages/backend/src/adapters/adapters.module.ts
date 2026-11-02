import { Module } from '@nestjs/common';
import {
  AdaptersController,
  AdaptersPublicController,
} from './adapters.controller';
import { AdaptersService } from './adapters.service';
import { ConnectorSetupService } from './connector-setup.service';
import { AppApprovalWatcherService } from './app-approval-watcher.service';
import { SetupLinksController } from './setup-links.controller';
import { McpServerModule } from '../mcp-server/mcp-server.module';
import { LicenseModule } from '../license/license.module';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { SettingsModule } from '../settings/settings.module';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
  imports: [McpServerModule, LicenseModule, McpServersModule, ConnectorsModule, SettingsModule, OrganizationsModule],
  controllers: [AdaptersPublicController, AdaptersController, SetupLinksController],
  providers: [AdaptersService, ConnectorSetupService, AppApprovalWatcherService],
})
export class AdaptersModule {}
