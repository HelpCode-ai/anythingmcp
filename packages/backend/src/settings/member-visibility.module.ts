import { Module } from '@nestjs/common';
import { SettingsModule } from './settings.module';
import { MemberVisibilityService } from './member-visibility.service';
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
 */
@Module({
  imports: [SettingsModule],
  controllers: [MemberVisibilityMemberController, MemberVisibilityAdminController],
  providers: [MemberVisibilityService],
  exports: [MemberVisibilityService],
})
export class MemberVisibilityModule {}
