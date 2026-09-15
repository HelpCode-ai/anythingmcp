import { UserLifecycleService } from './user-lifecycle.service';
import { LastAdminConflictException } from '../organizations/last-admin.exception';
import { SecurityEventService } from '../audit/security-event.service';
import { PrismaService } from '../common/prisma.service';

const ORG = 'org-1';
const USER = 'u1';

/**
 * Deactivation is the one action that must close every access path at once.
 * These tests pin each write the primitive makes, and — through a REAL
 * SecurityEventService over a fake `securityEvent.create` — that the audit
 * rows say what happened without the redactor blanking the key ids.
 */
describe('UserLifecycleService', () => {
  let prisma: any;
  let organizations: any;
  let events: any[];
  let service: UserLifecycleService;

  const admin = { reason: 'admin' as const, actor: { type: 'USER' as const, userId: 'admin-1' } };
  const scim = { reason: 'scim' as const, actor: { type: 'SYSTEM' as const }, providerId: 'idp-1' };

  beforeEach(() => {
    events = [];
    prisma = {
      organizationMember: {
        findUnique: jest.fn(async () => ({ role: 'VIEWER', deactivatedAt: null })),
        update: jest.fn(async () => ({})),
        findFirst: jest.fn(async () => null),
      },
      mcpApiKey: {
        findMany: jest.fn(async () => [{ id: 'k1' }, { id: 'k2' }]),
        updateMany: jest.fn(async () => ({ count: 2 })),
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
    organizations = { assertNotLastAdmin: jest.fn(async () => undefined) };
    service = new UserLifecycleService(
      prisma,
      organizations,
      new SecurityEventService(prisma as unknown as PrismaService),
    );
  });

  const eventNames = () => events.map((e) => e.event);

  it('returns not_a_member and writes nothing', async () => {
    prisma.organizationMember.findUnique.mockResolvedValue(null);
    expect(await service.deactivateInOrganization(USER, ORG, admin)).toEqual({ status: 'not_a_member' });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('is idempotent for an already inactive member', async () => {
    prisma.organizationMember.findUnique.mockResolvedValue({ role: 'VIEWER', deactivatedAt: new Date() });
    expect(await service.deactivateInOrganization(USER, ORG, admin)).toEqual({ status: 'already_inactive' });
    expect(prisma.mcpApiKey.updateMany).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('closes every path: membership, org-scoped keys, sessions, active-org cache', async () => {
    const result = await service.deactivateInOrganization(USER, ORG, admin);

    expect(result).toMatchObject({ status: 'deactivated', keysDeactivated: 2, previousRole: 'VIEWER' });
    expect(prisma.organizationMember.update).toHaveBeenCalledWith({
      where: { userId_organizationId: { userId: USER, organizationId: ORG } },
      data: { deactivatedAt: expect.any(Date) },
    });
    // Keys are scoped to THIS organization.
    expect(prisma.mcpApiKey.findMany).toHaveBeenCalledWith({
      where: { userId: USER, organizationId: ORG, isActive: true },
      select: { id: true },
    });
    expect(prisma.mcpApiKey.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['k1', 'k2'] } },
      data: { isActive: false },
    });
    // Sessions revoked and, since this was the active org, the cache cleared.
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER },
      data: { sessionsValidFrom: expect.any(Date), organizationId: null },
    });
    expect(eventNames()).toEqual(['USER_DEACTIVATED', 'SESSIONS_REVOKED', 'API_KEY_DEACTIVATED']);
  });

  it('repoints the active org to the oldest other ACTIVE membership', async () => {
    prisma.organizationMember.findFirst.mockResolvedValue({ organizationId: 'org-2', role: 'EDITOR' });
    const result = await service.deactivateInOrganization(USER, ORG, admin);
    expect(result).toMatchObject({ activeOrgRepointedTo: 'org-2' });
    expect(prisma.organizationMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER, deactivatedAt: null, organizationId: { not: ORG } },
      }),
    );
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER },
      data: { sessionsValidFrom: expect.any(Date), organizationId: 'org-2', role: 'EDITOR' },
    });
  });

  it('leaves the active org alone when it is a different workspace', async () => {
    prisma.user.findUnique.mockResolvedValue({ organizationId: 'org-9' });
    await service.deactivateInOrganization(USER, ORG, admin);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER },
      data: { sessionsValidFrom: expect.any(Date) },
    });
  });

  // The redactor blanks any metadata key that looks like "api_key". The key
  // ids are the one fact an investigation wants, so they must survive.
  it('audits the deactivated key ids without redaction', async () => {
    await service.deactivateInOrganization(USER, ORG, admin);
    const keyEvent = events.find((e) => e.event === 'API_KEY_DEACTIVATED');
    expect(keyEvent.metadata).toEqual({ reason: 'deactivation', keyCount: 2, keyIds: ['k1', 'k2'] });
    expect(JSON.stringify(events)).not.toContain('[REDACTED]');
  });

  it('skips the key event when there were no active keys', async () => {
    prisma.mcpApiKey.findMany.mockResolvedValue([]);
    await service.deactivateInOrganization(USER, ORG, admin);
    expect(prisma.mcpApiKey.updateMany).not.toHaveBeenCalled();
    expect(eventNames()).toEqual(['USER_DEACTIVATED', 'SESSIONS_REVOKED']);
  });

  describe('last admin', () => {
    beforeEach(() => {
      prisma.organizationMember.findUnique.mockResolvedValue({ role: 'ADMIN', deactivatedAt: null });
      organizations.assertNotLastAdmin.mockRejectedValue(new LastAdminConflictException(ORG));
    });

    it('refuses an admin-initiated deactivation before any write', async () => {
      await expect(service.deactivateInOrganization(USER, ORG, admin)).rejects.toBeInstanceOf(
        LastAdminConflictException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    // A directory push cannot be argued with: everything that grants ACCESS
    // goes, but the membership — the workspace's one way back in — stays.
    it('for SCIM revokes sessions and keys but keeps the membership active', async () => {
      const result = await service.deactivateInOrganization(USER, ORG, scim);
      expect(result).toEqual({ status: 'last_admin_retained', keysDeactivated: 2 });
      expect(prisma.organizationMember.update).not.toHaveBeenCalled();
      expect(prisma.mcpApiKey.updateMany).toHaveBeenCalled();
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER },
        data: { sessionsValidFrom: expect.any(Date) },
      });
      expect(eventNames()).toEqual([
        'LAST_ADMIN_PROTECTION_TRIGGERED',
        'SESSIONS_REVOKED',
        'API_KEY_DEACTIVATED',
      ]);
      expect(events[0].metadata).toEqual({ reason: 'scim', providerId: 'idp-1', action: 'deactivate' });
    });

    it('rethrows anything that is not the last-admin conflict', async () => {
      organizations.assertNotLastAdmin.mockRejectedValue(new Error('db down'));
      await expect(service.deactivateInOrganization(USER, ORG, scim)).rejects.toThrow('db down');
    });
  });

  describe('reactivateInOrganization', () => {
    it('returns not_a_member / already_active without writes', async () => {
      prisma.organizationMember.findUnique.mockResolvedValueOnce(null);
      expect(await service.reactivateInOrganization(USER, ORG, admin)).toEqual({ status: 'not_a_member' });
      prisma.organizationMember.findUnique.mockResolvedValueOnce({ role: 'VIEWER', deactivatedAt: null });
      expect(await service.reactivateInOrganization(USER, ORG, admin)).toEqual({ status: 'already_active' });
      expect(prisma.organizationMember.update).not.toHaveBeenCalled();
    });

    // What was cut on the way out is not silently re-armed on the way back.
    it('clears the flag, repoints a null active org, and restores nothing else', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({ role: 'EDITOR', deactivatedAt: new Date() });
      prisma.user.findUnique.mockResolvedValue({ organizationId: null });
      const result = await service.reactivateInOrganization(USER, ORG, scim);
      expect(result).toEqual({ status: 'reactivated', role: 'EDITOR' });
      expect(prisma.organizationMember.update).toHaveBeenCalledWith({
        where: { userId_organizationId: { userId: USER, organizationId: ORG } },
        data: { deactivatedAt: null },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER },
        data: { organizationId: ORG, role: 'EDITOR' },
      });
      expect(prisma.mcpApiKey.updateMany).not.toHaveBeenCalled();
      const updates = prisma.user.update.mock.calls.map((c: any[]) => c[0].data);
      expect(updates.some((d: any) => 'sessionsValidFrom' in d)).toBe(false);
      expect(eventNames()).toEqual(['USER_REACTIVATED']);
    });

    it('does not touch the active org when the user already has one', async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({ role: 'EDITOR', deactivatedAt: new Date() });
      prisma.user.findUnique.mockResolvedValue({ organizationId: 'org-2' });
      await service.reactivateInOrganization(USER, ORG, admin);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
});
