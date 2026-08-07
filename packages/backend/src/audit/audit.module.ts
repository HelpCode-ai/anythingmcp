import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { SecurityEventService } from './security-event.service';

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, SecurityEventService],
  exports: [AuditService, SecurityEventService],
})
export class AuditModule {}
