import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { LicenseReleaseService } from './license-release.service';

/**
 * Kept apart from LicenseModule, which imports UsersModule: the deletion paths
 * in UsersModule and OrganizationsModule need this service without a cycle.
 */
@Module({
  imports: [SettingsModule],
  providers: [LicenseReleaseService],
  exports: [LicenseReleaseService],
})
export class LicenseReleaseModule {}
