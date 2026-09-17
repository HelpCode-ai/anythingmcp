import { Module } from '@nestjs/common';
import { SettingsModule } from '../../settings/settings.module';
import { LicenseModule } from '../../license/license.module';
import { OnboardingCronController } from './onboarding-cron.controller';
import { OnboardingCronService } from './onboarding-cron.service';
import { KgCronController } from './kg-cron.controller';
import { KgCronService } from './kg-cron.service';

/**
 * CloudModule — loaded only when DEPLOYMENT_MODE=cloud.
 *
 * Groups cloud-specific providers and controllers:
 * - Onboarding drip cron (sends nudge emails to users with 0 connectors)
 * - Knowledge-graph discovery cron + audit retention
 * - Trial repair (workspaces that ended up with no licence)
 * - Future: usage metering, multi-tenant routing, billing webhooks
 */
@Module({
  imports: [SettingsModule, LicenseModule],
  controllers: [OnboardingCronController, KgCronController],
  providers: [OnboardingCronService, KgCronService],
})
export class CloudModule {}
