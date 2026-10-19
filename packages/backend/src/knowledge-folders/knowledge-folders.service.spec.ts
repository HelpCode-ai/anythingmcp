import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  KnowledgeFoldersService,
  buildTree,
  folderVisibility,
  resolveFolder,
  subtreeIds,
} from './knowledge-folders.service';

const ORG = 'org-A';

const ROWS = [
  { id: 'sales', parentId: null, name: 'Sales', description: 'Sales work', roleIds: ['r-sales'] },
  { id: 'quotes', parentId: 'sales', name: 'Quotes', description: null, roleIds: [] },
  { id: 'big', parentId: 'quotes', name: 'Big deals', description: null, roleIds: ['r-key'] },
  { id: 'hr', parentId: null, name: 'HR', description: null, roleIds: [] },
];

function make(opts: {
  rows?: any[];
  member?: { role: string; deactivatedAt: Date | null } | null;
  roles?: string[];
  enterprise?: boolean;
} = {}) {
  const rows = opts.rows ?? ROWS;
  const tx: any = {
    knowledgeFolder: { update: jest.fn(), delete: jest.fn() },
    kgSkillSuggestion: { updateMany: jest.fn() },
    memoryItem: { updateMany: jest.fn() },
  };
  const prisma: any = {
    knowledgeFolder: {
      findMany: jest.fn(async () => rows),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: 'new', description: null, roleIds: [], ...data };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async () => ({})),
    },
    organizationMember: {
      findUnique: jest.fn(async () => (opts.member === undefined ? { role: 'EDITOR', deactivatedAt: null } : opts.member)),
    },
    userRoleAssignment: {
      findMany: jest.fn(async () => (opts.roles ?? []).map((roleId) => ({ roleId }))),
    },
    role: { findMany: jest.fn(async ({ where }: any) => where.id.in.filter((id: string) => id.startsWith('r-')).map((id: string) => ({ id }))) },
    kgSkillSuggestion: {
      updateMany: jest.fn(async () => ({ count: 2 })),
      groupBy: jest.fn(async () => []),
      findMany: jest.fn(async () => []),
    },
    memoryItem: {
      updateMany: jest.fn(async () => ({ count: 1 })),
      groupBy: jest.fn(async () => []),
      findMany: jest.fn(async () => []),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const edition: any = {
    hasEnterprise: jest.fn(async () => opts.enterprise ?? true),
    assertEnterprise: jest.fn(async () => {
      if (opts.enterprise === false) throw new ForbiddenException('edition_required');
    }),
  };
  const securityEvents: any = { log: jest.fn() };
  return { svc: new KnowledgeFoldersService(prisma, edition, securityEvents), prisma, tx, securityEvents };
}

describe('folder tree helpers', () => {
  const tree = buildTree(ROWS);

  it('builds paths and depths', () => {
    expect(tree.find((f) => f.id === 'big')).toEqual(
      expect.objectContaining({ path: 'Sales / Quotes / Big deals', depth: 3 }),
    );
    expect(tree.map((f) => f.path)).toEqual(['HR', 'Sales', 'Sales / Quotes', 'Sales / Quotes / Big deals']);
  });

  it('resolves a folder by id or by path, ignoring case and spacing', () => {
    expect(resolveFolder(tree, 'quotes')?.id).toBe('quotes');
    expect(resolveFolder(tree, 'sales/quotes')?.id).toBe('quotes');
    expect(resolveFolder(tree, ' Sales /  Quotes / Big deals ')?.id).toBe('big');
    expect(resolveFolder(tree, 'Marketing')).toBeNull();
  });

  it('collects a subtree', () => {
    expect([...subtreeIds(tree, 'sales')].sort()).toEqual(['big', 'quotes', 'sales']);
  });

  it('builds no filter when nothing is restricted for the caller', () => {
    expect(folderVisibility(null)).toEqual({});
    expect(folderVisibility({ organizationId: ORG, all: true, ids: new Set(), folders: [] })).toEqual({});
    expect(folderVisibility({ organizationId: ORG, all: false, ids: new Set(['hr']), folders: [] })).toEqual({
      OR: [{ folderId: null }, { folderId: { in: ['hr'] } }],
    });
  });
});

describe('KnowledgeFoldersService.accessFor', () => {
  it('lets everyone see everything when no folder is restricted', async () => {
    const { svc, prisma } = make({ rows: [{ id: 'a', parentId: null, name: 'A', description: null, roleIds: [] }] });
    const access = await svc.accessFor(ORG, undefined);
    expect(access.all).toBe(true);
    expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
  });

  it('shows a workspace admin every folder', async () => {
    const { svc } = make({ member: { role: 'ADMIN', deactivatedAt: null } });
    expect((await svc.accessFor(ORG, 'u1')).all).toBe(true);
  });

  it('applies restrictions down the tree', async () => {
    const sales = await make({ roles: ['r-sales'] }).svc.accessFor(ORG, 'u1');
    expect(sales.all).toBe(false);
    expect([...sales.ids].sort()).toEqual(['hr', 'quotes', 'sales']);

    const both = await make({ roles: ['r-sales', 'r-key'] }).svc.accessFor(ORG, 'u1');
    expect([...both.ids].sort()).toEqual(['big', 'hr', 'quotes', 'sales']);

    // A role on the subfolder alone is not enough: the parent is restricted too.
    const keyOnly = await make({ roles: ['r-key'] }).svc.accessFor(ORG, 'u1');
    expect([...keyOnly.ids]).toEqual(['hr']);
  });

  it('reads roles of this workspace (and global grants) only', async () => {
    const { svc, prisma } = make({ roles: ['r-sales'] });
    await svc.accessFor(ORG, 'u1');
    expect(prisma.userRoleAssignment.findMany.mock.calls[0][0].where).toEqual({
      userId: 'u1',
      OR: [{ organizationId: ORG }, { organizationId: null }],
    });
  });

  it('shows only unrestricted folders to callers without a member identity', async () => {
    for (const { userId, member } of [
      { userId: undefined, member: undefined },
      { userId: 'client:x', member: null },
      { userId: 'u1', member: { role: 'EDITOR', deactivatedAt: new Date() } },
    ]) {
      const access = await make({ member: member as any, roles: ['r-sales'] }).svc.accessFor(ORG, userId);
      expect([...access.ids]).toEqual(['hr']);
    }
  });
});

describe('KnowledgeFoldersService changes', () => {
  it('creates a folder under a parent and refuses depth > 4, "/" and duplicate names', async () => {
    const { svc, prisma } = make({ rows: ROWS.map((r) => ({ ...r })) });
    await svc.create(ORG, { name: 'Templates', parentId: 'quotes' });
    expect(prisma.knowledgeFolder.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ organizationId: ORG, parentId: 'quotes', name: 'Templates' }),
    );

    const deep = make({
      rows: [
        { id: 'a', parentId: null, name: 'A', description: null, roleIds: [] },
        { id: 'b', parentId: 'a', name: 'B', description: null, roleIds: [] },
        { id: 'c', parentId: 'b', name: 'C', description: null, roleIds: [] },
        { id: 'd', parentId: 'c', name: 'D', description: null, roleIds: [] },
      ],
    });
    await expect(deep.svc.create(ORG, { name: 'E', parentId: 'd' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(ORG, { name: 'a/b' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(ORG, { name: 'quotes', parentId: 'sales' })).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.create(ORG, { name: 'X', parentId: 'other-org' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to move a folder into itself or below itself', async () => {
    const { svc } = make();
    await expect(svc.update(ORG, 'sales', { parentId: 'big' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update(ORG, 'sales', { parentId: 'sales' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('deletes a folder by moving its subfolders and items to the parent', async () => {
    const { svc, tx } = make();
    const res = await svc.remove(ORG, 'quotes');
    expect(res).toEqual({ ok: true, movedTo: 'sales' });
    expect(tx.knowledgeFolder.update).toHaveBeenCalledWith({
      where: { id: 'big' },
      data: { parentId: 'sales', name: 'Big deals' },
    });
    expect(tx.kgSkillSuggestion.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, folderId: 'quotes' },
      data: { folderId: 'sales' },
    });
    expect(tx.memoryItem.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, folderId: 'quotes' },
      data: { folderId: 'sales' },
    });
    expect(tx.knowledgeFolder.delete).toHaveBeenCalledWith({ where: { id: 'quotes' } });
  });

  it('renames a moved subfolder whose name is taken at the parent', async () => {
    const rows = [
      { id: 'p', parentId: null, name: 'P', description: null, roleIds: [] },
      { id: 'x', parentId: 'p', name: 'Docs', description: null, roleIds: [] },
      { id: 'docs', parentId: null, name: 'Docs', description: null, roleIds: [] },
    ];
    const { svc, tx } = make({ rows });
    await svc.remove(ORG, 'p');
    expect(tx.knowledgeFolder.update).toHaveBeenCalledWith({
      where: { id: 'x' },
      data: { parentId: null, name: 'Docs (2)' },
    });
  });

  it('limits a folder to roles only with Enterprise, known roles, and logs it', async () => {
    const { svc, prisma, securityEvents } = make();
    await svc.setRoles(ORG, 'hr', ['r-hr'], { actorUserId: 'admin' });
    expect(prisma.role.findMany.mock.calls[0][0].where).toEqual({
      id: { in: ['r-hr'] },
      OR: [{ organizationId: ORG }, { organizationId: null }],
    });
    expect(prisma.knowledgeFolder.update).toHaveBeenCalledWith({ where: { id: 'hr' }, data: { roleIds: ['r-hr'] } });
    expect(securityEvents.log.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        event: 'KNOWLEDGE_FOLDER_ACCESS_CHANGED',
        organizationId: ORG,
        metadata: { folderId: 'hr', path: 'HR', from: [], to: ['r-hr'] },
      }),
    );
    await expect(svc.setRoles(ORG, 'hr', ['foreign-role'], { actorUserId: 'admin' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      make({ enterprise: false }).svc.setRoles(ORG, 'hr', [], { actorUserId: 'admin' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('moves only items of this workspace, and only company memory', async () => {
    const { svc, prisma } = make();
    await svc.moveItems(ORG, 'memory', ['m1', 'm1', 'm2'], 'hr');
    expect(prisma.memoryItem.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, id: { in: ['m1', 'm2'] }, scope: 'organization' },
      data: { folderId: 'hr' },
    });
    await svc.moveItems(ORG, 'skill', ['s1'], null);
    expect(prisma.kgSkillSuggestion.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, id: { in: ['s1'] } },
      data: { folderId: null },
    });
    await expect(svc.moveItems(ORG, 'skill', ['s1'], 'other-org')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('KnowledgeFoldersService never widens access by accident', () => {
  it('refuses a non-admin moving a folder out from under a limited one', async () => {
    const { svc } = make();
    await expect(svc.update(ORG, 'quotes', { parentId: null })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.update(ORG, 'quotes', { parentId: null }, true)).resolves.toBeDefined();
    // Moving within the same limited branch is fine.
    const inside = make({
      rows: [...ROWS, { id: 'templates', parentId: 'sales', name: 'Templates', description: null, roleIds: [] }],
    });
    await expect(inside.svc.update(ORG, 'templates', { parentId: 'quotes' })).resolves.toBeDefined();
  });

  it('refuses a non-admin moving items out of a limited folder', async () => {
    const { svc, prisma } = make();
    prisma.memoryItem.findMany = jest.fn(async () => [{ folderId: 'quotes' }]);
    await expect(svc.moveItems(ORG, 'memory', ['m1'], 'hr')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.moveItems(ORG, 'memory', ['m1'], 'hr', true)).resolves.toEqual({ moved: 1 });
    // Into a limited folder narrows access: allowed.
    prisma.memoryItem.findMany = jest.fn(async () => [{ folderId: 'hr' }]);
    await expect(svc.moveItems(ORG, 'memory', ['m1'], 'quotes')).resolves.toEqual({ moved: 1 });
  });

  it('refuses deleting a limited folder that still holds items', async () => {
    const { svc, prisma } = make();
    prisma.kgSkillSuggestion.count = jest.fn(async () => 2);
    prisma.memoryItem.count = jest.fn(async () => 0);
    await expect(svc.remove(ORG, 'sales')).rejects.toBeInstanceOf(ConflictException);
  });

  it('hands a deleted limited folder\'s limit down to its subfolders', async () => {
    const { svc, prisma, tx } = make();
    prisma.kgSkillSuggestion.count = jest.fn(async () => 0);
    prisma.memoryItem.count = jest.fn(async () => 0);
    await svc.remove(ORG, 'sales');
    expect(tx.knowledgeFolder.update).toHaveBeenCalledWith({
      where: { id: 'quotes' },
      data: { parentId: null, name: 'Quotes', roleIds: ['r-sales'] },
    });
  });

  it('refuses when a subfolder is limited to different roles', async () => {
    const rows = [
      { id: 'a', parentId: null, name: 'A', description: null, roleIds: ['r-1'] },
      { id: 'b', parentId: 'a', name: 'B', description: null, roleIds: ['r-2'] },
    ];
    const { svc, prisma } = make({ rows });
    prisma.kgSkillSuggestion.count = jest.fn(async () => 0);
    prisma.memoryItem.count = jest.fn(async () => 0);
    await expect(svc.remove(ORG, 'a')).rejects.toThrow(/limited to different roles/);
  });
});
