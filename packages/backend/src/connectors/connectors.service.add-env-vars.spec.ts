import { ConflictException, InternalServerErrorException } from '@nestjs/common';
import { ConnectorsService } from './connectors.service';
import { openEnvVarsStrict, sealEnvVars } from '../common/crypto/env-vars-at-rest';

/**
 * addEnvVars stores a secret that a tool already references as {{NAME}} and
 * that exists nowhere else, so it must never lose it to a concurrent save or
 * overwrite a variable that holds something else.
 */
describe('ConnectorsService.addEnvVars', () => {
  const KEY = 'k'.repeat(48);
  let stored: unknown;
  let interfere: (() => void) | null;
  const prisma = {
    $queryRaw: jest.fn(async () => [{ env_vars: stored }]),
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, next: string, _id: string, expected?: string) => {
      if (interfere) {
        interfere();
        interfere = null;
      }
      const matches =
        expected === undefined
          ? stored === null || stored === undefined
          : JSON.stringify(stored) === JSON.stringify(JSON.parse(expected));
      if (!matches) return 0;
      stored = JSON.parse(next);
      return 1;
    }),
  };
  const service = new ConnectorsService(prisma as any, { get: () => KEY } as any, {} as any, {} as any, {} as any, {} as any, {} as any);

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = KEY;
    stored = null;
    interfere = null;
    jest.clearAllMocks();
  });

  it('adds to what is stored, encrypted', async () => {
    stored = sealEnvVars({ A: 'one' });
    await service.addEnvVars('c1', { B: 'two' });
    expect(Object.keys(stored as object)).toEqual(['$enc']);
    expect(openEnvVarsStrict(stored)).toEqual({ A: 'one', B: 'two' });
  });

  it('keeps a variable written by a concurrent save', async () => {
    stored = sealEnvVars({ A: 'one' });
    interfere = () => {
      stored = sealEnvVars({ A: 'one', C: 'three' });
    };
    await service.addEnvVars('c1', { B: 'two' });
    expect(openEnvVarsStrict(stored)).toEqual({ A: 'one', B: 'two', C: 'three' });
  });

  it('never overwrites a variable holding another value', async () => {
    stored = sealEnvVars({ B: 'other' });
    await expect(service.addEnvVars('c1', { B: 'two' })).rejects.toBeInstanceOf(ConflictException);
    expect(openEnvVarsStrict(stored)).toEqual({ B: 'other' });
  });

  it('refuses when the stored variables cannot be decrypted', async () => {
    stored = { $enc: 'not-a-ciphertext' };
    await expect(service.addEnvVars('c1', { B: 'two' })).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});
