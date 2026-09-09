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
