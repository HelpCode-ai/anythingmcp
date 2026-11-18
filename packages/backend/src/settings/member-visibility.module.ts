import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { SettingsModule } from './settings.module';
import { MemberVisibilityService } from './member-visibility.service';
import { MemberVisibilityInterceptor } from './member-visibility.interceptor';
import {
  MemberVisibilityAdminController,
  MemberVisibilityMemberController,
} from './member-visibility.controller';

/**
 * Member visibility (open / restricted) and its two settings routes.
 *
 * Kept apart from SettingsModule on purpose: the File Search worker imports
 * SettingsModule without RolesModule or AuditModule, and this module needs
 * RolesService and SecurityEventService. Both come from @Global modules of the
 * API app, so nothing is imported for them here, and a module that imports
 * this one (audit, connectors, tools, MCP servers, File Search) creates no
 * import cycle.
 *
 * Also registers MemberVisibilityInterceptor app-wide: it refuses the
 * `admin-when-restricted` routes of member-visibility.routes.ts to restricted
 * members and passes every other request through.
 */
@Module({
  imports: [SettingsModule],
  controllers: [MemberVisibilityMemberController, MemberVisibilityAdminController],
  providers: [MemberVisibilityService, { provide: APP_INTERCEPTOR, useClass: MemberVisibilityInterceptor }],
  exports: [MemberVisibilityService],
})
export class MemberVisibilityModule {}
