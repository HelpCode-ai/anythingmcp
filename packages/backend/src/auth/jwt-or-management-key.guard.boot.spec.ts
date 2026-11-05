import { Controller, Get, Global, Module, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../common/prisma.service';
import { JwtOrManagementKeyGuard } from './jwt-or-management-key.guard';

/**
 * The guard sits on controllers of modules that processes without RedisModule
 * load too (the File Search worker imports SettingsModule). Nest builds a
 * controller's guards while it compiles the module, so a required RedisService
 * stopped such a process at boot (2026-11-04, files-worker crash loop).
 */
@Controller('boot-test')
@UseGuards(JwtOrManagementKeyGuard)
class GuardedController {
  @Get()
  ping() {
    return 'ok';
  }
}

@Global()
@Module({ providers: [{ provide: PrismaService, useValue: {} }], exports: [PrismaService] })
class FakePrismaModule {}

describe('JwtOrManagementKeyGuard module wiring', () => {
  it('compiles in a module graph without RedisModule', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakePrismaModule],
      controllers: [GuardedController],
    }).compile();
    expect(moduleRef.get(GuardedController)).toBeInstanceOf(GuardedController);
    await moduleRef.close();
  });
});
