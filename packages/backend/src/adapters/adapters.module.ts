import { Module } from '@nestjs/common';
import {
  AdaptersController,
  AdaptersPublicController,
} from './adapters.controller';
import { AdaptersService } from './adapters.service';
import { McpServerModule } from '../mcp-server/mcp-server.module';
import { LicenseModule } from '../license/license.module';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { ConnectorsModule } from '../connectors/connectors.module';

@Module({
  imports: [McpServerModule, LicenseModule, McpServersModule, ConnectorsModule],
  controllers: [AdaptersPublicController, AdaptersController],
  providers: [AdaptersService],
})
export class AdaptersModule {}
