import { Module } from '@nestjs/common';
import { IdentityProvidersService } from './identity-providers.service';
import { IdentityProvidersController } from './identity-providers.controller';

// `DeploymentService` and `PrismaService` come from the @Global() PrismaModule,
// and `SecurityEventService` from the @Global() AuditModule — providing any of
// them here would shadow the shared instance for no reason.
@Module({
  controllers: [IdentityProvidersController],
  providers: [IdentityProvidersService],
  exports: [IdentityProvidersService],
})
export class IdentityProvidersModule {}
