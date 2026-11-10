import { Module } from '@nestjs/common';
import { LicenseModule } from '../../license/license.module';
import { AdaptersModule } from '../../adapters/adapters.module';
import { McpServersModule } from '../../mcp-servers/mcp-servers.module';
import { SettingsModule } from '../../settings/settings.module';
import { ConnectorsModule } from '../../connectors/connectors.module';
import { McpServerModule } from '../../mcp-server/mcp-server.module';
import { SupportTelegramSetupService } from './support-telegram-setup.service';
import { SupportConnectorSetupService } from './support-connector-setup.service';
import { SupportHandoffNoticeService } from './support-handoff-notice.service';
import { SupportController } from './support.controller';
import { SupportIdentityService } from './support-identity.service';
import { SupportTriageService } from './support-triage.service';

/**
 * SupportModule: the live support chat of the instances we operate (Cloud
 * and the dedicated instances of enterprise customers), backed by our
 * Libredesk desk. Loaded only when SUPPORT_CHAT_* or LIBREDESK_* are set,
 * see support-config.ts; self-hosted installations never load it.
 */
@Module({
  imports: [LicenseModule, AdaptersModule, McpServersModule, SettingsModule, ConnectorsModule, McpServerModule],
  controllers: [SupportController],
  providers: [
    SupportIdentityService,
    SupportTriageService,
    SupportTelegramSetupService,
    SupportConnectorSetupService,
    SupportHandoffNoticeService,
  ],
})
export class SupportModule {}
