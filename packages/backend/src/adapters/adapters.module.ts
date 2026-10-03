import { Module } from '@nestjs/common';
import {
  AdaptersController,
  AdaptersPublicController,
} from './adapters.controller';
import { AdaptersService } from './adapters.service';
import { ConnectorSetupService } from './connector-setup.service';
import { SetupLinksController } from './setup-links.controller';
import { McpServerModule } from '../mcp-server/mcp-server.module';
import { LicenseModule } from '../license/license.module';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { ConnectorsModule } from '../connectors/connectors.module';

@Module({
  imports: [McpServerModule, LicenseModule, McpServersModule, ConnectorsModule],
  controllers: [AdaptersPublicController, AdaptersController, SetupLinksController],
  providers: [AdaptersService, ConnectorSetupService],
})
export class AdaptersModule {}
