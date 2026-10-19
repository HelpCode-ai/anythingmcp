import { Module } from '@nestjs/common';
import { LicenseModule } from '../../license/license.module';
import { SupportController } from './support.controller';
import { SupportIdentityService } from './support-identity.service';
import { SupportTriageService } from './support-triage.service';

/**
 * SupportModule: the live support chat of the instances we operate (Cloud
 * and the dedicated instances of enterprise customers), backed by our
 * Libredesk desk. Loaded only when SUPPORT_CHAT_* or LIBREDESK_* are set,
 * see support-config.ts; self-hosted installations never load it.
 */
@Module({
  imports: [LicenseModule],
  controllers: [SupportController],
  providers: [SupportIdentityService, SupportTriageService],
})
export class SupportModule {}
