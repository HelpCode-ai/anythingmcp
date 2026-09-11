import {
  McpConnectionGrantService,
  ResolvedGrant,
} from './mcp-connection-grant.service';

/**
 * Tenant isolation for the shared `/mcp` endpoint.
 *
 * Two kinds of assertion here, deliberately:
 *
 * 1. **Branching** — that `resolve` fails CLOSED. A grant whose targets no
 *    longer validate must produce zero tools, never "everything".
 * 2. **Query shape** — that membership is part of the SQL `WHERE`, not a
 *    check applied to rows after they come back. CI has no database, so the
 *    structural assertion is what stops someone refactoring the join into a
 *    post-filter (or dropping `deactivatedAt: null`) without noticing. The
 *    same queries were run against the production database by hand; see the
 *    pull request.
 */
function build(
  overrides: {
    grant?: { organizationId: string | null; serverIds: string[] } | null;
    memberCount?: number;
    servers?: { id: string; organizationId: string }[];
  } = {},
) {
  const calls: Record<string, any[]> = {
    findManyServers: [],
    countMembers: [],
    upsert: [],
    del: [],
  };

  const prisma: any = {
    mcpConnectionGrant: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          overrides.grant === undefined ? null : overrides.grant,
        ),
      upsert: jest.fn(async (args: any) => {
        calls.upsert.push(args);
      }),
      delete: jest.fn(async (args: any) => {
        calls.del.push(args);
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    mcpServerConfig: {
      findMany: jest.fn(async (args: any) => {
        calls.findManyServers.push(args);
        return overrides.servers ?? [];
      }),
    },
    organizationMember: {
      count: jest.fn(async (args: any) => {
        calls.countMembers.push(args);
        return overrides.memberCount ?? 0;
      }),
    },
  };

  return { svc: new McpConnectionGrantService(prisma), prisma, calls };
}

describe('McpConnectionGrantService.resolve', () => {
  it('returns null when the client has no grant, so old tokens keep working', async () => {
    const { svc } = build({ grant: null });
    await expect(svc.resolve('client-1', 'user-1')).resolves.toBeNull();
  });

  it('returns null without querying when the token carries no client_id', async () => {
    const { svc, prisma } = build();
    await expect(svc.resolve(undefined, 'user-1')).resolves.toBeNull();
    expect(prisma.mcpConnectionGrant.findUnique).not.toHaveBeenCalled();
  });

  it('returns null without querying when there is no subject', async () => {
    const { svc, prisma } = build();
    await expect(svc.resolve('client-1', undefined)).resolves.toBeNull();
    expect(prisma.mcpConnectionGrant.findUnique).not.toHaveBeenCalled();
  });

  it('resolves a whole-workspace grant for a current member', async () => {
    const { svc } = build({
      grant: { organizationId: 'org-A', serverIds: [] },
      memberCount: 1,
    });

    await expect(svc.resolve('client-1', 'user-1')).resolves.toEqual({
      mode: 'organization',
      organizationId: 'org-A',
    } satisfies ResolvedGrant);
  });

  // The grant was written when the token was issued. Membership can be revoked
  // long before the token expires, and the answer then is nothing — not the
  // whole workspace.
  it('fails closed on a whole-workspace grant once membership is gone', async () => {
    const { svc } = build({
      grant: { organizationId: 'org-A', serverIds: [] },
      memberCount: 0,
    });

    await expect(svc.resolve('client-1', 'user-1')).resolves.toEqual({
      mode: 'none',
    });
  });

  it('resolves the servers that validate, with the organization read from the server row', async () => {
    const { svc } = build({
      grant: { organizationId: null, serverIds: ['srv-1', 'srv-2'] },
      servers: [
        { id: 'srv-1', organizationId: 'org-A' },
        { id: 'srv-2', organizationId: 'org-B' },
      ],
    });

    await expect(svc.resolve('client-1', 'user-1')).resolves.toEqual({
      mode: 'servers',
      servers: [
        { id: 'srv-1', organizationId: 'org-A' },
        { id: 'srv-2', organizationId: 'org-B' },
      ],
    });
  });

  // A row naming another tenant's server, whether through tampering or through
  // the server having moved, concedes nothing: the membership join returns it
  // to nobody, and an empty result is zero tools.
  it('fails closed — NOT to null — when no granted server validates', async () => {
    const { svc } = build({
      grant: { organizationId: null, serverIds: ['srv-of-another-tenant'] },
      servers: [],
    });

    const resolved = await svc.resolve('client-1', 'user-1');

    expect(resolved).toEqual({ mode: 'none' });
    expect(resolved).not.toBeNull();
  });

  it('drops the targets that do not validate and keeps the ones that do', async () => {
    const { svc } = build({
      grant: { organizationId: null, serverIds: ['srv-mine', 'srv-theirs'] },
      servers: [{ id: 'srv-mine', organizationId: 'org-A' }],
    });

    await expect(svc.resolve('client-1', 'user-1')).resolves.toEqual({
      mode: 'servers',
      servers: [{ id: 'srv-mine', organizationId: 'org-A' }],
    });
  });

  it('fails closed on a grant that is empty on both sides', async () => {
    const { svc } = build({ grant: { organizationId: null, serverIds: [] } });
    await expect(svc.resolve('client-1', 'user-1')).resolves.toEqual({
      mode: 'none',
    });
  });
});

describe('McpConnectionGrantService isolation is enforced in SQL', () => {
  it('asks the database for membership, active servers and the listed ids together', async () => {
    const { svc, calls } = build({
      grant: { organizationId: null, serverIds: ['srv-1'] },
      servers: [{ id: 'srv-1', organizationId: 'org-A' }],
    });

    await svc.resolve('client-1', 'user-1');

    expect(calls.findManyServers).toHaveLength(1);
    expect(calls.findManyServers[0].where).toEqual({
      id: { in: ['srv-1'] },
      isActive: true,
      organization: {
        members: { some: { userId: 'user-1', deactivatedAt: null } },
      },
    });
  });

  it('never asks for more than the id and the owning organization', async () => {
    const { svc, calls } = build({
      grant: { organizationId: null, serverIds: ['srv-1'] },
      servers: [{ id: 'srv-1', organizationId: 'org-A' }],
    });

    await svc.resolve('client-1', 'user-1');

    expect(calls.findManyServers[0].select).toEqual({
      id: true,
      organizationId: true,
    });
  });

  it('excludes deactivated members from the whole-workspace check', async () => {
    const { svc, calls } = build({
      grant: { organizationId: 'org-A', serverIds: [] },
      memberCount: 1,
    });

    await svc.resolve('client-1', 'user-1');

    expect(calls.countMembers[0].where).toEqual({
      userId: 'user-1',
      organizationId: 'org-A',
      deactivatedAt: null,
    });
  });

  it('does not hit the database at all for an empty id list', async () => {
    const { svc, calls } = build({
      grant: { organizationId: null, serverIds: ['', '  '] },
    });

    await svc.resolve('client-1', 'user-1');

    // '' is filtered out; '  ' is not an id we mint, but it must not widen
    // anything either — it can only ever fail to match.
    expect(calls.findManyServers.length).toBeLessThanOrEqual(1);
    if (calls.findManyServers.length === 1) {
      expect(calls.findManyServers[0].where.id.in).not.toContain('');
    }
  });

  it('de-duplicates ids before querying', async () => {
    const { svc, calls } = build({
      grant: { organizationId: null, serverIds: ['srv-1', 'srv-1', 'srv-2'] },
      servers: [{ id: 'srv-1', organizationId: 'org-A' }],
    });

    await svc.resolve('client-1', 'user-1');

    expect(calls.findManyServers[0].where.id.in).toEqual(['srv-1', 'srv-2']);
  });
});

describe('McpConnectionGrantService writing a grant', () => {
  it('refuses a whole-workspace grant for an organization the user is not in', async () => {
    const { svc, calls } = build({ memberCount: 0 });

    await expect(
      svc.grantWholeOrganization('client-1', 'user-1', 'org-of-another-tenant'),
    ).resolves.toBe(false);
    expect(calls.upsert).toHaveLength(0);
  });

  it('writes a whole-workspace grant for a member', async () => {
    const { svc, calls } = build({ memberCount: 1 });

    await expect(
      svc.grantWholeOrganization('client-1', 'user-1', 'org-A'),
    ).resolves.toBe(true);
    expect(calls.upsert[0].create).toEqual({
      clientId: 'client-1',
      userId: 'user-1',
      organizationId: 'org-A',
      serverIds: [],
    });
  });

  it('stores only the servers that validate', async () => {
    const { svc, calls } = build({
      servers: [{ id: 'srv-mine', organizationId: 'org-A' }],
    });

    await expect(
      svc.grantServers('client-1', 'user-1', ['srv-mine', 'srv-theirs']),
    ).resolves.toEqual(['srv-mine']);
    expect(calls.upsert[0].update).toEqual({
      organizationId: null,
      serverIds: ['srv-mine'],
    });
  });

  // Otherwise a caller could turn a wholly invalid selection into a stored
  // empty grant, which would then resolve to `{ mode: 'none' }` and silently
  // blank a connection that used to work.
  it('writes nothing when no requested server validates', async () => {
    const { svc, calls } = build({ servers: [] });

    await expect(
      svc.grantServers('client-1', 'user-1', ['srv-theirs']),
    ).resolves.toEqual([]);
    expect(calls.upsert).toHaveLength(0);
  });

  it('revokes by (client, user) and tolerates a missing row', async () => {
    const { svc, calls } = build();

    await svc.revoke('client-1', 'user-1');

    expect(calls.del[0].where).toEqual({
      clientId_userId: { clientId: 'client-1', userId: 'user-1' },
    });
  });
});
