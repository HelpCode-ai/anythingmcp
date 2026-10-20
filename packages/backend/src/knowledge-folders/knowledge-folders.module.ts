import { Global, Module } from '@nestjs/common';
import { KnowledgeFoldersController } from './knowledge-folders.controller';
import { KnowledgeFoldersService } from './knowledge-folders.service';

/**
 * The workspace's knowledge tree (folders shared by skills and the company
 * memory). Global: skills, memory and the MCP endpoint scope by it.
 */
@Global()
@Module({
  controllers: [KnowledgeFoldersController],
  providers: [KnowledgeFoldersService],
  exports: [KnowledgeFoldersService],
})
export class KnowledgeFoldersModule {}
