import { FileSearchEngine } from './file-search.engine';

type Rule = { roleId: string; pattern: string; effect: 'allow' | 'deny' };

function engine(rules: Rule[], roles: string[], memberRole = 'EDITOR', folderRules = true) {
  const prisma: any = {
    fileAccessRule: { findMany: jest.fn(async () => rules) },
    userRoleAssignment: { findMany: jest.fn(async () => roles.map((roleId) => ({ roleId }))) },
    organizationMember: { findFirst: jest.fn(async () => ({ role: memberRole })) },
  };
  const access: any = { resolve: async () => ({ allowed: true, quota: { folderRules } }) };
  return new FileSearchEngine(prisma, {} as any, access, {} as any, {} as any);
}
const ctx = { organizationId: 'o', connectorId: 'c', userId: 'u' } as any;
const base = { organizationId: 'o', connectorId: 'c' };

describe('FileSearchEngine.scopeFor (folder rules)', () => {
  it('a rule for another role changes nothing for the caller', async () => {
    const s = await engine([{ roleId: 'sales', pattern: 'Intern', effect: 'deny' }], ['support']).scopeFor(ctx);
    expect(s).toEqual(base);
  });

  it('deny-only rules hide those folders and keep the rest', async () => {
    const s = await engine([{ roleId: 'sales', pattern: 'Intern', effect: 'deny' }], ['sales']).scopeFor(ctx);
    expect(s).toEqual({ ...base, deny: ['Intern'] });
  });

  it('allow rules narrow the role, deny still wins', async () => {
    const s = await engine(
      [
        { roleId: 'sales', pattern: 'Preise', effect: 'allow' },
        { roleId: 'sales', pattern: 'Preise/Alt', effect: 'deny' },
      ],
      ['sales'],
    ).scopeFor(ctx);
    expect(s).toEqual({ ...base, allow: ['Preise'], deny: ['Preise/Alt'] });
  });

  it('a second role without allow rules keeps the caller unrestricted, deny still applies', async () => {
    const s = await engine(
      [
        { roleId: 'sales', pattern: 'Preise', effect: 'allow' },
        { roleId: 'sales', pattern: 'Intern', effect: 'deny' },
      ],
      ['sales', 'support'],
    ).scopeFor(ctx);
    expect(s).toEqual({ ...base, deny: ['Intern'] });
  });

  it('administrators, calls without a user and plans without folder rules are not narrowed', async () => {
    const rules: Rule[] = [{ roleId: 'sales', pattern: 'Preise', effect: 'allow' }];
    expect(await engine(rules, ['sales'], 'ADMIN').scopeFor(ctx)).toEqual(base);
    expect(await engine(rules, ['sales']).scopeFor({ ...ctx, userId: undefined })).toEqual(base);
    expect(await engine(rules, ['sales'], 'EDITOR', false).scopeFor(ctx)).toEqual(base);
  });
});
