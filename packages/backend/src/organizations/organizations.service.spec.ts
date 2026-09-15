import { ForbiddenException } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { LastAdminConflictException } from './last-admin.exception';
import { SecurityEventService } from '../audit/security-event.service';
import { PrismaService } from '../common/prisma.service';

const ORG = 'org-1';

describe('OrganizationsService', () => {
  let prisma: any;
  let events: any[];
  let service: OrganizationsService;
  const ctx = { actorUserId: 'admin-1', ip: '127.0.0.1', userAgent: 'jest' };

  beforeEach(() => {
    events = [];
    prisma = {
      organizationMember: {
        findUnique: jest.fn(),
        findMany: jest.fn(async () => []),
        findFirst: jest.fn(async () => null),
        count: jest.fn(async () => 0),
        update: jest.fn(async () => ({})),
        delete: jest.fn(async () => ({})),
      },
      user: {
        findUnique: jest.fn(async () => ({ organizationId: ORG })),
        update: jest.fn(async () => ({})),
      },
      securityEvent: {
        create: jest.fn(async (args: any) => {
          events.push(args.data);
          return args.data;
        }),
      },
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    service = new OrganizationsService(
      prisma,
      new SecurityEventService(prisma as unknown as PrismaService),
    );
  });

  describe('assertNotLastAdmin', () => {
    it('is a no-op for a non-admin or a deactivated admin', async () => {
      prisma.organizationMember.findUnique.mockResolvedValueOnce({ role: 'EDITOR', deactivatedAt: null });
      await expect(service.assertNotLastAdmin(ORG, 'u1')).resolves.toBeUndefined();
      prisma.organizationMember.findUnique.mockResolvedValueOnce({ role: 'ADMIN', deactivatedAt: new Date() });
      await expect(service.assertNotLastAdmin(ORG, 'u1')).resolves.toBeUndefined();
      expect(prisma.organizationMember.count).not.toHaveBeenCalled();
    });

    it('throws when no other ACTIVE admin exists', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({ role: 'ADMIN', deactivatedAt: null });
      prisma.organizationMember.count.mockResolvedValue(0);
      await expect(service.assertNotLastAdmin(ORG, 'u1')).rejects.toBeInstanceOf(LastAdminConflictException);
      // A deactivated co-admin must not count as "another admin".
      expect(prisma.organizationMember.count).toHaveBeenCalledWith({
        where: { organizationId: ORG, role: 'ADMIN', deactivatedAt: null, userId: { not: 'u1' } },
      });
    });

    it('passes when another active admin exists, and honours a tx client', async () => {
      const tx = {
        organizationMember: {
          findUnique: jest.fn(async () => ({ role: 'ADMIN', deactivatedAt: null })),
          count: jest.fn(async () => 1),
        },
      };
      await expect(service.assertNotLastAdmin(ORG, 'u1', tx as any)).resolves.toBeUndefined();
      expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('revokeMemberSessions', () => {
    beforeEach(() => {
      prisma.mcpApiKey = { updateMany: jest.fn(async () => ({ count: 2 })) };
    });

    it('returns null for a non-member and writes nothing', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(null);
      expect(await service.revokeMemberSessions('u1', ORG, {}, ctx)).toBeNull();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    it('moves ONLY the watermark and leaves API keys alone by default', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({ role: 'EDITOR', deactivatedAt: null });
      prisma.organizationMember.count.mockResolvedValue(1);

      const result = await service.revokeMemberSessions('u1', ORG, {}, ctx);

      expect(result).toEqual({ apiKeysRevoked: 0, crossOrgMemberships: 1 });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { sessionsValidFrom: expect.any(Date) },
      });
      expect(prisma.mcpApiKey.updateMany).not.toHaveBeenCalled();
      expect(events.map((e) => e.event)).toEqual(['SESSIONS_REVOKED']);
      expect(events[0].targetUserId).toBe('u1');
      expect(events[0].metadata).toMatchObject({
        reason: 'admin_force_reauth',
        self: false,
        keysDeactivated: 0,
        crossOrgMemberships: 1,
      });
    });

    it('deactivates the member\'s keys IN THIS WORKSPACE when asked', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({ role: 'EDITOR', deactivatedAt: null });

      const result = await service.revokeMemberSessions('u1', ORG, { revokeApiKeys: true }, ctx);

      expect(result).toEqual({ apiKeysRevoked: 2, crossOrgMemberships: 0 });
      // Org-scoped, like deactivation: keys used in other workspaces survive.
      expect(prisma.mcpApiKey.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', organizationId: ORG, isActive: true },
        data: { isActive: false },
      });
    });

    it('allows an admin to act on themselves and records it', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({ role: 'ADMIN', deactivatedAt: null });
      const result = await service.revokeMemberSessions('admin-1', ORG, {}, ctx);
      expect(result).not.toBeNull();
      expect(events[0].metadata).toMatchObject({ self: true });
    });
  });

  describe('revokeWorkspaceSessions', () => {
    beforeEach(() => {
      prisma.user.updateMany = jest.fn(async () => ({ count: 5 }));
      prisma.mcpApiKey = { updateMany: jest.fn(async () => ({ count: 3 })) };
      prisma.organizationMember.findMany.mockResolvedValue([{ userId: 'u2' }, { userId: 'u3' }]);
    });

    it('raises every active member\'s watermark in one write, including the actor', async () => {
      const result = await service.revokeWorkspaceSessions(ORG, {}, ctx);

      expect(result).toEqual({ membersAffected: 5, crossOrgMembersAffected: 2, apiKeysRevoked: 0 });
      expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { memberships: { some: { organizationId: ORG, deactivatedAt: null } } },
        data: { sessionsValidFrom: expect.any(Date) },
      });
      expect(prisma.mcpApiKey.updateMany).not.toHaveBeenCalled();
      // ONE summary row, not one per member.
      expect(events.map((e) => e.event)).toEqual(['WORKSPACE_SESSIONS_REVOKED']);
      expect(events[0].targetUserId).toBeNull();
      expect(events[0].metadata).toEqual({
        reason: 'admin_force_reauth',
        organizationId: ORG,
        excludeSelf: false,
        membersAffected: 5,
        crossOrgMembersAffected: 2,
        keysDeactivated: 0,
      });
    });

    it('spares the acting admin when excludeSelf is set, for keys too', async () => {
      const result = await service.revokeWorkspaceSessions(ORG, { excludeSelf: true, revokeApiKeys: true }, ctx);

      expect(result).toEqual({ membersAffected: 5, crossOrgMembersAffected: 2, apiKeysRevoked: 3 });
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: {
          memberships: { some: { organizationId: ORG, deactivatedAt: null, userId: { not: 'admin-1' } } },
        },
        data: { sessionsValidFrom: expect.any(Date) },
      });
      expect(prisma.mcpApiKey.updateMany).toHaveBeenCalledWith({
        where: { organizationId: ORG, isActive: true, userId: { not: 'admin-1' } },
        data: { isActive: false },
      });
      expect(events[0].metadata).toMatchObject({ excludeSelf: true, keysDeactivated: 3 });
    });

    it('counts cross-workspace members from the same member set it revoked', async () => {
      await service.revokeWorkspaceSessions(ORG, {}, ctx);
      expect(prisma.organizationMember.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: { not: ORG },
          deactivatedAt: null,
          user: { memberships: { some: { organizationId: ORG, deactivatedAt: null } } },
        },
        select: { userId: true },
        distinct: ['userId'],
      });
    });
  });

  describe('updateMemberRole', () => {
    it('returns null for a non-member', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(null);
      expect(await service.updateMemberRole('u1', ORG, 'VIEWER', ctx)).toBeNull();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('writes nothing when the role is unchanged', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({ role: 'EDITOR', deactivatedAt: null });
      expect(await service.updateMemberRole('u1', ORG, 'EDITOR', ctx)).toEqual({
        from: 'EDITOR',
        to: 'EDITOR',
        sessionsRevoked: false,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    // The defect this fixes: only the users.role cache was written, so a
    // demoted admin kept membership.role = ADMIN and unrestricted MCP tools.
    it('a demotion writes the MEMBERSHIP, refreshes the cache and revokes sessions', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({ role: 'ADMIN', deactivatedAt: null });
      prisma.organizationMember.count.mockResolvedValue(1); // another admin exists
      const result = await service.updateMemberRole('u1', ORG, 'VIEWER', ctx);
      expect(result).toEqual({ from: 'ADMIN', to: 'VIEWER', sessionsRevoked: true });
      expect(prisma.organizationMember.update).toHaveBeenCalledWith({
        where: { userId_organizationId: { userId: 'u1', organizationId: ORG } },
        data: { role: 'VIEWER' },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { role: 'VIEWER', sessionsValidFrom: expect.any(Date) },
      });
      expect(events.map((e) => e.event)).toEqual(['ROLE_CHANGED', 'SESSIONS_REVOKED']);
      expect(events[0].metadata).toEqual({ from: 'ADMIN', to: 'VIEWER', via: 'admin' });
    });

    it('a promotion revokes nothing', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({ role: 'VIEWER', deactivatedAt: null });
      const result = await service.updateMemberRole('u1', ORG, 'ADMIN', ctx);
      expect(result?.sessionsRevoked).toBe(false);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { role: 'ADMIN' },
      });
      expect(events.map((e) => e.event)).toEqual(['ROLE_CHANGED']);
    });

    it('refreshes the cache only when this is the active organization', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({ role: 'VIEWER', deactivatedAt: null });
      prisma.user.findUnique.mockResolvedValue({ organizationId: 'org-other' });
      await service.updateMemberRole('u1', ORG, 'EDITOR', ctx);
      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: {} });
    });

    it('refuses to demote the last active admin', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({ role: 'ADMIN', deactivatedAt: null });
      prisma.organizationMember.count.mockResolvedValue(0);
      await expect(service.updateMemberRole('u1', ORG, 'EDITOR', ctx)).rejects.toBeInstanceOf(
        LastAdminConflictException,
      );
      expect(prisma.organizationMember.update).not.toHaveBeenCalled();
    });
  });

  describe('switchOrg / listUserOrgs', () => {
    it('refuses to switch into a deactivated membership', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({ role: 'VIEWER', deactivatedAt: new Date() });
      await expect(service.switchOrg('u1', ORG)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('lists only active memberships', async () => {
      await service.listUserOrgs('u1');
      expect(prisma.organizationMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'u1', deactivatedAt: null } }),
      );
    });
  });

  describe('removeMember', () => {
    it('points the cache at nothing when no active membership remains', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({ role: 'VIEWER', deactivatedAt: null });
      prisma.user.findUnique.mockResolvedValue({ organizationId: ORG });
      prisma.organizationMember.findFirst.mockResolvedValue(null);
      await service.removeMember('u1', ORG);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { organizationId: null },
      });
    });
  });
});
