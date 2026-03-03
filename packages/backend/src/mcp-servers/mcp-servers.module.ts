import { Module } from '@nestjs/common';
import { McpServersService } from './mcp-servers.service';
import { McpServersController } from './mcp-servers.controller';

@Module({
  providers: [McpServersService],
  controllers: [McpServersController],
  exports: [McpServersService],
})
export class McpServersModule {}
