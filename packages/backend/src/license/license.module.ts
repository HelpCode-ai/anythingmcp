import { Module } from '@nestjs/common';
import { LicenseService } from './license.service';
import { LicenseGuardService } from './license-guard.service';
import { LicenseController } from './license.controller';
import { CardTrialEligibilityService } from './card-trial-eligibility.service';
import { CardTrialOfferService } from './card-trial-offer.service';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [SettingsModule, UsersModule],
  controllers: [LicenseController],
  providers: [LicenseService, LicenseGuardService, CardTrialEligibilityService, CardTrialOfferService],
  exports: [LicenseService, LicenseGuardService, CardTrialEligibilityService, CardTrialOfferService],
})
export class LicenseModule {}
