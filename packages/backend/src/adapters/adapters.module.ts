import { Module } from '@nestjs/common';
import { AdaptersController } from './adapters.controller';
import { AdaptersService } from './adapters.service';
import { McpServerModule } from '../mcp-server/mcp-server.module';
import { LicenseModule } from '../license/license.module';

@Module({
  imports: [McpServerModule, LicenseModule],
  controllers: [AdaptersController],
  providers: [AdaptersService],
})
export class AdaptersModule {}
