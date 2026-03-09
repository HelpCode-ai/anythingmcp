import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [TerminusModule, UsersModule],
  controllers: [HealthController],
})
export class HealthModule {}
