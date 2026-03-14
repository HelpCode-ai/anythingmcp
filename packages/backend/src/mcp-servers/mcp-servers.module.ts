import { Module } from '@nestjs/common';
import { McpServersService } from './mcp-servers.service';
import { McpServersController } from './mcp-servers.controller';
import { LicenseModule } from '../license/license.module';

@Module({
  imports: [LicenseModule],
  providers: [McpServersService],
  controllers: [McpServersController],
  exports: [McpServersService],
})
export class McpServersModule {}
