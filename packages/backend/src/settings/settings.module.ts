import { Module } from '@nestjs/common';
import { SiteSettingsService } from './site-settings.service';
import { OrgSettingsService } from './org-settings.service';
import { EmailService } from './email.service';
import { SiteSettingsPublicController, SiteSettingsAdminController } from './site-settings.controller';

@Module({
  controllers: [SiteSettingsPublicController, SiteSettingsAdminController],
  providers: [SiteSettingsService, OrgSettingsService, EmailService],
  exports: [SiteSettingsService, OrgSettingsService, EmailService],
})
export class SettingsModule {}
