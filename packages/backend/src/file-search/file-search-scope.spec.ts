import { FileSearchEngine } from './file-search.engine';

type Rule = { roleId: string; pattern: string; effect: 'allow' | 'deny' };

function engine(rules: Rule[] | Error, roles: string[], memberRole = 'EDITOR', folderRules = true) {
  const tenants: string[] = [];
  // The rules are only visible inside the workspace's tenant transaction.
  const tx: any = {
    fileAccessRule: {
      findMany: jest.fn(async () => {
        if (rules instanceof Error) throw rules;
        return rules;
      }),
    },
  };
  const repo: any = { withTenant: jest.fn(async (org: string, fn: any) => (tenants.push(org), fn(tx))), tenants };
  const prisma: any = {
    fileAccessRule: { findMany: jest.fn(async () => []) },
    userRoleAssignment: { findMany: jest.fn(async () => roles.map((roleId) => ({ roleId }))) },
    organizationMember: { findFirst: jest.fn(async () => ({ role: memberRole })) },
  };
  const access: any = { resolve: async () => ({ allowed: true, quota: { folderRules } }) };
  const e = new FileSearchEngine(prisma, {} as any, access, {} as any, {} as any, repo);
  return Object.assign(e as any, { fakeRepo: repo, fakePrisma: prisma, tx }) as { scopeFor: FileSearchEngine['scopeFor']; fakeRepo: any; fakePrisma: any; tx: any };
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

  it('reads the rules inside the tenant transaction of the workspace, not on the bare connection', async () => {
    const e = engine([{ roleId: 'sales', pattern: 'Intern', effect: 'deny' }], ['sales']);
    expect(await e.scopeFor(ctx)).toEqual({ ...base, deny: ['Intern'] });
    expect(e.fakeRepo.tenants).toEqual(['o']);
    expect(e.tx.fileAccessRule.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: 'o', connectorId: 'c' } }));
    expect(e.fakePrisma.fileAccessRule.findMany).not.toHaveBeenCalled();
  });

  it('fails closed: a failed rule read throws instead of returning a full scope', async () => {
    const e = engine(new Error('permission denied for table file_access_rules'), ['sales']);
    await expect(e.scopeFor(ctx)).rejects.toThrow(/permission denied/);
  });

  it('fails closed in execute: the tool returns an error and never queries the index', async () => {
    const query = { search: jest.fn(), list: jest.fn() };
    const repo: any = { withTenant: async () => { throw new Error('connection reset'); } };
    const access: any = { resolve: async () => ({ allowed: true, quota: { folderRules: true } }) };
    const e = new FileSearchEngine({} as any, query as any, access, {} as any, {} as any, repo);
    const out: any = await e.execute('file_search', { query: 'preise' }, ctx);
    expect(out).toMatchObject({ error: 'folder_rules_unavailable' });
    expect(query.search).not.toHaveBeenCalled();
  });
});
