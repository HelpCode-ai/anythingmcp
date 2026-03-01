import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
import { ClaudeProvider } from './providers/claude.provider';
import { OpenaiProvider } from './providers/openai.provider';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  controllers: [AiController],
  providers: [AiService, ClaudeProvider, OpenaiProvider],
  exports: [AiService],
})
export class AiModule {}
