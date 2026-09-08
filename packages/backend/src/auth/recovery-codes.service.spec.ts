import { RecoveryCodesService, CODE_COUNT } from './recovery-codes.service';
import * as bcrypt from 'bcrypt';

// bcrypt at cost 12, ten codes per generation: a few of these tests do
// twenty hashes and genuinely need longer than the 5s default.
jest.setTimeout(60_000);

describe('RecoveryCodesService', () => {
  let prisma: any;
  let securityEvents: any;
  let service: RecoveryCodesService;
  let store: any[];

  beforeEach(() => {
    store = [];
    prisma = {
      recoveryCode: {
        deleteMany: jest.fn(async () => {
          store = [];
          return { count: 0 };
        }),
        createMany: jest.fn(async ({ data }: any) => {
          store.push(...data.map((d: any, i: number) => ({ id: `c${i}`, usedAt: null, createdAt: new Date(), ...d })));
          return { count: data.length };
        }),
        findMany: jest.fn(async ({ where }: any) =>
          store.filter((c) => (where.usedAt === null ? c.usedAt === null : true)),
        ),
        count: jest.fn(async () => store.filter((c) => c.usedAt === null).length),
        updateMany: jest.fn(async ({ where }: any) => {
          const row = store.find((c) => c.id === where.id && c.usedAt === null);
          if (!row) return { count: 0 };
          row.usedAt = new Date();
          return { count: 1 };
        }),
      },
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    securityEvents = { log: jest.fn() };
    service = new RecoveryCodesService(prisma, securityEvents);
  });

  it('issues a full set and stores only hashes', async () => {
    const codes = await service.generate('u1');
    expect(codes).toHaveLength(CODE_COUNT);
    expect(new Set(codes).size).toBe(CODE_COUNT);
    for (const c of codes) {
      expect(store.some((row) => row.codeHash === c)).toBe(false);
    }
    expect(await bcrypt.compare(codes[0].replace('-', ''), store[0].codeHash)).toBe(true);
  });

  // The alphabet omits I, L, O and U precisely because these get written on
  // paper and typed back while SSO is already broken.
  it('avoids characters that are misread off a printout', async () => {
    const codes = await service.generate('u1');
    expect(codes.join('')).not.toMatch(/[ILOU]/);
    for (const c of codes) expect(c).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
  });

  it('accepts a code regardless of case and dashes', async () => {
    const [code] = await service.generate('u1');
    const mangled = code.toLowerCase().replace('-', ' ');
    expect(await service.consume('u1', mangled)).toBe(true);
  });

  it('accepts each code exactly once', async () => {
    const [code] = await service.generate('u1');
    expect(await service.consume('u1', code)).toBe(true);
    expect(await service.consume('u1', code)).toBe(false);
  });

  it('rejects an unknown code without consuming anything', async () => {
    await service.generate('u1');
    expect(await service.consume('u1', 'ZZZZZ-ZZZZZ')).toBe(false);
    expect(store.every((c) => c.usedAt === null)).toBe(true);
  });

  // Two requests arriving with the same code must not both succeed. The
  // conditional update is what makes that impossible; a read-then-write would
  // let both pass.
  it('cannot be consumed twice concurrently', async () => {
    const [code] = await service.generate('u1');
    const results = await Promise.all([
      service.consume('u1', code),
      service.consume('u1', code),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('regenerating invalidates the previous set', async () => {
    const first = await service.generate('u1');
    await service.generate('u1');
    expect(await service.consume('u1', first[0])).toBe(false);
  });

  it('reports whether a way back in still exists', async () => {
    expect(await service.hasUnused('u1')).toBe(false);
    const codes = await service.generate('u1');
    expect(await service.hasUnused('u1')).toBe(true);
    for (const c of codes) await service.consume('u1', c);
    expect(await service.hasUnused('u1')).toBe(false);
  });

  it('audits generation and use', async () => {
    const [code] = await service.generate('u1');
    await service.consume('u1', code);
    const events = securityEvents.log.mock.calls.map((c: any[]) => c[0].event);
    expect(events).toContain('RECOVERY_CODES_GENERATED');
    expect(events).toContain('RECOVERY_CODE_USED');
  });

  it('never puts a usable code in the audit trail', async () => {
    const [code] = await service.generate('u1');
    await service.consume('u1', code);
    const serialised = JSON.stringify(securityEvents.log.mock.calls);
    expect(serialised).not.toContain(code);
    expect(serialised).not.toContain(code.replace('-', ''));
  });
});
