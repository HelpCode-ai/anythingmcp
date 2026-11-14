import { Module } from '@nestjs/common';
import {
  AdaptersController,
  AdaptersPublicController,
} from './adapters.controller';
import { AdaptersService } from './adapters.service';
import { ConnectorSetupService } from './connector-setup.service';
import { AppApprovalWatcherService } from './app-approval-watcher.service';
import { SetupLinksController } from './setup-links.controller';
import { TikTokShopInstallController } from './tiktok-shop-install.controller';
import { McpServerModule } from '../mcp-server/mcp-server.module';
import { LicenseModule } from '../license/license.module';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [McpServerModule, LicenseModule, McpServersModule, ConnectorsModule, SettingsModule],
  controllers: [AdaptersPublicController, AdaptersController, SetupLinksController, TikTokShopInstallController],
  providers: [AdaptersService, ConnectorSetupService, AppApprovalWatcherService],
  exports: [AdaptersService, ConnectorSetupService],
})
export class AdaptersModule {}
