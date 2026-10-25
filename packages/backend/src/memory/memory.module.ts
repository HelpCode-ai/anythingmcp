import { Global, Module } from '@nestjs/common';
import { MemoryController } from './memory.controller';
import { MemoryService } from './memory.service';

/**
 * Workspace memory (Enterprise). PrismaService, SecurityEventService and
 * EditionService come from @Global modules. Global so the MCP endpoint can
 * offer the memory tools.
 */
@Global()
@Module({
  controllers: [MemoryController],
  providers: [MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}
