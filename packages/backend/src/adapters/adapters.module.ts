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
import { TelegramManagedBotController } from './telegram-managed-bot.controller';
import { TelegramManagedBotService } from './telegram-managed-bot.service';
import { TELEGRAM_ONE_TAP } from './telegram-managed-bot';
import { McpServerModule } from '../mcp-server/mcp-server.module';
import { LicenseModule } from '../license/license.module';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [McpServerModule, LicenseModule, McpServersModule, ConnectorsModule, SettingsModule],
  controllers: [
    AdaptersPublicController,
    AdaptersController,
    SetupLinksController,
    TikTokShopInstallController,
    TelegramManagedBotController,
  ],
  providers: [
    AdaptersService,
    ConnectorSetupService,
    AppApprovalWatcherService,
    TelegramManagedBotService,
    // The page after approving an AI client (auth/login.controller.ts) finds it by this token.
    { provide: TELEGRAM_ONE_TAP, useExisting: TelegramManagedBotService },
  ],
  exports: [AdaptersService, ConnectorSetupService],
})
export class AdaptersModule {}
