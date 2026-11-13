import { Global, Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../common/prisma.service';
import { SecurityEventService } from '../audit/security-event.service';
import { RolesService } from '../roles/roles.service';
import { OrgSettingsService } from './org-settings.service';
import { SettingsModule } from './settings.module';
import { MemberVisibilityModule } from './member-visibility.module';
import { MemberVisibilityService } from './member-visibility.service';
import {
  MemberVisibilityAdminController,
  MemberVisibilityMemberController,
} from './member-visibility.controller';

@Global()
@Module({ providers: [{ provide: PrismaService, useValue: {} }], exports: [PrismaService] })
class FakePrismaModule {}

@Module({ providers: [{ provide: OrgSettingsService, useValue: {} }], exports: [OrgSettingsService] })
class FakeSettingsModule {}

/**
 * Shaped like AuditModule after the later PRs: @Global, provides
 * SecurityEventService and imports MemberVisibilityModule to inject the
 * service into its own controller.
 */
@Global()
@Module({
  imports: [MemberVisibilityModule],
  providers: [{ provide: SecurityEventService, useValue: {} }],
  exports: [SecurityEventService],
})
class FakeAuditLikeModule {}

@Global()
@Module({ providers: [{ provide: RolesService, useValue: {} }], exports: [RolesService] })
class FakeRolesModule {}

describe('MemberVisibilityModule wiring', () => {
  it('compiles with RolesService and SecurityEventService from global modules, imported by one of them', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakePrismaModule, FakeRolesModule, FakeAuditLikeModule, MemberVisibilityModule],
    })
      .overrideModule(SettingsModule)
      .useModule(FakeSettingsModule)
      .compile();
    expect(moduleRef.get(MemberVisibilityService)).toBeInstanceOf(MemberVisibilityService);
    expect(moduleRef.get(MemberVisibilityMemberController)).toBeInstanceOf(MemberVisibilityMemberController);
    expect(moduleRef.get(MemberVisibilityAdminController)).toBeInstanceOf(MemberVisibilityAdminController);
    await moduleRef.close();
  });

  it('exports the service for the audit, connectors, tools, servers and File Search modules', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, MemberVisibilityModule)).toContain(MemberVisibilityService);
  });

  // The File Search worker imports SettingsModule without RolesModule or
  // AuditModule. Anything that needs them must stay out of SettingsModule.
  it('stays out of SettingsModule', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SettingsModule) ?? [];
    const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, SettingsModule) ?? [];
    expect(providers).not.toContain(MemberVisibilityService);
    expect(controllers).not.toContain(MemberVisibilityMemberController);
    expect(controllers).not.toContain(MemberVisibilityAdminController);
  });
});
