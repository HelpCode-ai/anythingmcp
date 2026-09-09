import { ScimGroupsService } from './scim-groups.service';
import { SecurityEventService } from '../../audit/security-event.service';
import { PrismaService } from '../../common/prisma.service';

const ORG = 'org-1';
const provider = { id: 'idp-1', organizationId: ORG, roleSyncEnabled: true, roleSyncSource: 'GROUPS', roleSyncFallback: 'DENY_ALL', roleSyncDefaultRoleIds: [], scimEnabled: true } as any;
const ctx = { baseUrl: 'https://x/api/scim/v2' };
const group = (members: string[] = [], over: Record<string, unknown> = {}) => ({
  id: 'g-1', providerId: 'idp-1', externalId: 'oid-g1', displayName: 'GB_Test',
  createdAt: new Date(), updatedAt: new Date(),
  members: members.map((userId) => ({ userId, user: { email: `${userId}@x` } })),
  ...over,
});

describe('ScimGroupsService', () => {
  let prisma: any;
  let events: any[];
  let roleSync: any;
  let service: ScimGroupsService;

  beforeEach(() => {
    events = [];
    prisma = {
      identityProviderGroup: {
        findUnique: jest.fn(async () => null),
        findFirst: jest.fn(async () => group()),
        findMany: jest.fn(async () => []),
        count: jest.fn(async () => 0),
        create: jest.fn(async (a: any) => group(a.data.members?.create?.map((m: any) => m.userId) ?? [])),
        update: jest.fn(async () => ({})),
        delete: jest.fn(async () => ({})),
      },
      identityProviderGroupMember: { createMany: jest.fn(async () => ({})), deleteMany: jest.fn(async () => ({})) },
      identityProviderRoleMapping: { updateMany: jest.fn(async () => ({ count: 1 })) },
      userIdentity: { findMany: jest.fn(async ({ where }: any) => where.userId.in.filter((u: string) => u !== 'stranger').map((userId: string) => ({ userId }))) },
      securityEvent: { create: jest.fn(async (a: any) => { events.push(a.data); return a.data; }) },
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    roleSync = { resyncUsers: jest.fn(async () => ({})) };
    service = new ScimGroupsService(prisma, new SecurityEventService(prisma as unknown as PrismaService), roleSync);
  });

  const patch = (ops: unknown[]) => ({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: ops });

  it('creates a group, copies the name onto an existing mapping, and resyncs the members', async () => {
    const out = await service.create(provider, { displayName: 'GB_Test', externalId: 'oid-g1', members: [{ value: 'u1' }, { value: 'stranger' }] }, ctx);
    expect(prisma.identityProviderGroup.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ externalId: 'oid-g1', displayName: 'GB_Test', members: { create: [{ userId: 'u1' }] } }),
    }));
    expect(prisma.identityProviderRoleMapping.updateMany).toHaveBeenCalledWith({ where: { providerId: 'idp-1', externalId: 'oid-g1' }, data: { label: 'GB_Test' } });
    expect(roleSync.resyncUsers).toHaveBeenCalledWith(provider, ['u1'], expect.anything(), 'scim');
    // Out-of-scope ids are skipped and reported, never fatal.
    expect(events[0]).toMatchObject({ event: 'SCIM_GROUP_CREATED', metadata: expect.objectContaining({ skippedMemberIds: 'stranger' }) });
    expect(out).toMatchObject({ id: 'g-1', externalId: 'oid-g1', displayName: 'GB_Test' });
  });

  it('409s a duplicate externalId', async () => {
    prisma.identityProviderGroup.findUnique.mockResolvedValue({ id: 'g-1' });
    await expect(service.create(provider, { displayName: 'x', externalId: 'oid-g1' }, ctx)).rejects.toMatchObject({ status: 409 });
  });

  it('PATCH Add members (Entra shape) writes memberships and resyncs only the added users', async () => {
    prisma.identityProviderGroup.findFirst.mockResolvedValue(group(['u1']));
    await service.patch(provider, 'g-1', patch([{ op: 'Add', path: 'members', value: [{ $ref: null, value: 'u2' }, { value: 'u1' }] }]), ctx);
    expect(prisma.identityProviderGroupMember.createMany).toHaveBeenCalledWith({ data: [{ groupId: 'g-1', userId: 'u2' }], skipDuplicates: true });
    expect(roleSync.resyncUsers).toHaveBeenCalledWith(provider, ['u2'], expect.anything(), 'scim');
  });

  it('PATCH Remove in both forms removes memberships and resyncs', async () => {
    prisma.identityProviderGroup.findFirst.mockResolvedValue(group(['u1', 'u2']));
    await service.patch(provider, 'g-1', patch([
      { op: 'Remove', path: 'members[value eq "u1"]' },
      { op: 'Remove', path: 'members', value: [{ value: 'u2' }] },
    ]), ctx);
    expect(prisma.identityProviderGroupMember.deleteMany).toHaveBeenCalledWith({ where: { groupId: 'g-1', userId: { in: ['u1', 'u2'] } } });
    expect(roleSync.resyncUsers).toHaveBeenCalledWith(provider, ['u1', 'u2'], expect.anything(), 'scim');
  });

  it('PATCH replace displayName renames and copies the label', async () => {
    await service.patch(provider, 'g-1', patch([{ op: 'Replace', path: 'displayName', value: 'GB_Renamed' }]), ctx);
    expect(prisma.identityProviderGroup.update).toHaveBeenCalledWith({ where: { id: 'g-1' }, data: { displayName: 'GB_Renamed' } });
    expect(prisma.identityProviderRoleMapping.updateMany).toHaveBeenCalledWith({ where: { providerId: 'idp-1', externalId: 'oid-g1' }, data: { label: 'GB_Renamed' } });
    expect(roleSync.resyncUsers).not.toHaveBeenCalled();
  });

  it('PUT replaces the member set with a diff', async () => {
    prisma.identityProviderGroup.findFirst.mockResolvedValue(group(['u1', 'u2']));
    await service.replace(provider, 'g-1', { displayName: 'GB_Test', members: [{ value: 'u2' }, { value: 'u3' }] }, ctx);
    expect(prisma.identityProviderGroupMember.deleteMany).toHaveBeenCalledWith({ where: { groupId: 'g-1', userId: { in: ['u1'] } } });
    expect(prisma.identityProviderGroupMember.createMany).toHaveBeenCalledWith({ data: [{ groupId: 'g-1', userId: 'u3' }], skipDuplicates: true });
    expect(roleSync.resyncUsers).toHaveBeenCalledWith(provider, ['u1', 'u3'], expect.anything(), 'scim');
  });

  it('DELETE removes the group and resyncs every former member', async () => {
    prisma.identityProviderGroup.findFirst.mockResolvedValue(group(['u1', 'u2']));
    await service.remove(provider, 'g-1', ctx);
    expect(prisma.identityProviderGroup.delete).toHaveBeenCalledWith({ where: { id: 'g-1' } });
    expect(roleSync.resyncUsers).toHaveBeenCalledWith(provider, ['u1', 'u2'], expect.anything(), 'scim');
    expect(events.map((e) => e.event)).toContain('SCIM_GROUP_DELETED');
  });

  it('lists by case-insensitive displayName and honours excludedAttributes=members', async () => {
    prisma.identityProviderGroup.findMany.mockResolvedValue([group(['u1'])]);
    prisma.identityProviderGroup.count.mockResolvedValue(1);
    const out = await service.list(provider, { attr: 'displayName', value: 'gb_test' }, { startIndex: 1, count: 100 }, new Set(['members']), ctx);
    expect(prisma.identityProviderGroup.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { providerId: 'idp-1', displayName: { equals: 'gb_test', mode: 'insensitive' } },
    }));
    expect(out.Resources[0]).not.toHaveProperty('members');
  });

  it('404s a group of another provider', async () => {
    prisma.identityProviderGroup.findFirst.mockResolvedValue(null);
    await expect(service.get(provider, 'other', new Set(), ctx)).rejects.toMatchObject({ status: 404 });
  });
});
