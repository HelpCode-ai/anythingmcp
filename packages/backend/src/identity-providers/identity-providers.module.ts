import { Module } from '@nestjs/common';
import { IdentityProvidersService } from './identity-providers.service';
import { IdentityProvidersController } from './identity-providers.controller';
import { SsoController } from './sso.controller';
import { SsoService } from './sso.service';
import { RoleSyncService } from './role-sync.service';

// `DeploymentService` and `PrismaService` come from the @Global() PrismaModule,
// and `SecurityEventService` from the @Global() AuditModule — providing any of
// them here would shadow the shared instance for no reason.
@Module({
  controllers: [IdentityProvidersController, SsoController],
  providers: [IdentityProvidersService, SsoService, RoleSyncService],
  exports: [IdentityProvidersService, SsoService, RoleSyncService],
})
export class IdentityProvidersModule {}
