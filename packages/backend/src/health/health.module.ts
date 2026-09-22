import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { UsersModule } from '../users/users.module';
import { ProcessVitalsService } from '../common/process-vitals.service';

@Module({
  imports: [TerminusModule, UsersModule],
  controllers: [HealthController],
  providers: [ProcessVitalsService],
})
export class HealthModule {}
