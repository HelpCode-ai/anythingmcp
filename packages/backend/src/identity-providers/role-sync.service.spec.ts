import { RoleSyncService, DENY_ALL_ROLE_NAME, SYNC_SOURCE } from './role-sync.service';

const ORG = 'org_1';
const USER = 'user_1';

function makeProvider(over: Partial<any> = {}) {
  return {
    id: 'idp_1',
    organizationId: ORG,
    roleSyncEnabled: true,
    roleSyncSource: 'GROUPS',
    roleSyncFallback: 'DENY_ALL',
    roleSyncDefaultRoleIds: [],
    scimEnabled: false,
    ...over,
  } as any;
}

describe('RoleSyncService', () => {
  let prisma: any;
  let securityEvents: any;
  let service: RoleSyncService;

  beforeEach(() => {
    prisma = {
      identityProviderRoleMapping: { findMany: jest.fn(async () => []) },
      role: {
        findMany: jest.fn(async ({ where }: any) =>
          (where.id.in as string[]).map((id) => ({ id })),
        ),
        upsert: jest.fn(async () => ({ id: 'role_deny' })),
      },
      userRoleAssignment: {
        deleteMany: jest.fn(async () => ({ count: 0 })),
        createMany: jest.fn(async () => ({ count: 0 })),
      },
      organizationMember: {
        findUnique: jest.fn(async () => ({ role: 'VIEWER', deactivatedAt: null })),
        update: jest.fn(async () => ({})),
        count: jest.fn(async () => 2),
      },
      user: { findUnique: jest.fn(async () => ({ organizationId: ORG })), update: jest.fn(async () => ({})) },
      userIdentity: { findUnique: jest.fn(async () => null), findMany: jest.fn(async () => []) },
      identityProviderGroupMember: { findMany: jest.fn(async () => []) },
      identityProvider: { findUnique: jest.fn(async () => null) },
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    securityEvents = { log: jest.fn() };
    service = new RoleSyncService(prisma, securityEvents);
  });

  it('does nothing when role sync is off', async () => {
    const out = await service.syncOnLogin(
      makeProvider({ roleSyncEnabled: false }),
      USER,
      { groups: ['g1'] },
    );
    expect(out).toMatchObject({ applied: false, reason: 'disabled' });
    expect(prisma.userRoleAssignment.deleteMany).not.toHaveBeenCalled();
  });

  // The failure this guards against is not theoretical: past ~150 groups Entra
  // replaces the claim with a Graph pointer, so every mapping misses and a
  // naive sync revokes the roles of the most heavily-grouped people in the
  // directory.
  it('refuses to act on a token that signalled a groups overage', async () => {
    const out = await service.syncOnLogin(makeProvider(), USER, {
      _claim_names: { groups: 'src1' },
      _claim_sources: { src1: { endpoint: 'https://graph.microsoft.com/...' } },
    });
    expect(out).toMatchObject({ applied: false, reason: 'overage' });
    expect(prisma.userRoleAssignment.deleteMany).not.toHaveBeenCalled();
    expect(prisma.userRoleAssignment.createMany).not.toHaveBeenCalled();
    expect(securityEvents.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ROLE_SYNC_SKIPPED' }),
    );
  });

  it('matches on group object ids and grants the union of their roles', async () => {
    prisma.identityProviderRoleMapping.findMany.mockResolvedValue([
      { externalId: 'g1', userRole: null, mcpRoleIds: ['r1', 'r2'] },
      { externalId: 'g2', userRole: null, mcpRoleIds: ['r2', 'r3'] },
      { externalId: 'g9', userRole: null, mcpRoleIds: ['r9'] },
    ]);
    const out = await service.syncOnLogin(makeProvider(), USER, {
      groups: ['g1', 'g2', 'unmapped'],
    });
    expect(out.reason).toBe('matched');
    expect(out.matched).toBe(2);
    expect(out.presented).toBe(3);
    expect([...out.grantedRoleIds].sort()).toEqual(['r1', 'r2', 'r3']);
    // r9 is never granted: the user is not in g9.
    expect(out.grantedRoleIds).not.toContain('r9');
  });

  it('never matches on a group display name', async () => {
    prisma.identityProviderRoleMapping.findMany.mockResolvedValue([
      { externalId: 'GB_Fuehrungskreis', userRole: 'ADMIN', mcpRoleIds: ['r1'] },
    ]);
    const out = await service.syncOnLogin(makeProvider(), USER, {
      // A real Entra token carries object ids here, not names. A directory
      // that sent names must not be able to hit a privileged mapping.
      groups: ['4be78614-f22d-472f-a2cb-5eb81b6e3f6f'],
    });
    expect(out.matched).toBe(0);
  });

  it('takes the most privileged organization role across matches', async () => {
    prisma.identityProviderRoleMapping.findMany.mockResolvedValue([
      { externalId: 'g1', userRole: 'VIEWER', mcpRoleIds: [] },
      { externalId: 'g2', userRole: 'ADMIN', mcpRoleIds: [] },
      { externalId: 'g3', userRole: 'EDITOR', mcpRoleIds: [] },
    ]);
    await service.syncOnLogin(makeProvider(), USER, { groups: ['g1', 'g2', 'g3'] });
    expect(prisma.organizationMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { role: 'ADMIN' } }),
    );
  });

  it('refuses a demotion that would leave the workspace with no admin', async () => {
    prisma.organizationMember.findUnique.mockResolvedValue({ role: 'ADMIN' });
    prisma.organizationMember.count.mockResolvedValue(1);
    prisma.identityProviderRoleMapping.findMany.mockResolvedValue([
      { externalId: 'g1', userRole: 'VIEWER', mcpRoleIds: [] },
    ]);
    const out = await service.syncOnLogin(makeProvider(), USER, { groups: ['g1'] });
    expect(out.lastAdminProtected).toBe(true);
    expect(prisma.organizationMember.update).not.toHaveBeenCalled();
    expect(securityEvents.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'LAST_ADMIN_PROTECTION_TRIGGERED' }),
    );
  });

  it('still demotes when another admin remains', async () => {
    prisma.organizationMember.findUnique.mockResolvedValue({ role: 'ADMIN' });
    prisma.organizationMember.count.mockResolvedValue(2);
    prisma.identityProviderRoleMapping.findMany.mockResolvedValue([
      { externalId: 'g1', userRole: 'VIEWER', mcpRoleIds: [] },
    ]);
    await service.syncOnLogin(makeProvider(), USER, { groups: ['g1'] });
    expect(prisma.organizationMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { role: 'VIEWER' } }),
    );
  });

  // The whole point of DENY_ALL. Deleting the user's grants would leave them
  // with none, and `getAllowedToolIds` reads "no role" as UNRESTRICTED — so
  // the obvious implementation grants full access.
  it('DENY_ALL assigns an empty role instead of leaving the user role-less', async () => {
    const out = await service.syncOnLogin(makeProvider(), USER, { groups: ['nope'] });
    expect(out.reason).toBe('fallback_deny_all');
    expect(prisma.role.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId_name: { organizationId: ORG, name: DENY_ALL_ROLE_NAME } },
      }),
    );
    expect(out.grantedRoleIds).toEqual(['role_deny']);
    expect(prisma.userRoleAssignment.createMany).toHaveBeenCalled();
  });

  it('KEEP_EXISTING writes nothing at all', async () => {
    const out = await service.syncOnLogin(
      makeProvider({ roleSyncFallback: 'KEEP_EXISTING' }),
      USER,
      { groups: ['nope'] },
    );
    expect(out).toMatchObject({ applied: false, reason: 'fallback_keep_existing' });
    expect(prisma.userRoleAssignment.deleteMany).not.toHaveBeenCalled();
    expect(prisma.role.upsert).not.toHaveBeenCalled();
  });

  it('DEFAULT_ROLE grants the configured roles', async () => {
    const out = await service.syncOnLogin(
      makeProvider({ roleSyncFallback: 'DEFAULT_ROLE', roleSyncDefaultRoleIds: ['r_default'] }),
      USER,
      { groups: ['nope'] },
    );
    expect(out.grantedRoleIds).toEqual(['r_default']);
  });

  it('only ever deletes assignments it owns', async () => {
    prisma.identityProviderRoleMapping.findMany.mockResolvedValue([
      { externalId: 'g1', userRole: null, mcpRoleIds: ['r1'] },
    ]);
    await service.syncOnLogin(makeProvider(), USER, { groups: ['g1'] });
    expect(prisma.userRoleAssignment.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ source: SYNC_SOURCE, userId: USER, organizationId: ORG }),
    });
  });

  it('drops mapped roles that do not belong to the workspace', async () => {
    prisma.identityProviderRoleMapping.findMany.mockResolvedValue([
      { externalId: 'g1', userRole: null, mcpRoleIds: ['r_mine', 'r_other_org'] },
    ]);
    prisma.role.findMany.mockResolvedValue([{ id: 'r_mine' }]);
    const out = await service.syncOnLogin(makeProvider(), USER, { groups: ['g1'] });
    expect(out.grantedRoleIds).toEqual(['r_mine']);
  });

  it('treats a non-array claim as absent rather than coercing it', async () => {
    prisma.identityProviderRoleMapping.findMany.mockResolvedValue([
      { externalId: 'g1', userRole: 'ADMIN', mcpRoleIds: ['r1'] },
    ]);
    const out = await service.syncOnLogin(makeProvider(), USER, { groups: 'g1' });
    expect(out.matched).toBe(0);
    expect(prisma.organizationMember.update).not.toHaveBeenCalled();
  });

  it('reads app roles from `roles` when the source is APP_ROLES', async () => {
    prisma.identityProviderRoleMapping.findMany.mockResolvedValue([
      { externalId: 'amcp.einkauf', userRole: null, mcpRoleIds: ['r1'] },
    ]);
    const out = await service.syncOnLogin(
      makeProvider({ roleSyncSource: 'APP_ROLES' }),
      USER,
      { roles: ['amcp.einkauf'], groups: ['ignored'] },
    );
    expect(out.matched).toBe(1);
  });

  // An overage pointer is a GROUPS concept; app roles are never paged, so the
  // same token must not be treated as incomplete when reading `roles`.
  it('ignores a groups overage when syncing app roles', async () => {
    prisma.identityProviderRoleMapping.findMany.mockResolvedValue([
      { externalId: 'amcp.leitung', userRole: null, mcpRoleIds: ['r1'] },
    ]);
    const out = await service.syncOnLogin(
      makeProvider({ roleSyncSource: 'APP_ROLES' }),
      USER,
      { roles: ['amcp.leitung'], _claim_names: { groups: 'src1' } },
    );
    expect(out.reason).toBe('matched');
  });

  it('never turns a database failure into a failed login', async () => {
    prisma.identityProviderRoleMapping.findMany.mockRejectedValue(new Error('db down'));
    const out = await service.syncOnLogin(makeProvider(), USER, { groups: ['g1'] });
    expect(out.applied).toBe(false);
    expect(securityEvents.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ROLE_SYNC_FAILED' }),
    );
  });

  // ── SCIM as the source of truth ───────────────────────────────────────────

  describe('with SCIM enabled', () => {
    const scim = () => makeProvider({ scimEnabled: true });
    const managed = () => prisma.userIdentity.findUnique.mockResolvedValue({ scimManagedAt: new Date() });
    const stored = (ids: string[]) =>
      prisma.identityProviderGroupMember.findMany.mockResolvedValue(ids.map((externalId) => ({ group: { externalId } })));

    it('at sign-in, uses the stored memberships and ignores the token entirely', async () => {
      managed(); stored(['g1']);
      prisma.identityProviderRoleMapping.findMany.mockResolvedValue([
        { externalId: 'g1', userRole: null, mcpRoleIds: ['r1'] },
        { externalId: 'g-token-only', userRole: null, mcpRoleIds: ['r9'] },
      ]);
      const out = await service.syncOnLogin(scim(), USER, { groups: ['g-token-only'] });
      expect(out).toMatchObject({ reason: 'matched', membershipSource: 'scim', trigger: 'login' });
      expect(out.grantedRoleIds).toEqual(['r1']);
      expect(out.grantedRoleIds).not.toContain('r9');
    });

    // The whole point: a token WITHOUT a groups claim must not wipe what SCIM
    // granted. Before SCIM, this exact case produced DENY_ALL.
    it('a token without a groups claim cannot wipe SCIM-derived roles', async () => {
      managed(); stored(['g1']);
      prisma.identityProviderRoleMapping.findMany.mockResolvedValue([{ externalId: 'g1', userRole: null, mcpRoleIds: ['r1'] }]);
      const out = await service.syncOnLogin(scim(), USER, {});
      expect(out).toMatchObject({ reason: 'matched', membershipSource: 'scim' });
    });

    it('an overage pointer is irrelevant when SCIM describes the user', async () => {
      managed(); stored(['g1']);
      prisma.identityProviderRoleMapping.findMany.mockResolvedValue([{ externalId: 'g1', userRole: null, mcpRoleIds: ['r1'] }]);
      const out = await service.syncOnLogin(scim(), USER, { _claim_names: { groups: 'src1' } });
      expect(out.reason).toBe('matched');
      expect(securityEvents.log).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'ROLE_SYNC_SKIPPED' }));
    });

    it('falls back to the claims for a user SCIM has never described', async () => {
      prisma.userIdentity.findUnique.mockResolvedValue({ scimManagedAt: null });
      prisma.identityProviderRoleMapping.findMany.mockResolvedValue([{ externalId: 'g-claim', userRole: null, mcpRoleIds: ['r1'] }]);
      const out = await service.syncOnLogin(scim(), USER, { groups: ['g-claim'] });
      expect(out).toMatchObject({ reason: 'matched', membershipSource: 'claims' });
    });

    // [] from SCIM is authoritative: "in no group" applies the fallback.
    it('SCIM saying "no groups" applies the fallback even if the token disagrees', async () => {
      managed(); stored([]);
      prisma.identityProviderRoleMapping.findMany.mockResolvedValue([{ externalId: 'g-claim', userRole: null, mcpRoleIds: ['r1'] }]);
      const out = await service.syncOnLogin(scim(), USER, { groups: ['g-claim'] });
      expect(out).toMatchObject({ reason: 'fallback_deny_all', membershipSource: 'scim' });
    });

    it('syncFromScim reports source_not_groups under APP_ROLES and no_directory_state when unmanaged', async () => {
      expect(await service.syncFromScim(makeProvider({ scimEnabled: true, roleSyncSource: 'APP_ROLES' }), USER)).toMatchObject({ reason: 'source_not_groups' });
      prisma.userIdentity.findUnique.mockResolvedValue(null);
      expect(await service.syncFromScim(scim(), USER)).toMatchObject({ reason: 'no_directory_state' });
      expect(prisma.userRoleAssignment.deleteMany).not.toHaveBeenCalled();
    });

    it('writes the same source as the sign-in path, so the last writer wins', async () => {
      managed(); stored(['g1']);
      prisma.identityProviderRoleMapping.findMany.mockResolvedValue([{ externalId: 'g1', userRole: null, mcpRoleIds: ['r1'] }]);
      await service.syncFromScim(scim(), USER);
      expect(prisma.userRoleAssignment.deleteMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ source: SYNC_SOURCE }),
      });
      expect(prisma.userRoleAssignment.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: [expect.objectContaining({ source: SYNC_SOURCE })] }),
      );
    });
  });

  // A mapping that matches and grants nothing used to write an EMPTY synced
  // set — leaving the user with no role, which getAllowedToolIds reads as
  // unrestricted. It must land on the fallback like a miss does.
  it('a match that grants nothing is a fallback, not full access', async () => {
    prisma.identityProviderRoleMapping.findMany.mockResolvedValue([{ externalId: 'g1', userRole: null, mcpRoleIds: [] }]);
    const out = await service.syncOnLogin(makeProvider(), USER, { groups: ['g1'] });
    expect(out.reason).toBe('fallback_deny_all');
    expect(prisma.role.upsert).toHaveBeenCalled();
  });

  it('a match that grants only a workspace role is still a match', async () => {
    prisma.identityProviderRoleMapping.findMany.mockResolvedValue([{ externalId: 'g1', userRole: 'EDITOR', mcpRoleIds: [] }]);
    const out = await service.syncOnLogin(makeProvider(), USER, { groups: ['g1'] });
    expect(out.reason).toBe('matched');
    expect(prisma.organizationMember.update).toHaveBeenCalledWith(expect.objectContaining({ data: { role: 'EDITOR' } }));
  });

  it('leaves a deactivated membership alone', async () => {
    prisma.organizationMember.findUnique.mockResolvedValue({ role: 'VIEWER', deactivatedAt: new Date() });
    prisma.identityProviderRoleMapping.findMany.mockResolvedValue([{ externalId: 'g1', userRole: 'ADMIN', mcpRoleIds: ['r1'] }]);
    await service.syncOnLogin(makeProvider(), USER, { groups: ['g1'] });
    expect(prisma.organizationMember.update).not.toHaveBeenCalled();
  });

  describe('resync', () => {
    it('counts outcomes, never throws, and writes one batch summary', async () => {
      const provider = makeProvider({ scimEnabled: true });
      prisma.userIdentity.findUnique.mockResolvedValue({ scimManagedAt: new Date() });
      prisma.identityProviderGroupMember.findMany.mockResolvedValue([]);
      prisma.identityProviderRoleMapping.findMany
        .mockResolvedValueOnce([]) // u1 → fallback (applied)
        .mockRejectedValueOnce(new Error('boom')); // u2 → failed
      const summary = await service.resyncUsers(provider, ['u1', 'u2', 'u1'], { actorUserId: 'admin' });
      expect(summary).toMatchObject({ total: 3, applied: 1, failed: 0, unchanged: 1 });
      expect(securityEvents.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'ROLE_SYNC_BATCH_COMPLETED', actorType: 'USER' }));
    });

    it('resyncProvider is a no-op unless SCIM, role sync and GROUPS are all on', async () => {
      prisma.identityProvider.findUnique.mockResolvedValue(makeProvider({ scimEnabled: false }));
      expect(await service.resyncProvider('idp_1')).toMatchObject({ total: 0 });
      expect(prisma.userIdentity.findMany).not.toHaveBeenCalled();
    });

    it('a second resync during a run joins the first', async () => {
      prisma.identityProvider.findUnique.mockImplementation(() => new Promise((r) => setTimeout(() => r(makeProvider({ scimEnabled: true })), 20)));
      // `async` wraps the shared job in a fresh promise per call, so identity
      // is checked on the work, not the wrapper: one provider load, one run.
      await Promise.all([service.resyncProvider('idp_1'), service.resyncProvider('idp_1')]);
      expect(prisma.identityProvider.findUnique).toHaveBeenCalledTimes(1);
    });
  });
});
