import { Module } from '@nestjs/common';
import { IdentityProvidersService } from './identity-providers.service';
import { IdentityProvidersController } from './identity-providers.controller';
import { SsoController } from './sso.controller';
import { SsoService } from './sso.service';
import { RoleSyncService } from './role-sync.service';
import { ScimController } from './scim/scim.controller';
import { ScimAuthGuard } from './scim/scim-auth.guard';
import { ScimUsersService } from './scim/scim-users.service';
import { UsersModule } from '../users/users.module';

// `DeploymentService` and `PrismaService` come from the @Global() PrismaModule,
// and `SecurityEventService` from the @Global() AuditModule — providing any of
// them here would shadow the shared instance for no reason.
@Module({
  // UsersModule exports UserLifecycleService, which SCIM `active: false` calls.
  imports: [UsersModule],
  controllers: [IdentityProvidersController, SsoController, ScimController],
  providers: [IdentityProvidersService, SsoService, RoleSyncService, ScimAuthGuard, ScimUsersService],
  exports: [IdentityProvidersService, SsoService, RoleSyncService],
})
export class IdentityProvidersModule {}
