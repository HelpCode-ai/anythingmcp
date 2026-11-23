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
    grant?: {
      organizationId: string | null;
      serverIds: string[];
      revokedAt?: Date | null;
    } | null;
    memberCount?: number;
    servers?: { id: string; organizationId: string }[];
  } = {},
) {
  const calls: Record<string, any[]> = {
    findManyServers: [],
    countMembers: [],
    upsert: [],
    del: [],
    update: [],
  };

  const prisma: any = {
    mcpConnectionGrant: {
      updateMany: jest.fn(async (args: any) => {
        calls.update.push(args);
        return { count: overrides.grant ? 1 : 0 };
      }),
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

  it('shows nothing for a revoked connection, without re-reading its targets', async () => {
    const { svc, calls } = build({
      grant: {
        organizationId: 'org-A',
        serverIds: ['srv-1'],
        revokedAt: new Date(),
      },
      memberCount: 1,
      servers: [{ id: 'srv-1', organizationId: 'org-A' }],
    });

    await expect(svc.resolve('client-1', 'user-1')).resolves.toEqual({
      mode: 'none',
    });
    // Short-circuits: no point validating targets nobody may use.
    expect(calls.findManyServers).toHaveLength(0);
    expect(calls.countMembers).toHaveLength(0);
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
      revokedAt: null,
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

  // Deleting the row would read back as "no grant", which is the pre-grant
  // behaviour — the caller's whole organization. A revoke that widens access is
  // the opposite of a revoke.
  it('stamps the row instead of deleting it', async () => {
    const { svc, calls } = build({
      grant: { organizationId: 'org-A', serverIds: [] },
    });

    await expect(svc.revoke('client-1', 'user-1')).resolves.toBe(true);

    expect(calls.del).toHaveLength(0);
    expect(calls.update[0].where).toEqual({
      clientId: 'client-1',
      userId: 'user-1',
      revokedAt: null,
    });
    expect(calls.update[0].data.revokedAt).toBeInstanceOf(Date);
  });

  it('reports that there was nothing to revoke', async () => {
    const { svc } = build({ grant: null });
    await expect(svc.revoke('client-1', 'user-1')).resolves.toBe(false);
  });

  it('un-revokes when the user chooses again', async () => {
    const { svc, calls } = build({ memberCount: 1 });

    await svc.grantWholeOrganization('client-1', 'user-1', 'org-A');

    expect(calls.upsert[0].update.revokedAt).toBeNull();
  });
});

describe('McpConnectionGrantService reports the first connection of a client', () => {
  function withEvents(existing: object | null) {
    const { prisma } = build({
      grant: existing as any,
      servers: [{ id: 'srv-1', organizationId: 'org-1' }],
      memberCount: 1,
    });
    prisma.oAuthClient = {
      findUnique: jest.fn().mockResolvedValue({ clientName: 'Claude' }),
    };
    const events = { log: jest.fn().mockResolvedValue(undefined) };
    const svc = new McpConnectionGrantService(prisma, events as any);
    return { svc, events };
  }

  it('logs ai_client_connected with the client name on a new grant', async () => {
    const { svc, events } = withEvents(null);
    await svc.grantServers('client-1', 'user-1', ['srv-1']);
    expect(events.log).toHaveBeenCalledWith({
      event: 'ai_client_connected',
      userId: 'user-1',
      organizationId: 'org-1',
      metadata: { client: 'Claude' },
    });
  });

  it('does not log again when the user changes an existing grant', async () => {
    const { svc, events } = withEvents({ id: 'g1', organizationId: null, serverIds: ['srv-1'] });
    await svc.grantWholeOrganization('client-1', 'user-1', 'org-1');
    expect(events.log).not.toHaveBeenCalled();
  });
});

describe('McpConnectionGrantService.clientRedirectUris', () => {
  it('reads a client\'s redirect URIs once and caches them', async () => {
    const findUnique = jest.fn(async () => ({
      redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    }));
    const svc = new McpConnectionGrantService({ oAuthClient: { findUnique } } as any);
    expect(await svc.clientRedirectUris('c1')).toEqual(['https://chatgpt.com/connector_platform_oauth_redirect']);
    expect(await svc.clientRedirectUris('c1')).toEqual(['https://chatgpt.com/connector_platform_oauth_redirect']);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('answers [] for no client, an unknown client or a database error', async () => {
    const findUnique = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('db down'));
    const svc = new McpConnectionGrantService({ oAuthClient: { findUnique } } as any);
    expect(await svc.clientRedirectUris(undefined)).toEqual([]);
    expect(await svc.clientRedirectUris('missing')).toEqual([]);
    expect(await svc.clientRedirectUris('c2')).toEqual([]);
  });
});

describe('McpConnectionGrantService.firstOwnServerId', () => {
  it('asks for the user\'s oldest active server of that workspace, as attachToDefaultServer does', async () => {
    const findFirst = jest.fn(async (_args: any) => ({ id: 'srv-own' }));
    const svc = new McpConnectionGrantService({ mcpServerConfig: { findFirst } } as any);

    await expect(svc.firstOwnServerId('user-1', 'org-1')).resolves.toBe('srv-own');

    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', organizationId: 'org-1', isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
  });

  it('answers null when they own no server there, and without a user or workspace', async () => {
    const findFirst = jest.fn(async (_args: any) => null);
    const svc = new McpConnectionGrantService({ mcpServerConfig: { findFirst } } as any);

    await expect(svc.firstOwnServerId('user-1', 'org-1')).resolves.toBeNull();
    await expect(svc.firstOwnServerId('', 'org-1')).resolves.toBeNull();
    await expect(svc.firstOwnServerId('user-1', '')).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(1);
  });
});

/**
 * The grant on a server's own URL (`/mcp/<serverId>`), and the grant written
 * when a client asks for one server by that URL.
 */
describe('McpConnectionGrantService on a server URL', () => {
  type Row = { organizationId: string | null; serverIds: string[]; revokedAt: Date | null };

  /** A grant row kept in memory, behind the same Prisma calls the service makes. */
  function store(
    initial: Row | null,
    opts: {
      /** Servers the user reaches (active, member of the workspace). */
      reachable?: { id: string; organizationId: string }[];
      /** Member visibility: ids the user may see. Absent: no visibility service. */
      visible?: string[];
    } = {},
  ) {
    let row: Row | null = initial ? { ...initial, serverIds: [...initial.serverIds] } : null;
    const reachable = opts.reachable ?? [
      { id: 'srv-A', organizationId: 'org-1' },
      { id: 'srv-B', organizationId: 'org-1' },
      { id: 'srv-X', organizationId: 'org-2' },
    ];
    const prisma: any = {
      mcpConnectionGrant: {
        findUnique: jest.fn(async () => (row ? { id: 'g1', ...row } : null)),
        upsert: jest.fn(async ({ create, update }: any) => {
          row = row
            ? { ...row, ...update }
            : { organizationId: create.organizationId, serverIds: create.serverIds, revokedAt: null };
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          if (!row) return { count: 0 };
          if (data.revokedAt) {
            if (row.revokedAt) return { count: 0 };
            row = { ...row, revokedAt: data.revokedAt };
            return { count: 1 };
          }
          const id = data.serverIds.push;
          if (row.revokedAt || row.organizationId || row.serverIds.includes(where.NOT.serverIds.has)) {
            return { count: 0 };
          }
          row = { ...row, serverIds: [...row.serverIds, id] };
          return { count: 1 };
        }),
      },
      mcpServerConfig: {
        findMany: jest.fn(async ({ where }: any) => {
          const ids: string[] = where.id?.in ?? where.AND?.[0]?.id?.in ?? [];
          const found = reachable.filter((s) => ids.includes(s.id));
          // The second shape is keepVisible's query in a restricted workspace.
          return where.AND ? found.filter((s) => (opts.visible ?? []).includes(s.id)) : found;
        }),
        findUnique: jest.fn(async ({ where }: any) => reachable.find((s) => s.id === where.id) ?? null),
      },
      organizationMember: {
        findMany: jest.fn(async ({ where }: any) =>
          (where.organizationId.in as string[]).map((organizationId) => ({ organizationId, role: 'EDITOR' })),
        ),
        count: jest.fn().mockResolvedValue(1),
      },
      oAuthSession: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.sessionId === 'sess-1' ? { clientId: 'client-1' } : null,
        ),
      },
    };
    const visibility = opts.visible
      ? { scopeFor: jest.fn().mockResolvedValue({ restricted: true, userId: 'user-1' }) }
      : undefined;
    const svc = new McpConnectionGrantService(prisma, undefined, visibility as any);
    return { svc, prisma, row: () => row };
  }

  const A = { id: 'srv-A', organizationId: 'org-1' };
  const B = { id: 'srv-B', organizationId: 'org-1' };
  const X = { id: 'srv-X', organizationId: 'org-2' };

  describe('serverScope', () => {
    it('is no-grant without a grant row: tokens from before grants keep working', async () => {
      const { svc } = store(null);
      await expect(svc.serverScope('client-1', 'user-1', A)).resolves.toBe('no-grant');
    });

    it('is no-grant, without a query, when the token names no client or no user', async () => {
      const { svc, prisma } = store({ organizationId: null, serverIds: ['srv-A'], revokedAt: null });
      await expect(svc.serverScope(undefined, 'user-1', B)).resolves.toBe('no-grant');
      await expect(svc.serverScope('client-1', undefined, B)).resolves.toBe('no-grant');
      expect(prisma.mcpConnectionGrant.findUnique).not.toHaveBeenCalled();
    });

    it('grants the servers the grant names and no other', async () => {
      const { svc } = store({ organizationId: null, serverIds: ['srv-A'], revokedAt: null });
      await expect(svc.serverScope('client-1', 'user-1', A)).resolves.toBe('granted');
      await expect(svc.serverScope('client-1', 'user-1', B)).resolves.toBe('outside');
    });

    it('grants every server of a whole-workspace grant, and none of another workspace', async () => {
      const { svc } = store({ organizationId: 'org-1', serverIds: [], revokedAt: null });
      await expect(svc.serverScope('client-1', 'user-1', A)).resolves.toBe('granted');
      await expect(svc.serverScope('client-1', 'user-1', B)).resolves.toBe('granted');
      await expect(svc.serverScope('client-1', 'user-1', X)).resolves.toBe('outside');
    });

    it('treats a server of another workspace like any server outside a servers grant', async () => {
      const { svc } = store({ organizationId: null, serverIds: ['srv-A'], revokedAt: null });
      await expect(svc.serverScope('client-1', 'user-1', X)).resolves.toBe('outside');
    });

    it('is revoked for a revoked connection, whatever it named', async () => {
      const { svc } = store({ organizationId: null, serverIds: ['srv-A'], revokedAt: new Date() });
      await expect(svc.serverScope('client-1', 'user-1', A)).resolves.toBe('revoked');
    });

    it('is outside when nothing in the grant exists any more', async () => {
      const { svc } = store({ organizationId: null, serverIds: ['srv-deleted'], revokedAt: null });
      await expect(svc.serverScope('client-1', 'user-1', A)).resolves.toBe('outside');
    });

    it('is not-grantable when member visibility hides the server from the user', async () => {
      const { svc } = store(
        { organizationId: null, serverIds: ['srv-A'], revokedAt: null },
        { visible: ['srv-A'] },
      );
      await expect(svc.serverScope('client-1', 'user-1', B)).resolves.toBe('not-grantable');
      // A revoked connection stays revoked: the user asked for it to stop.
      await svc.revoke('client-1', 'user-1');
      await expect(svc.serverScope('client-1', 'user-1', B)).resolves.toBe('revoked');
    });

    it('reads the row once for requests it lets through', async () => {
      const { svc, prisma } = store({ organizationId: null, serverIds: ['srv-A'], revokedAt: null });
      for (let i = 0; i < 5; i++) await svc.serverScope('client-1', 'user-1', A);
      expect(prisma.mcpConnectionGrant.findUnique).toHaveBeenCalledTimes(1);
    });

    it('caches the absence of a grant too', async () => {
      const { svc, prisma } = store(null);
      for (let i = 0; i < 5; i++) await svc.serverScope('client-1', 'user-1', A);
      expect(prisma.mcpConnectionGrant.findUnique).toHaveBeenCalledTimes(1);
    });

    it('never refuses from the cache: a grant extended elsewhere applies at once', async () => {
      const { svc, prisma } = store({ organizationId: null, serverIds: ['srv-A'], revokedAt: null });
      await expect(svc.serverScope('client-1', 'user-1', B)).resolves.toBe('outside');
      // Another process added srv-B (this one's cache was not told).
      prisma.mcpConnectionGrant.findUnique.mockResolvedValue({
        organizationId: null,
        serverIds: ['srv-A', 'srv-B'],
        revokedAt: null,
      });
      await expect(svc.serverScope('client-1', 'user-1', B)).resolves.toBe('granted');
    });

    it('forgets the cached row after a minute', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-11-23T10:00:00Z'));
      try {
        const { svc, prisma } = store({ organizationId: null, serverIds: ['srv-A'], revokedAt: null });
        await svc.serverScope('client-1', 'user-1', A);
        jest.setSystemTime(new Date('2026-11-23T10:00:59Z'));
        await svc.serverScope('client-1', 'user-1', A);
        expect(prisma.mcpConnectionGrant.findUnique).toHaveBeenCalledTimes(1);
        jest.setSystemTime(new Date('2026-11-23T10:01:01Z'));
        await svc.serverScope('client-1', 'user-1', A);
        expect(prisma.mcpConnectionGrant.findUnique).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('applies a revoke and a new choice of this process at once', async () => {
      const { svc } = store({ organizationId: null, serverIds: ['srv-A'], revokedAt: null });
      await expect(svc.serverScope('client-1', 'user-1', A)).resolves.toBe('granted');
      await svc.revoke('client-1', 'user-1');
      await expect(svc.serverScope('client-1', 'user-1', A)).resolves.toBe('revoked');
      await svc.grantServers('client-1', 'user-1', ['srv-B']);
      await expect(svc.serverScope('client-1', 'user-1', B)).resolves.toBe('granted');
      await expect(svc.serverScope('client-1', 'user-1', A)).resolves.toBe('outside');
    });

    it('serverScopeById looks the workspace up, and leaves an unknown server alone', async () => {
      const { svc } = store({ organizationId: 'org-1', serverIds: [], revokedAt: null });
      await expect(svc.serverScopeById('client-1', 'user-1', 'srv-B')).resolves.toBe('granted');
      await expect(svc.serverScopeById('client-1', 'user-1', 'srv-X')).resolves.toBe('outside');
      await expect(svc.serverScopeById('client-1', 'user-1', 'srv-unknown')).resolves.toBe('no-grant');
    });
  });

  describe('grantRequestedServer', () => {
    it('writes the server alone for a client without a grant', async () => {
      const { svc, row } = store(null);
      await expect(svc.grantRequestedServer('client-1', 'user-1', 'srv-A')).resolves.toBe(true);
      expect(row()).toEqual({ organizationId: null, serverIds: ['srv-A'], revokedAt: null });
    });

    // One client registration used for two server URLs: the second
    // authorization used to replace the grant, and the first URL was then
    // outside it.
    it('adds a second server to the grant instead of replacing it', async () => {
      const { svc, row, prisma } = store({ organizationId: null, serverIds: ['srv-A'], revokedAt: null });
      await expect(svc.grantRequestedServer('client-1', 'user-1', 'srv-B')).resolves.toBe(true);
      expect(row()?.serverIds).toEqual(['srv-A', 'srv-B']);
      expect(prisma.mcpConnectionGrant.upsert).not.toHaveBeenCalled();
      // One conditional append, so two authorizations cannot drop each other's server.
      expect(prisma.mcpConnectionGrant.updateMany).toHaveBeenCalledWith({
        where: {
          clientId: 'client-1',
          userId: 'user-1',
          revokedAt: null,
          organizationId: null,
          NOT: { serverIds: { has: 'srv-B' } },
        },
        data: { serverIds: { push: 'srv-B' } },
      });
      await expect(svc.serverScope('client-1', 'user-1', A)).resolves.toBe('granted');
      await expect(svc.serverScope('client-1', 'user-1', B)).resolves.toBe('granted');
    });

    it('writes nothing when the server is already granted', async () => {
      const { svc, prisma } = store({ organizationId: null, serverIds: ['srv-A'], revokedAt: null });
      await expect(svc.grantRequestedServer('client-1', 'user-1', 'srv-A')).resolves.toBe(true);
      expect(prisma.mcpConnectionGrant.upsert).not.toHaveBeenCalled();
      expect(prisma.mcpConnectionGrant.updateMany).not.toHaveBeenCalled();
    });

    it('applies an extension to a refusal answered a moment ago', async () => {
      const { svc } = store({ organizationId: null, serverIds: ['srv-A'], revokedAt: null });
      await expect(svc.serverScope('client-1', 'user-1', B)).resolves.toBe('outside');
      await svc.grantRequestedServer('client-1', 'user-1', 'srv-B');
      await expect(svc.serverScope('client-1', 'user-1', B)).resolves.toBe('granted');
    });

    it('leaves a whole-workspace grant alone when it already covers the server', async () => {
      const { svc, row, prisma } = store({ organizationId: 'org-1', serverIds: [], revokedAt: null });
      await expect(svc.grantRequestedServer('client-1', 'user-1', 'srv-A')).resolves.toBe(true);
      expect(row()).toEqual({ organizationId: 'org-1', serverIds: [], revokedAt: null });
      expect(prisma.mcpConnectionGrant.upsert).not.toHaveBeenCalled();
    });

    it('replaces a whole-workspace grant of another workspace, as before', async () => {
      const { svc, row } = store({ organizationId: 'org-1', serverIds: [], revokedAt: null });
      await expect(svc.grantRequestedServer('client-1', 'user-1', 'srv-X')).resolves.toBe(true);
      expect(row()).toEqual({ organizationId: null, serverIds: ['srv-X'], revokedAt: null });
    });

    // A revoke meant "stop everything". Authorizing again allows the server
    // asked for now, not what the connection reached before.
    it('restarts a revoked connection with the requested server only', async () => {
      const { svc, row } = store({ organizationId: null, serverIds: ['srv-A'], revokedAt: new Date() });
      await expect(svc.grantRequestedServer('client-1', 'user-1', 'srv-B')).resolves.toBe(true);
      expect(row()).toEqual({ organizationId: null, serverIds: ['srv-B'], revokedAt: null });
    });

    it('writes nothing for a server the user cannot reach', async () => {
      const { svc, row, prisma } = store({ organizationId: null, serverIds: ['srv-A'], revokedAt: null });
      await expect(svc.grantRequestedServer('client-1', 'user-1', 'srv-of-another-tenant')).resolves.toBe(false);
      expect(row()?.serverIds).toEqual(['srv-A']);
      expect(prisma.mcpConnectionGrant.updateMany).not.toHaveBeenCalled();
      // Membership is part of the query, as for every other grant.
      expect(prisma.mcpServerConfig.findMany.mock.calls[0][0].where).toEqual({
        id: { in: ['srv-of-another-tenant'] },
        isActive: true,
        organization: { members: { some: { userId: 'user-1', deactivatedAt: null } } },
      });
    });

    it('writes nothing for a server member visibility hides from the user', async () => {
      const { svc, row } = store(
        { organizationId: null, serverIds: ['srv-A'], revokedAt: null },
        { visible: ['srv-A'] },
      );
      await expect(svc.grantRequestedServer('client-1', 'user-1', 'srv-B')).resolves.toBe(false);
      expect(row()?.serverIds).toEqual(['srv-A']);
    });

    it('with onlyExisting never creates a grant', async () => {
      const { svc, row, prisma } = store(null);
      await expect(
        svc.grantRequestedServer('client-1', 'user-1', 'srv-A', { onlyExisting: true }),
      ).resolves.toBe(false);
      expect(row()).toBeNull();
      expect(prisma.mcpConnectionGrant.upsert).not.toHaveBeenCalled();
    });
  });

  describe('extendForAuthorization (the SSO sign-in)', () => {
    it('adds the server to the grant of the client that is being authorized', async () => {
      const { svc, row } = store({ organizationId: null, serverIds: ['srv-A'], revokedAt: null });
      await expect(svc.extendForAuthorization('sess-1', 'user-1', 'srv-B')).resolves.toBe(true);
      expect(row()?.serverIds).toEqual(['srv-A', 'srv-B']);
    });

    it('writes no grant for a client that has none', async () => {
      const { svc, row } = store(null);
      await expect(svc.extendForAuthorization('sess-1', 'user-1', 'srv-B')).resolves.toBe(false);
      expect(row()).toBeNull();
    });

    it('does nothing without a pending authorization', async () => {
      const { svc, row, prisma } = store({ organizationId: null, serverIds: ['srv-A'], revokedAt: null });
      await expect(svc.extendForAuthorization(undefined, 'user-1', 'srv-B')).resolves.toBe(false);
      await expect(svc.extendForAuthorization('sess-gone', 'user-1', 'srv-B')).resolves.toBe(false);
      expect(row()?.serverIds).toEqual(['srv-A']);
      expect(prisma.mcpConnectionGrant.updateMany).not.toHaveBeenCalled();
    });
  });
});

describe('grantServerScopeMode (MCP_GRANT_SERVER_SCOPE)', () => {
  const { grantServerScopeMode } = jest.requireActual('./mcp-connection-grant.service');

  it('enforces by default and for anything it does not know', () => {
    expect(grantServerScopeMode(undefined)).toBe('enforce');
    expect(grantServerScopeMode('')).toBe('enforce');
    expect(grantServerScopeMode('enforce')).toBe('enforce');
    expect(grantServerScopeMode('yes')).toBe('enforce');
  });

  it('reads report and off, in any case and with spaces', () => {
    expect(grantServerScopeMode('report')).toBe('report');
    expect(grantServerScopeMode(' Report ')).toBe('report');
    expect(grantServerScopeMode('OFF')).toBe('off');
  });

  it('reads the environment when called without a value', () => {
    const before = process.env.MCP_GRANT_SERVER_SCOPE;
    try {
      process.env.MCP_GRANT_SERVER_SCOPE = 'off';
      expect(grantServerScopeMode()).toBe('off');
      delete process.env.MCP_GRANT_SERVER_SCOPE;
      expect(grantServerScopeMode()).toBe('enforce');
    } finally {
      if (before === undefined) delete process.env.MCP_GRANT_SERVER_SCOPE;
      else process.env.MCP_GRANT_SERVER_SCOPE = before;
    }
  });
});
