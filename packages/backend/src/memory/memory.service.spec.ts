import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { MemoryService, allows, looksLikeSecret, type MemoryCaller } from './memory.service';

const ORG = 'org-A';

function make(opts: {
  licensed?: boolean;
  member?: { memoryAccess: string; deactivatedAt: Date | null } | null;
  settings?: Record<string, string>;
  counts?: number[];
  item?: any;
} = {}) {
  const settings = opts.settings ?? {};
  const prisma: any = {
    orgSettings: {
      findMany: jest.fn(async () => Object.entries(settings).map(([key, value]) => ({ key, value }))),
      upsert: jest.fn(),
    },
    organizationMember: {
      findUnique: jest.fn(async () => (opts.member === undefined ? { memoryAccess: 'inherit', deactivatedAt: null } : opts.member)),
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(),
    },
    memoryItem: {
      count: jest.fn(async () => (opts.counts ? opts.counts.shift() ?? 0 : 0)),
      create: jest.fn(async ({ data }: any) => ({ id: 'm1', ...data })),
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => opts.item ?? null),
      deleteMany: jest.fn(async () => ({ count: 1 })),
      delete: jest.fn(),
      update: jest.fn(async ({ data }: any) => ({ id: 'm1', ...data })),
    },
    $queryRaw: jest.fn(async () => []),
  };
  const edition: any = {
    hasMemory: jest.fn(async () => opts.licensed ?? true),
    assertMemory: jest.fn(async () => {
      if (opts.licensed === false) throw new ForbiddenException('edition_required');
    }),
  };
  const securityEvents = { log: jest.fn() };
  const service = new MemoryService(prisma as any, edition as any, securityEvents as any);
  return { service, prisma, edition, securityEvents };
}

const caller = (level: MemoryCaller['level']): MemoryCaller => ({ organizationId: ORG, userId: 'u1', level });

describe('allows', () => {
  it('orders the levels', () => {
    expect(allows('contribute', 'personal')).toBe(true);
    expect(allows('personal', 'contribute')).toBe(false);
    expect(allows('read', 'read')).toBe(true);
    expect(allows('none', 'read')).toBe(false);
  });
});

describe('looksLikeSecret', () => {
  it.each([
    'my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'AKIAABCDEFGHIJKLMNOP',
    'password: Hunter2Hunter2',
    'Passwort = geheim123',
    '-----BEGIN RSA PRIVATE KEY-----',
    'mcp_30dde7e6dab56c9c43638baedda7db6b90a29b8b4f3002b1ba33ed9063bebc89',
  ])('refuses %s', (text) => expect(looksLikeSecret(text)).toBe(true));

  it.each([
    'Customer 112759 wants delivery on Tuesdays',
    'STAMMKUNDE means a customer with a framework agreement',
    'Answer in Italian and show numbers as tables',
    'The password reset page is at /forgot-password',
  ])('accepts %s', (text) => expect(looksLikeSecret(text)).toBe(false));
});

describe('MemoryService.accessFor', () => {
  it('is none without a licence, without a user, for a non-member and for a deactivated member', async () => {
    expect(await make({ licensed: false }).service.accessFor(ORG, 'u1')).toBe('none');
    expect(await make().service.accessFor(ORG, undefined)).toBe('none');
    expect(await make({ member: null }).service.accessFor(ORG, 'client:x')).toBe('none');
    expect(
      await make({ member: { memoryAccess: 'contribute', deactivatedAt: new Date() } }).service.accessFor(ORG, 'u1'),
    ).toBe('none');
  });

  it('inherits the workspace default (personal unless set) and honours an explicit level', async () => {
    expect(await make().service.accessFor(ORG, 'u1')).toBe('personal');
    expect(
      await make({ settings: { memory_default_access: 'read' } }).service.accessFor(ORG, 'u1'),
    ).toBe('read');
    expect(
      await make({ member: { memoryAccess: 'contribute', deactivatedAt: null } }).service.accessFor(ORG, 'u1'),
    ).toBe('contribute');
    expect(
      await make({ member: { memoryAccess: 'none', deactivatedAt: null } }).service.accessFor(ORG, 'u1'),
    ).toBe('none');
  });

  it('looks the member up in this workspace', async () => {
    const { service, prisma } = make();
    await service.accessFor(ORG, 'u1');
    expect(prisma.organizationMember.findUnique.mock.calls[0][0].where).toEqual({
      userId_organizationId: { userId: 'u1', organizationId: ORG },
    });
  });
});

describe('MemoryService.save', () => {
  const src = { via: 'mcp' as const, mcpServerId: 'srv' };

  it('saves personal items for the caller, active', async () => {
    const { service, prisma } = make();
    await service.save(caller('personal'), { content: 'Answer in Italian', kind: 'preference' }, src);
    expect(prisma.memoryItem.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        organizationId: ORG,
        scope: 'personal',
        ownerUserId: 'u1',
        kind: 'preference',
        status: 'active',
        createdByUserId: 'u1',
      }),
    );
  });

  it('refuses personal writes for read and organization writes below contribute', async () => {
    const { service } = make();
    await expect(service.save(caller('read'), { content: 'x' }, src)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.save(caller('personal'), { content: 'x', scope: 'organization' }, src),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('files organization items from AI clients as pending, or active with the automatic switch', async () => {
    const pending = make();
    await pending.service.save(caller('contribute'), { content: 'Fact', scope: 'organization' }, src);
    expect(pending.prisma.memoryItem.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ scope: 'organization', ownerUserId: null, status: 'pending' }),
    );

    const auto = make({ settings: { memory_org_write_mode: 'auto' } });
    await auto.service.save(caller('contribute'), { content: 'Fact', scope: 'organization' }, src);
    expect(auto.prisma.memoryItem.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ status: 'active', approvedAt: expect.any(Date) }),
    );
  });

  it('lets a curator add company memory directly', async () => {
    const { service, prisma } = make();
    await service.save(caller('contribute'), { content: 'Fact', scope: 'organization' }, { via: 'ui' }, { asCurator: true });
    expect(prisma.memoryItem.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ status: 'active', approvedByUserId: 'u1' }),
    );
  });

  it('refuses secrets, empty and oversized content, and full workspaces', async () => {
    const { service } = make();
    await expect(
      service.save(caller('personal'), { content: 'token: abcdef123456' }, src),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.save(caller('personal'), { content: '   ' }, src)).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.save(caller('personal'), { content: 'x'.repeat(2001) }, src),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      make({ counts: [20_000, 0] }).service.save(caller('personal'), { content: 'x' }, src),
    ).rejects.toThrow(/20000 memory items/);
    await expect(
      make({ counts: [5, 1_000] }).service.save(caller('personal'), { content: 'x' }, src),
    ).rejects.toThrow(/personal memory items/);
  });

  it('keeps at most 10 lower-case tags', async () => {
    const { service, prisma } = make();
    const tags = Array.from({ length: 15 }, (_, i) => `Tag${i}`);
    await service.save(caller('personal'), { content: 'x', tags }, src);
    const saved = prisma.memoryItem.create.mock.calls[0][0].data.tags;
    expect(saved).toHaveLength(10);
    expect(saved[0]).toBe('tag0');
  });
});

describe('MemoryService.search', () => {
  it('reads active organization items and only the caller\'s personal ones, in this workspace', async () => {
    const { service, prisma } = make();
    await service.search(caller('personal'), {});
    expect(prisma.memoryItem.findMany.mock.calls[0][0].where).toEqual({
      organizationId: ORG,
      status: 'active',
      OR: [{ scope: 'organization' }, { scope: 'personal', ownerUserId: 'u1' }],
    });
  });

  it('leaves personal items out for read access', async () => {
    const { service, prisma } = make();
    await service.search(caller('read'), {});
    expect(prisma.memoryItem.findMany.mock.calls[0][0].where.OR).toEqual([{ scope: 'organization' }]);
    expect(await service.search(caller('read'), { scope: 'personal' })).toEqual([]);
  });

  it('uses full-text search, then falls back to a substring match', async () => {
    const { service, prisma } = make();
    await service.search(caller('personal'), { query: 'Stammkunde' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const fallback = prisma.memoryItem.findMany.mock.calls[0][0].where;
    expect(fallback.content).toEqual({ contains: 'Stammkunde', mode: 'insensitive' });
    expect(fallback.organizationId).toBe(ORG);
  });

  it('returns full-text hits in rank order', async () => {
    const { service, prisma } = make();
    prisma.$queryRaw.mockResolvedValue([{ id: 'b' }, { id: 'a' }]);
    prisma.memoryItem.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    const items = await service.search(caller('personal'), { query: 'x' });
    expect(items.map((i: any) => i.id)).toEqual(['b', 'a']);
    expect(prisma.memoryItem.findMany.mock.calls[0][0].where.id).toEqual({ in: ['b', 'a'] });
  });
});

describe('MemoryService ownership', () => {
  it('forgets only the caller\'s own personal items', async () => {
    const { service, prisma } = make();
    await service.forget(caller('personal'), 'm1');
    expect(prisma.memoryItem.deleteMany).toHaveBeenCalledWith({
      where: { id: 'm1', organizationId: ORG, scope: 'personal', ownerUserId: 'u1' },
    });
    expect(await service.forget(caller('read'), 'm1')).toBe(false);
  });

  it('answers not-found for someone else\'s personal item, even to an admin', async () => {
    const { service } = make({ item: { scope: 'personal', ownerUserId: 'someone-else' } });
    await expect(service.update(ORG, 'u1', true, 'm1', { content: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(ORG, 'u1', true, 'm1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lets only curators edit company items', async () => {
    const org = make({ item: { scope: 'organization', ownerUserId: null } });
    await expect(org.service.update(ORG, 'u1', false, 'm1', { content: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(org.service.update(ORG, 'u1', true, 'm1', { content: 'x' })).resolves.toBeDefined();
  });

  it('refuses dashboard routes without the licence', async () => {
    const { service } = make({ licensed: false });
    await expect(service.list(ORG, 'u1', { scope: 'personal' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('erases a member\'s personal memory in this workspace and logs it', async () => {
    const { service, prisma, securityEvents } = make();
    const res = await service.erasePersonal(ORG, 'u2', { actorUserId: 'admin' });
    expect(res).toEqual({ erased: 1 });
    expect(prisma.memoryItem.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, scope: 'personal', ownerUserId: 'u2' },
    });
    expect(securityEvents.log.mock.calls[0][0]).toEqual(
      expect.objectContaining({ event: 'MEMORY_ERASED', targetUserId: 'u2', organizationId: ORG }),
    );
  });
});

describe('MemoryService.setAccess', () => {
  it('changes members of this workspace only and logs each change', async () => {
    const { service, prisma, securityEvents } = make();
    prisma.organizationMember.findMany.mockResolvedValue([
      { userId: 'u1', memoryAccess: 'inherit' },
      { userId: 'u2', memoryAccess: 'read' },
    ] as any);
    const res = await service.setAccess(ORG, ['u1', 'u2', 'x'], 'read', { actorUserId: 'admin' });
    expect(res).toEqual({ updated: 1, notFound: ['x'] });
    expect(prisma.organizationMember.findMany.mock.calls[0][0].where.organizationId).toBe(ORG);
    expect(securityEvents.log).toHaveBeenCalledTimes(1);
    expect(securityEvents.log.mock.calls[0][0]).toEqual(
      expect.objectContaining({ event: 'MEMORY_ACCESS_CHANGED', targetUserId: 'u1', metadata: { from: 'inherit', to: 'read' } }),
    );
  });
});

describe('MemoryService with folders', () => {
  const tree = [
    { id: 'f-sales', parentId: null, name: 'Sales', description: null, roleIds: ['r'], path: 'Sales', depth: 1 },
    { id: 'f-hr', parentId: null, name: 'HR', description: null, roleIds: [], path: 'HR', depth: 1 },
  ];
  const restricted = { organizationId: ORG, all: false, ids: new Set(['f-hr']), folders: [tree[1]] };

  it('hides company items in folders the caller may not see', async () => {
    const { service, prisma } = make();
    await service.search({ ...caller('personal'), folders: restricted as any }, {});
    expect(prisma.memoryItem.findMany.mock.calls[0][0].where.OR).toEqual([
      {
        scope: 'organization',
        AND: [{ OR: [{ folderId: null }, { folderId: { in: ['f-hr'] } }] }],
      },
      { scope: 'personal', ownerUserId: 'u1' },
    ]);
  });

  it('narrows to a visible folder and leaves personal memory out', async () => {
    const { service, prisma } = make();
    await service.search({ ...caller('personal'), folders: restricted as any }, { folder: 'hr' });
    expect(prisma.memoryItem.findMany.mock.calls[0][0].where.OR).toEqual([
      { scope: 'organization', folderId: { in: ['f-hr'] } },
    ]);
    expect(await service.search({ ...caller('personal'), folders: restricted as any }, { folder: 'Sales' })).toEqual([]);
  });

  it('files company items only in a folder the caller may see', async () => {
    const { service, prisma } = make();
    await service.save(
      { ...caller('contribute'), folders: restricted as any },
      { content: 'Payroll closes on the 25th', scope: 'organization', folder: 'HR' },
      { via: 'mcp' },
    );
    expect(prisma.memoryItem.create.mock.calls[0][0].data.folderId).toBe('f-hr');
    await expect(
      service.save(
        { ...caller('contribute'), folders: restricted as any },
        { content: 'x', scope: 'organization', folder: 'Sales' },
        { via: 'mcp' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers not-found to a curator for a company item in a hidden folder', async () => {
    const { service } = make({ item: { scope: 'organization', ownerUserId: null, folderId: 'f-sales' } });
    await expect(
      service.update(ORG, 'u1', true, 'm1', { content: 'x' }, restricted as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
