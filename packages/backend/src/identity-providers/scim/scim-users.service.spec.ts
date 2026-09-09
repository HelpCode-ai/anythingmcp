import { ScimUsersService } from './scim-users.service';
import { ScimError } from './scim.errors';
import { SecurityEventService } from '../../audit/security-event.service';
import { PrismaService } from '../../common/prisma.service';

const ORG = 'org-1';
const provider = {
  id: 'idp-1',
  organizationId: ORG,
  type: 'ENTRA',
  isActive: true,
  scimEnabled: true,
  scimLastRequestAt: null,
  jitDefaultRole: 'VIEWER',
  roleSyncEnabled: true,
  roleSyncSource: 'GROUPS',
  roleSyncFallback: 'DENY_ALL',
  roleSyncDefaultRoleIds: [],
} as any;
const ctx = { baseUrl: 'https://mcp.example/api/scim/v2', ip: '1.2.3.4', userAgent: 'entra' };

const identity = (over: Record<string, unknown> = {}, user: Record<string, unknown> = {}) => ({
  id: 'ui-1',
  userId: 'u1',
  externalSubject: 'oid-1',
  scimManagedAt: new Date(),
  createdAt: new Date('2026-01-01'),
  user: {
    id: 'u1',
    email: 'anna@x.com',
    name: 'Anna',
    passwordHash: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    memberships: [{ organizationId: ORG, deactivatedAt: null }],
    ...user,
  },
  ...over,
});

describe('ScimUsersService', () => {
  let prisma: any;
  let events: any[];
  let lifecycle: any;
  let roleSync: any;
  let service: ScimUsersService;

  beforeEach(() => {
    events = [];
    prisma = {
      userIdentity: {
        findUnique: jest.fn(async () => null),
        findMany: jest.fn(async () => []),
        count: jest.fn(async () => 0),
        create: jest.fn(async () => ({})),
        update: jest.fn(async () => ({})),
      },
      user: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async () => ({ id: 'u-new' })),
        update: jest.fn(async () => ({})),
        delete: jest.fn(),
      },
      organizationMember: { create: jest.fn(async () => ({})) },
      securityEvent: { create: jest.fn(async (a: any) => { events.push(a.data); return a.data; }) },
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    lifecycle = {
      deactivateInOrganization: jest.fn(async () => ({ status: 'deactivated', keysDeactivated: 1 })),
      reactivateInOrganization: jest.fn(async () => ({ status: 'reactivated', role: 'VIEWER' })),
    };
    roleSync = { syncFromScim: jest.fn(async () => ({ applied: true, reason: 'fallback_deny_all' })) };
    service = new ScimUsersService(prisma, new SecurityEventService(prisma as unknown as PrismaService), lifecycle, roleSync);
  });

  const eventNames = () => events.map((e) => e.event);

  describe('create', () => {
    const body = {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      externalId: 'oid-new',
      userName: 'Anna.Rossi@X.com',
      active: true,
      name: { givenName: 'Anna', familyName: 'Rossi' },
      emails: [{ primary: true, type: 'work', value: 'Anna.Rossi@x.com' }],
      title: 'Engineer',
      'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { department: 'R&D' },
    };

    it('provisions user + membership + SCIM-managed identity with no password, then applies the fallback', async () => {
      // After create, `get` re-reads the identity.
      prisma.userIdentity.findUnique
        .mockResolvedValueOnce(null) // existing-identity check
        .mockResolvedValueOnce(identity({ userId: 'u-new', externalSubject: 'oid-new' }, { id: 'u-new', email: 'anna.rossi@x.com', name: 'Anna Rossi' }));
      const out = await service.create(provider, body, ctx);

      expect(prisma.user.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ email: 'anna.rossi@x.com', name: 'Anna Rossi', passwordHash: null, emailVerified: true, role: 'VIEWER', organizationId: ORG }),
      }));
      expect(prisma.organizationMember.create).toHaveBeenCalledWith({ data: { userId: 'u-new', organizationId: ORG, role: 'VIEWER' } });
      expect(prisma.userIdentity.create).toHaveBeenCalledWith({
        data: { userId: 'u-new', providerId: 'idp-1', externalSubject: 'oid-new', scimManagedAt: expect.any(Date) },
      });
      // A member with no role is UNRESTRICTED; the fallback must apply now.
      expect(roleSync.syncFromScim).toHaveBeenCalledWith(provider, 'u-new', expect.anything());
      expect(lifecycle.deactivateInOrganization).not.toHaveBeenCalled();
      expect(eventNames()).toEqual(['SCIM_USER_PROVISIONED']);
      expect(JSON.stringify(events)).not.toContain('[REDACTED]');
      expect(out).toMatchObject({ id: 'u-new', externalId: 'oid-new', userName: 'anna.rossi@x.com', active: true });
      expect(out.meta.location).toBe('https://mcp.example/api/scim/v2/Users/u-new');
    });

    it('requires externalId', async () => {
      await expect(service.create(provider, { ...body, externalId: undefined }, ctx)).rejects.toMatchObject({ status: 400 });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('answers 409 uniqueness when the identity already exists', async () => {
      prisma.userIdentity.findUnique.mockResolvedValue({ id: 'ui-x' });
      await expect(service.create(provider, body, ctx)).rejects.toMatchObject({ status: 409 });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    // The same anti-takeover rule as JIT: a directory never claims a local account.
    it('refuses to adopt an existing unlinked local account', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'local' });
      const err = await service.create(provider, body, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(ScimError);
      expect(err.status).toBe(409);
      expect(JSON.stringify(err.getResponse())).toContain('not linked to this identity provider');
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('deactivates immediately when created with active:false', async () => {
      prisma.userIdentity.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(identity({ userId: 'u-new' }, { id: 'u-new', memberships: [{ organizationId: ORG, deactivatedAt: new Date() }] }));
      const out = await service.create(provider, { ...body, active: 'False' }, ctx);
      expect(lifecycle.deactivateInOrganization).toHaveBeenCalledWith('u-new', ORG, expect.objectContaining({ reason: 'scim', providerId: 'idp-1' }));
      expect(out.active).toBe(false);
    });
  });

  describe('patch', () => {
    const patch = (ops: unknown[]) => ({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: ops });

    it('active:"False" deprovisions through the lifecycle primitive, once', async () => {
      prisma.userIdentity.findUnique
        .mockResolvedValueOnce(identity())
        .mockResolvedValueOnce(identity({}, { memberships: [{ organizationId: ORG, deactivatedAt: new Date() }] }));
      const out = await service.patch(provider, 'u1', patch([{ op: 'Replace', path: 'active', value: 'False' }]), ctx);
      expect(lifecycle.deactivateInOrganization).toHaveBeenCalledWith('u1', ORG, expect.objectContaining({ reason: 'scim' }));
      expect(eventNames()).toEqual(['SCIM_USER_DEPROVISIONED']);
      expect(out.active).toBe(false);

      // Already inactive → no second lifecycle call.
      lifecycle.deactivateInOrganization.mockClear();
      prisma.userIdentity.findUnique.mockResolvedValue(identity({}, { memberships: [{ organizationId: ORG, deactivatedAt: new Date() }] }));
      await service.patch(provider, 'u1', patch([{ op: 'replace', path: 'active', value: false }]), ctx);
      expect(lifecycle.deactivateInOrganization).not.toHaveBeenCalled();
    });

    it('active:true reactivates and re-runs the role sync', async () => {
      prisma.userIdentity.findUnique
        .mockResolvedValueOnce(identity({}, { memberships: [{ organizationId: ORG, deactivatedAt: new Date() }] }))
        .mockResolvedValueOnce(identity());
      await service.patch(provider, 'u1', patch([{ op: 'replace', value: { active: true } }]), ctx);
      expect(lifecycle.reactivateInOrganization).toHaveBeenCalled();
      expect(roleSync.syncFromScim).toHaveBeenCalledWith(provider, 'u1', expect.anything());
      expect(eventNames()).toEqual(['SCIM_USER_REACTIVATED']);
    });

    // The membership is the workspace's one way back in; Entra is told loudly.
    it('surfaces the last-admin outcome as a 409 after revoking sessions and keys', async () => {
      lifecycle.deactivateInOrganization.mockResolvedValue({ status: 'last_admin_retained', keysDeactivated: 2 });
      prisma.userIdentity.findUnique.mockResolvedValue(identity());
      await expect(service.patch(provider, 'u1', patch([{ op: 'replace', path: 'active', value: false }]), ctx)).rejects.toMatchObject({ status: 409 });
      expect(events[0]).toMatchObject({ event: 'SCIM_USER_DEPROVISIONED', metadata: expect.objectContaining({ outcome: 'last_admin_retained' }) });
    });

    it('updates the name from partial name ops and ignores unmapped attributes', async () => {
      prisma.userIdentity.findUnique.mockResolvedValue(identity());
      await service.patch(provider, 'u1', patch([
        { op: 'Replace', path: 'name.familyName', value: 'Bianchi' },
        { op: 'Replace', path: 'title', value: 'CTO' },
        { op: 'Add', path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department', value: 'Ops' },
      ]), ctx);
      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { name: 'Bianchi' } });
      expect(eventNames()).toEqual(['SCIM_USER_UPDATED']);
    });

    // Entra's stock mapping for a non-gallery app sends `mailNickname` as
    // externalId, and it packs every attribute into a single PatchOp. Refusing
    // the operation used to 400 the whole request, throwing away the name, the
    // department and `active` — while Entra's provision-on-demand view still
    // showed four green ticks. Keep our anchor, apply the rest, say so.
    it('ignores a mismatched externalId instead of failing the whole patch', async () => {
      prisma.userIdentity.findUnique.mockResolvedValue(identity());
      await service.patch(provider, 'u1', patch([
        { op: 'Replace', path: 'externalId', value: 'mmr' },
        { op: 'Replace', path: 'displayName', value: 'Morelli Matteo' },
      ]), ctx);

      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { name: 'Morelli Matteo' } });
      expect(prisma.userIdentity.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ externalSubject: 'mmr' }) }),
      );
      expect(events[events.length - 1]).toMatchObject({
        event: 'SCIM_USER_UPDATED',
        metadata: expect.objectContaining({ externalIdIgnored: 'mmr' }),
      });
    });

    it('does not flag an externalId that matches the anchor', async () => {
      prisma.userIdentity.findUnique.mockResolvedValue(identity());
      await service.patch(provider, 'u1', patch([
        { op: 'Replace', path: 'externalId', value: 'oid-1' },
        { op: 'Replace', path: 'displayName', value: 'A' },
      ]), ctx);
      expect(events[events.length - 1].metadata).not.toHaveProperty('externalIdIgnored');
    });

    it('marks an SSO-created identity as SCIM-managed on first touch', async () => {
      prisma.userIdentity.findUnique.mockResolvedValue(identity({ scimManagedAt: null }));
      await service.patch(provider, 'u1', patch([{ op: 'replace', path: 'displayName', value: 'A' }]), ctx);
      expect(prisma.userIdentity.update).toHaveBeenCalledWith({ where: { id: 'ui-1' }, data: { scimManagedAt: expect.any(Date) } });
    });

    describe('email rule', () => {
      const emailOp = patch([{ op: 'Replace', path: 'emails[type eq "work"].value', value: 'New@x.com' }]);

      it('applies to a provider-owned, single-org account with an unclaimed address', async () => {
        prisma.userIdentity.findUnique.mockResolvedValue(identity());
        await service.patch(provider, 'u1', emailOp, ctx);
        expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { email: 'new@x.com' } });
      });

      it.each([
        ['has_password', { passwordHash: 'x' }, null],
        ['multi_org', { memberships: [{ organizationId: ORG, deactivatedAt: null }, { organizationId: 'org-2', deactivatedAt: null }] }, null],
        ['conflict', {}, { id: 'someone' }],
      ])('is skipped (%s) but the request still succeeds', async (reason, userOver, owner) => {
        prisma.userIdentity.findUnique.mockResolvedValue(identity({}, userOver as any));
        prisma.user.findUnique.mockResolvedValue(owner);
        await service.patch(provider, 'u1', emailOp, ctx);
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(events[0].metadata.emailChangeSkipped).toBe(reason);
      });

      it('a deactivation in the same request is never blocked by an email conflict', async () => {
        prisma.userIdentity.findUnique.mockResolvedValue(identity({}, { passwordHash: 'x' }));
        await service.patch(provider, 'u1', patch([
          { op: 'replace', path: 'userName', value: 'new@x.com' },
          { op: 'replace', path: 'active', value: false },
        ]), ctx);
        expect(lifecycle.deactivateInOrganization).toHaveBeenCalled();
      });
    });
  });

  describe('remove (DELETE)', () => {
    it('deprovisions and keeps the row', async () => {
      prisma.userIdentity.findUnique.mockResolvedValue(identity());
      await service.remove(provider, 'u1', ctx);
      expect(lifecycle.deactivateInOrganization).toHaveBeenCalled();
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it('is idempotent on an already inactive user', async () => {
      prisma.userIdentity.findUnique.mockResolvedValue(identity({}, { memberships: [{ organizationId: ORG, deactivatedAt: new Date() }] }));
      await service.remove(provider, 'u1', ctx);
      expect(lifecycle.deactivateInOrganization).not.toHaveBeenCalled();
    });
  });

  describe('scope', () => {
    it('404s a user with no identity at this provider', async () => {
      prisma.userIdentity.findUnique.mockResolvedValue(null);
      await expect(service.get(provider, 'other', ctx)).rejects.toMatchObject({ status: 404 });
      expect(prisma.userIdentity.findUnique).toHaveBeenCalledWith(expect.objectContaining({
        where: { userId_providerId: { userId: 'other', providerId: 'idp-1' } },
      }));
    });

    it('filters by lower-cased email within the provider', async () => {
      await service.list(provider, { attr: 'userName', value: 'Anna@X.com' }, { startIndex: 1, count: 100 }, ctx);
      expect(prisma.userIdentity.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { providerId: 'idp-1', user: { email: 'anna@x.com' } },
      }));
    });

    it('returns an empty ListResponse for a miss (Entra Test Connection)', async () => {
      const out = await service.list(provider, { attr: 'userName', value: 'nobody' }, { startIndex: 1, count: 100 }, ctx);
      expect(out).toEqual(expect.objectContaining({ totalResults: 0, itemsPerPage: 0, Resources: [] }));
    });
  });
});
