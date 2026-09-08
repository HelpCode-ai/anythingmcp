import { SsoEnforcementService } from './sso-enforcement.service';

describe('SsoEnforcementService', () => {
  let prisma: any;
  let service: SsoEnforcementService;

  beforeEach(() => {
    prisma = {
      organizationMember: { findMany: jest.fn(async () => []) },
      identityProvider: { findMany: jest.fn(async () => []) },
    };
    service = new SsoEnforcementService(prisma);
  });

  it('allows password login when no organization enforces SSO', async () => {
    prisma.organizationMember.findMany.mockResolvedValue([{ organizationId: 'o1' }]);
    expect(await service.isPasswordLoginBlocked('u1')).toBe(false);
  });

  // The whole point of spanning memberships: `POST /organizations/switch` moves
  // a session between workspaces, so a password accepted in a permissive org
  // would otherwise be a way into an enforcing one.
  it('blocks password login when ANY of the user\'s organizations enforces it', async () => {
    prisma.organizationMember.findMany.mockResolvedValue([
      { organizationId: 'permissive' },
      { organizationId: 'strict' },
    ]);
    prisma.identityProvider.findMany.mockResolvedValue([{ organizationId: 'strict' }]);
    expect(await service.isPasswordLoginBlocked('u1')).toBe(true);
  });

  it('queries only the organizations the user actually belongs to', async () => {
    prisma.organizationMember.findMany.mockResolvedValue([{ organizationId: 'o1' }]);
    await service.enforcingOrganizations('u1');
    expect(prisma.identityProvider.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: { in: ['o1'] } }),
      }),
    );
  });

  // An inactive provider cannot be signed in through, so treating it as
  // enforcing would lock the workspace out with nothing to point at.
  it('ignores inactive providers', async () => {
    prisma.organizationMember.findMany.mockResolvedValue([{ organizationId: 'o1' }]);
    await service.enforcingOrganizations('u1');
    expect(prisma.identityProvider.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isActive: true, enforceSso: true }),
      }),
    );
  });

  it('does not query providers at all for a user with no memberships', async () => {
    expect(await service.isPasswordLoginBlocked('u1')).toBe(false);
    expect(prisma.identityProvider.findMany).not.toHaveBeenCalled();
  });
});
