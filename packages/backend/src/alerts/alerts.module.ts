import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { AlertsService } from './alerts.service';
import { AlertsAdminController } from './alerts.controller';

// RedisService and PrismaService come from the @Global() RedisModule and
// PrismaModule, so only SettingsModule (for OrgSettingsService) needs to be
// imported here. Keep this list short: AuditModule imports AlertsModule to
// inject AlertsService into AuditService, so anything this module pulled in
// that itself depended on AuditModule would be a cycle.
@Module({
  imports: [SettingsModule],
  controllers: [AlertsAdminController],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
