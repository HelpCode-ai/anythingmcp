import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AdsActivationService } from './ads-activation.service';
import { AuditController } from './audit.controller';
import { SecurityEventService } from './security-event.service';
import { ProductEventService } from './product-event.service';
import { ProductEventController } from './product-event.controller';
import { SignupAttributionController } from './signup-attribution.controller';
import { AlertsModule } from '../alerts/alerts.module';

@Global()
@Module({
  imports: [AlertsModule],
  controllers: [AuditController, ProductEventController, SignupAttributionController],
  providers: [AuditService, SecurityEventService, ProductEventService, AdsActivationService],
  exports: [AuditService, SecurityEventService, ProductEventService],
})
export class AuditModule {}
