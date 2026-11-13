import 'reflect-metadata';

// ConnectorsModule reaches the SSO service, whose ESM-only client Jest cannot load.
jest.mock('openid-client', () => ({}));
import { Global, Module, type DynamicModule, type Type } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../common/prisma.service';
import { SecurityEventService } from '../audit/security-event.service';
import { RolesService } from '../roles/roles.service';
import { ConnectorsController } from '../connectors/connectors.controller';
import { ConnectorsModule } from '../connectors/connectors.module';
import { ToolsController } from '../connectors/tools.controller';
import { FilesWorkerModule } from '../ee/file-search/files-worker.module';
import { MemberVisibilityModule } from '../settings/member-visibility.module';
import { MemberVisibilityService } from '../settings/member-visibility.service';
import { OrgSettingsService } from '../settings/org-settings.service';
import { SettingsModule } from '../settings/settings.module';
import { FileSearchController } from './file-search.controller';
import { FileSearchModule } from './file-search.module';

/**
 * Member visibility wiring of the connectors, tools and File Search routes,
 * and the File Search worker that must keep booting without it.
 *
 * MemberVisibilityService needs RolesService, which only the API app provides
 * (global RolesModule). files-worker loads SettingsModule and
 * FileSearchCoreModule, never FileSearchModule or ConnectorsModule, so it must
 * not reach MemberVisibilityModule through any import.
 */

type ModuleRef = Type<unknown> | DynamicModule | Promise<DynamicModule> | undefined;

/** Every module class reachable from `root` through `imports`. */
function importGraph(root: Type<unknown>): Set<unknown> {
  const seen = new Set<unknown>();
  const visit = (ref: ModuleRef) => {
    if (!ref || ref instanceof Promise) return;
    const dynamic = (ref as DynamicModule).module ? (ref as DynamicModule) : undefined;
    const cls = dynamic ? dynamic.module : (ref as Type<unknown>);
    if (seen.has(cls)) return;
    seen.add(cls);
    const imports: ModuleRef[] = [
      ...((Reflect.getMetadata(MODULE_METADATA.IMPORTS, cls) as ModuleRef[] | undefined) ?? []),
      ...((dynamic?.imports as ModuleRef[] | undefined) ?? []),
    ];
    for (const i of imports) visit(typeof i === 'function' && !(i as any).prototype ? (i as any)() : i);
  };
  visit(root);
  return seen;
}

@Global()
@Module({ providers: [{ provide: PrismaService, useValue: {} }], exports: [PrismaService] })
class FakePrismaModule {}

@Global()
@Module({
  providers: [
    { provide: RolesService, useValue: {} },
    { provide: SecurityEventService, useValue: {} },
  ],
  exports: [RolesService, SecurityEventService],
})
class FakeApiGlobalsModule {}

@Module({ providers: [{ provide: OrgSettingsService, useValue: {} }], exports: [OrgSettingsService] })
class FakeSettingsModule {}

describe('member visibility wiring of connectors, tools and File Search', () => {
  it('ConnectorsModule and FileSearchModule import MemberVisibilityModule', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, ConnectorsModule)).toContain(MemberVisibilityModule);
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, FileSearchModule)).toContain(MemberVisibilityModule);
  });

  it('the three controllers get the real MemberVisibilityService from MemberVisibilityModule', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakePrismaModule, FakeApiGlobalsModule, MemberVisibilityModule],
      controllers: [ConnectorsController, ToolsController, FileSearchController],
    })
      .overrideModule(SettingsModule)
      .useModule(FakeSettingsModule)
      // Every other dependency of the controllers is a mock: only the
      // visibility service has to resolve through the module import.
      .useMocker((token) =>
        token === MemberVisibilityService
          ? undefined
          : new Proxy({ get: () => 'k'.repeat(48) }, { get: (t: any, p) => (p in t ? t[p] : p === 'then' ? undefined : jest.fn()) }),
      )
      .compile();
    for (const controller of [ConnectorsController, ToolsController, FileSearchController]) {
      expect((moduleRef.get(controller as Type<unknown>) as any).visibility).toBeInstanceOf(MemberVisibilityService);
    }
    await moduleRef.close();
  });

  it('files-worker never reaches MemberVisibilityModule, FileSearchModule or ConnectorsModule', () => {
    const graph = importGraph(FilesWorkerModule);
    expect(graph.has(SettingsModule)).toBe(true); // sanity: the walk follows imports
    expect(graph.has(MemberVisibilityModule)).toBe(false);
    expect(graph.has(FileSearchModule)).toBe(false);
    expect(graph.has(ConnectorsModule)).toBe(false);
  });

  it('files-worker compiles without RolesModule or AuditModule', async () => {
    // compile() builds every provider of the worker's graph (no lifecycle
    // hooks run), so a provider needing RolesService would fail here.
    const moduleRef = await Test.createTestingModule({ imports: [FilesWorkerModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    expect(() => moduleRef.get(RolesService, { strict: false })).toThrow();
    expect(() => moduleRef.get(MemberVisibilityService, { strict: false })).toThrow();
    await moduleRef.close();
  });
});
