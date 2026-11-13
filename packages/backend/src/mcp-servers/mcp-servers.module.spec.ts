import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { AuditModule } from '../audit/audit.module';
import { ProductEventService } from '../audit/product-event.service';
import { SecurityEventService } from '../audit/security-event.service';
import { PrismaService } from '../common/prisma.service';
import { KgSkillService } from '../knowledge-graph/kg-skill.service';
import { LicenseGuardService } from '../license/license-guard.service';
import { LicenseModule } from '../license/license.module';
import { RolesService } from '../roles/roles.service';
import { MemberVisibilityModule } from '../settings/member-visibility.module';
import { MemberVisibilityService } from '../settings/member-visibility.service';
import { OrgSettingsService } from '../settings/org-settings.service';
import { SettingsModule } from '../settings/settings.module';
import { McpConnectionGrantService } from './mcp-connection-grant.service';
import { McpServersController } from './mcp-servers.controller';
import { McpServersModule } from './mcp-servers.module';

/**
 * The servers controller and the grant service take MemberVisibilityService
 * without @Optional, so a module that cannot provide it fails to boot rather
 * than silently serving every member the unrestricted view. This checks the
 * module provides it, through MemberVisibilityModule and not SettingsModule.
 */

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: RolesService, useValue: {} },
    { provide: KgSkillService, useValue: {} },
    { provide: SecurityEventService, useValue: {} },
    { provide: ProductEventService, useValue: {} },
  ],
  exports: [PrismaService, RolesService, KgSkillService, SecurityEventService, ProductEventService],
})
class FakeApiGlobals {}

@Module({ providers: [{ provide: LicenseGuardService, useValue: {} }], exports: [LicenseGuardService] })
class FakeLicenseModule {}

@Module({})
class FakeAuditModule {}

@Module({ providers: [{ provide: OrgSettingsService, useValue: {} }], exports: [OrgSettingsService] })
class FakeSettingsModule {}

describe('McpServersModule member visibility wiring', () => {
  it('imports MemberVisibilityModule', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, McpServersModule)).toContain(MemberVisibilityModule);
  });

  it('injects MemberVisibilityService into the servers controller and the grant service', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [FakeApiGlobals, McpServersModule] })
      .overrideModule(LicenseModule)
      .useModule(FakeLicenseModule)
      .overrideModule(AuditModule)
      .useModule(FakeAuditModule)
      .overrideModule(SettingsModule)
      .useModule(FakeSettingsModule)
      .compile();
    const visibility = moduleRef.get(MemberVisibilityService);
    expect(visibility).toBeInstanceOf(MemberVisibilityService);
    expect((moduleRef.get(McpServersController) as any).visibility).toBe(visibility);
    expect((moduleRef.get(McpConnectionGrantService) as any).visibility).toBe(visibility);
    await moduleRef.close();
  });
});
