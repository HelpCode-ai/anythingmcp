import { Global, Module } from '@nestjs/common';
import { LicenseModule } from '../../license/license.module';
import { SettingsModule } from '../../settings/settings.module';
import { EditionService } from './edition.service';
import { EditionController } from './edition.controller';
import { BusinessEditionGuard } from './business-edition.guard';

// Global: the user, SSO and SCIM modules consult the edition, and LicenseModule
// already imports UsersModule, so an explicit import there would be circular.
@Global()
@Module({
  imports: [LicenseModule, SettingsModule],
  controllers: [EditionController],
  providers: [EditionService, BusinessEditionGuard],
  exports: [EditionService, BusinessEditionGuard],
})
export class LicensingModule {}
