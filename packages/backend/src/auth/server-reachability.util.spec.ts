import { serverReachability, userReachesOrganization } from './server-reachability.util';

describe('serverReachability', () => {
  const build = (opts: {
    server?: { organizationId: string } | null;
    primaryOrg?: string | null;
    member?: boolean;
  }) => ({
    mcpServerConfig: {
      findUnique: jest.fn().mockResolvedValue(opts.server === undefined ? null : opts.server),
    },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue(opts.primaryOrg === undefined ? null : { organizationId: opts.primaryOrg }),
    },
    organizationMember: {
      findFirst: jest.fn().mockResolvedValue(opts.member ? { userId: 'u1' } : null),
    },
  });

  it('is reachable in the primary workspace, without a membership lookup', async () => {
    const prisma = build({ server: { organizationId: 'org-A' }, primaryOrg: 'org-A' });
    await expect(serverReachability(prisma as any, 'u1', 'srv')).resolves.toBe('reachable');
    expect(prisma.organizationMember.findFirst).not.toHaveBeenCalled();
  });

  it('is reachable for an active member of a non-primary workspace', async () => {
    const prisma = build({ server: { organizationId: 'org-B' }, primaryOrg: 'org-A', member: true });
    await expect(serverReachability(prisma as any, 'u1', 'srv')).resolves.toBe('reachable');
    expect(prisma.organizationMember.findFirst).toHaveBeenCalledWith({
      where: { userId: 'u1', organizationId: 'org-B', deactivatedAt: null },
      select: { userId: true },
    });
  });

  it('is unreachable when the only membership is deactivated (the query asks for active rows)', async () => {
    // The deactivated row does not match `deactivatedAt: null`, so findFirst finds nothing.
    const prisma = build({ server: { organizationId: 'org-B' }, primaryOrg: 'org-A', member: false });
    await expect(serverReachability(prisma as any, 'u1', 'srv')).resolves.toBe('unreachable');
  });

  it('is unreachable for a non-member', async () => {
    const prisma = build({ server: { organizationId: 'org-B' }, primaryOrg: 'org-A' });
    await expect(serverReachability(prisma as any, 'u1', 'srv')).resolves.toBe('unreachable');
  });

  it('is unknown for a server that does not exist', async () => {
    const prisma = build({ server: null, primaryOrg: 'org-A' });
    await expect(serverReachability(prisma as any, 'u1', 'srv')).resolves.toBe('unknown');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('is unknown when a lookup throws', async () => {
    const prisma = build({ server: { organizationId: 'org-B' } });
    prisma.mcpServerConfig.findUnique.mockRejectedValue(new Error('db down'));
    await expect(serverReachability(prisma as any, 'u1', 'srv')).resolves.toBe('unknown');
  });

  it('skips the user query when the primary org is passed in', async () => {
    const prisma = build({ server: { organizationId: 'org-A' } });
    await expect(serverReachability(prisma as any, 'u1', 'srv', 'org-A')).resolves.toBe('reachable');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('treats a passed-in null primary org as "none" and checks membership', async () => {
    const prisma = build({ server: { organizationId: 'org-A' }, member: true });
    await expect(serverReachability(prisma as any, 'u1', 'srv', null)).resolves.toBe('reachable');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.organizationMember.findFirst).toHaveBeenCalled();
  });
});

describe('userReachesOrganization', () => {
  it('never asks about membership without a user or an organization', async () => {
    const lookup = jest.fn().mockResolvedValue(true);
    await expect(userReachesOrganization(undefined, 'org-A', undefined, lookup)).resolves.toBe(false);
    await expect(userReachesOrganization('u1', undefined, undefined, lookup)).resolves.toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('does not match two missing organizations', async () => {
    const lookup = jest.fn().mockResolvedValue(false);
    await expect(userReachesOrganization('u1', '', '', lookup)).resolves.toBe(false);
  });
});
