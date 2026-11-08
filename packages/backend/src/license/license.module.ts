import { Module } from '@nestjs/common';
import { LicenseService } from './license.service';
import { LicenseGuardService } from './license-guard.service';
import { LicenseController } from './license.controller';
import { CardTrialEligibilityService } from './card-trial-eligibility.service';
import { CardTrialOfferService } from './card-trial-offer.service';
import { LicenseWallService } from './license-wall.service';
import { RetentionLicenceClient } from './retention-licence.client';
import { TrialExtensionController } from './trial-extension.controller';
import { ReactivationController } from './reactivation.controller';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [SettingsModule, UsersModule],
  controllers: [LicenseController, TrialExtensionController, ReactivationController],
  providers: [
    LicenseService,
    LicenseGuardService,
    CardTrialEligibilityService,
    CardTrialOfferService,
    LicenseWallService,
    RetentionLicenceClient,
  ],
  exports: [
    LicenseService,
    LicenseGuardService,
    CardTrialEligibilityService,
    CardTrialOfferService,
    RetentionLicenceClient,
  ],
})
export class LicenseModule {}
