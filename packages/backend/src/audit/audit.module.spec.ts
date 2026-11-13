import { Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { AlertsModule } from '../alerts/alerts.module';
import { AlertsService } from '../alerts/alerts.service';
import { OrgSettingsService } from '../settings/org-settings.service';
import { SettingsModule } from '../settings/settings.module';
import { MemberVisibilityModule } from '../settings/member-visibility.module';
import { MemberVisibilityService } from '../settings/member-visibility.service';
import { AuditController } from './audit.controller';
import { AuditModule } from './audit.module';

@Module({ providers: [{ provide: OrgSettingsService, useValue: {} }], exports: [OrgSettingsService] })
class FakeSettingsModule {}

@Module({ providers: [{ provide: AlertsService, useValue: {} }], exports: [AlertsService] })
class FakeAlertsModule {}

describe('AuditModule wiring', () => {
  // SettingsModule is also loaded by the File Search worker without
  // RolesModule / AuditModule, so the service must come from its own module.
  it('gets MemberVisibilityService from MemberVisibilityModule, not SettingsModule', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AuditModule) ?? [];
    expect(imports).toContain(MemberVisibilityModule);
    expect(imports).not.toContain(SettingsModule);
  });

  it('injects the real MemberVisibilityService into AuditController', async () => {
    // Providers of other modules (Prisma, Redis, roles, ...) are mocked; the
    // member visibility service itself must resolve through the imports.
    const moduleRef = await Test.createTestingModule({ imports: [AuditModule] })
      .overrideModule(SettingsModule)
      .useModule(FakeSettingsModule)
      .overrideModule(AlertsModule)
      .useModule(FakeAlertsModule)
      .useMocker(() => new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : jest.fn()) }))
      .compile();
    const controller = moduleRef.get(AuditController);
    expect((controller as any).visibility).toBeInstanceOf(MemberVisibilityService);
    await moduleRef.close();
  });
});
