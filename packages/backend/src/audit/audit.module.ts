import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { SecurityEventService } from './security-event.service';
import { ProductEventService } from './product-event.service';
import { ProductEventController } from './product-event.controller';
import { SignupAttributionController } from './signup-attribution.controller';

@Global()
@Module({
  controllers: [AuditController, ProductEventController, SignupAttributionController],
  providers: [AuditService, SecurityEventService, ProductEventService],
  exports: [AuditService, SecurityEventService, ProductEventService],
})
export class AuditModule {}
