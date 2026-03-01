import { Module } from '@nestjs/common';
import { SiteSettingsService } from './site-settings.service';
import { EmailService } from './email.service';
import { SiteSettingsPublicController, SiteSettingsAdminController } from './site-settings.controller';

@Module({
  controllers: [SiteSettingsPublicController, SiteSettingsAdminController],
  providers: [SiteSettingsService, EmailService],
  exports: [SiteSettingsService, EmailService],
})
export class SettingsModule {}
