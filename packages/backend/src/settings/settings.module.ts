import { Module } from '@nestjs/common';
import { SiteSettingsService } from './site-settings.service';
import { OrgSettingsService } from './org-settings.service';
import { EmailService } from './email.service';
import { SiteSettingsPublicController, SiteSettingsAdminController } from './site-settings.controller';
import { SsrfPolicyService } from '../common/ssrf-policy.service';

@Module({
  controllers: [SiteSettingsPublicController, SiteSettingsAdminController],
  providers: [SiteSettingsService, OrgSettingsService, EmailService, SsrfPolicyService],
  exports: [SiteSettingsService, OrgSettingsService, EmailService, SsrfPolicyService],
})
export class SettingsModule {}
