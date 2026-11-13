import { OrgSettingsService } from './org-settings.service';
import {
  MEMBER_VISIBILITY_CACHE_TTL_MS,
  MEMBER_VISIBILITY_KEY,
  MemberVisibilityService,
  VisibilityScope,
  canSeeConnector,
  connectorWhere,
  parseMemberVisibilityMode,
  serverWhere,
  visibleTools,
} from './member-visibility.service';

const ORG = 'org1';
const member = (role = 'VIEWER', sub = 'u1', organizationId = ORG) => ({ sub, role, organizationId });

/**
 * A Prisma double that records every model it is asked for, so a test can
 * prove a path made no database call at all.
 */
function makePrisma(settings: Record<string, string> = {}) {
  const touched: string[] = [];
  const orgSettings = {
    findUnique: jest.fn(async ({ where }: any) => {
      const { organizationId, key } = where.organizationId_key;
      const value = settings[`${organizationId}:${key}`];
      return value === undefined ? null : { organizationId, key, value };
    }),
    upsert: jest.fn(async ({ where, update }: any) => {
      const { organizationId, key } = where.organizationId_key;
      settings[`${organizationId}:${key}`] = update.value;
    }),
  };
  const prisma = new Proxy({} as any, {
    get(_target, prop: string) {
      touched.push(prop);
      if (prop === 'orgSettings') return orgSettings;
      throw new Error(`unexpected prisma.${prop}`);
    },
  });
  return { prisma, touched, orgSettings, settings };
}

function make(opts: { settings?: Record<string, string>; allowed?: string[] | null | Error } = {}) {
  const db = makePrisma({ ...(opts.settings ?? {}) });
  const orgSettings = new OrgSettingsService(db.prisma, {} as any);
  const roles = {
    getAllowedToolIds: jest.fn(async () => {
      if (opts.allowed instanceof Error) throw opts.allowed;
      return opts.allowed === undefined ? null : opts.allowed;
    }),
  };
  const service = new MemberVisibilityService(orgSettings, roles as any);
  return { service, roles, ...db };
}

const restrictedSetting = { [`${ORG}:${MEMBER_VISIBILITY_KEY}`]: 'restricted' };

describe('parseMemberVisibilityMode', () => {
  it('reads only the exact value "restricted" as restricted', () => {
    expect(parseMemberVisibilityMode('restricted')).toBe('restricted');
  });

  it.each([null, undefined, '', 'open', 'Restricted', ' restricted', 'RESTRICTED', 'true', '{"mode":"restricted"}'])(
    'reads %p as open',
    (raw) => {
      expect(parseMemberVisibilityMode(raw as any)).toBe('open');
    },
  );
});

describe('MemberVisibilityService.scopeFor', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns unrestricted for an ADMIN before any database read or role lookup', async () => {
    const { service, touched, roles } = make({ settings: restrictedSetting, allowed: ['t1'] });
    await expect(service.scopeFor(member('ADMIN'))).resolves.toEqual({ restricted: false });
    expect(touched).toEqual([]);
    expect(roles.getAllowedToolIds).not.toHaveBeenCalled();
  });

  it('returns unrestricted for a member when the workspace has no setting', async () => {
    const { service, roles, orgSettings } = make({ allowed: ['t1'] });
    await expect(service.scopeFor(member('VIEWER'))).resolves.toEqual({ restricted: false });
    await expect(service.scopeFor(member('EDITOR', 'u2'))).resolves.toEqual({ restricted: false });
    expect(orgSettings.findUnique).toHaveBeenCalledWith({
      where: { organizationId_key: { organizationId: ORG, key: 'member_visibility' } },
    });
    expect(roles.getAllowedToolIds).not.toHaveBeenCalled();
  });

  it('returns unrestricted for a member when the stored value is not "restricted"', async () => {
    const { service, roles } = make({ settings: { [`${ORG}:${MEMBER_VISIBILITY_KEY}`]: 'closed' } });
    await expect(service.scopeFor(member())).resolves.toEqual({ restricted: false });
    expect(roles.getAllowedToolIds).not.toHaveBeenCalled();
  });

  it.each(['VIEWER', 'EDITOR'])('restricts a %s in a restricted workspace, with the allowed tool ids', async (role) => {
    const { service, roles } = make({ settings: restrictedSetting, allowed: ['t1', 't2'] });
    await expect(service.scopeFor(member(role))).resolves.toEqual({
      restricted: true,
      userId: 'u1',
      allowedToolIds: ['t1', 't2'],
    });
    expect(roles.getAllowedToolIds).toHaveBeenCalledWith('u1', ORG);
  });

  it('keeps null allowed tool ids (roles narrow nothing) and [] (no tool) apart', async () => {
    const open = make({ settings: restrictedSetting, allowed: null });
    await expect(open.service.scopeFor(member())).resolves.toEqual({
      restricted: true,
      userId: 'u1',
      allowedToolIds: null,
    });
    const none = make({ settings: { ...restrictedSetting }, allowed: [] });
    await expect(none.service.scopeFor(member())).resolves.toEqual({
      restricted: true,
      userId: 'u1',
      allowedToolIds: [],
    });
  });

  it('reads the allowed tool ids on every call (no cache for roles)', async () => {
    const { service, roles } = make({ settings: restrictedSetting, allowed: ['t1'] });
    await service.scopeFor(member());
    await service.scopeFor(member());
    expect(roles.getAllowedToolIds).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the role lookup throws', async () => {
    const { service } = make({ settings: restrictedSetting, allowed: new Error('db down') });
    await expect(service.scopeFor(member())).rejects.toThrow('db down');
  });

  it('fails closed when the setting cannot be read, and does not cache the failure', async () => {
    const { service, orgSettings, roles } = make({ settings: restrictedSetting, allowed: ['t1'] });
    orgSettings.findUnique.mockRejectedValueOnce(new Error('db down'));
    await expect(service.scopeFor(member())).rejects.toThrow('db down');
    await expect(service.scopeFor(member())).resolves.toMatchObject({ restricted: true });
    expect(roles.getAllowedToolIds).toHaveBeenCalledTimes(1);
  });

  it('refuses a non-admin caller without a workspace or a user id', async () => {
    const { service, touched } = make();
    await expect(service.scopeFor({ sub: 'u1', role: 'VIEWER', organizationId: '' })).rejects.toThrow();
    await expect(service.scopeFor({ sub: '', role: 'VIEWER', organizationId: ORG })).rejects.toThrow();
    expect(touched).toEqual([]);
  });
});

describe('MemberVisibilityService mode cache', () => {
  let now = 1_000_000;
  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => jest.restoreAllMocks());

  it('keeps a workspace mode for 30 s, then reads it again', async () => {
    const { service, orgSettings, settings } = make();
    expect(await service.mode(ORG)).toBe('open');
    // Another process switches the workspace: this one keeps the cached value.
    settings[`${ORG}:${MEMBER_VISIBILITY_KEY}`] = 'restricted';
    now += MEMBER_VISIBILITY_CACHE_TTL_MS - 1;
    expect(await service.mode(ORG)).toBe('open');
    expect(orgSettings.findUnique).toHaveBeenCalledTimes(1);

    now += 1;
    expect(await service.mode(ORG)).toBe('restricted');
    expect(orgSettings.findUnique).toHaveBeenCalledTimes(2);
  });

  it('caches per workspace', async () => {
    const { service, orgSettings } = make({ settings: restrictedSetting });
    expect(await service.mode(ORG)).toBe('restricted');
    expect(await service.mode('org2')).toBe('open');
    expect(await service.mode(ORG)).toBe('restricted');
    expect(await service.mode('org2')).toBe('open');
    expect(orgSettings.findUnique).toHaveBeenCalledTimes(2);
  });

  it('drops the cached mode when this process writes it', async () => {
    const { service, orgSettings } = make();
    expect(await service.mode(ORG)).toBe('open');
    await service.setMode(ORG, 'restricted');
    expect(await service.mode(ORG)).toBe('restricted');
    expect((await service.scopeFor(member())).restricted).toBe(true);
    await service.setMode(ORG, 'open');
    expect(await service.mode(ORG)).toBe('open');
    // mode + setMode reads, no stale hit in between.
    expect(orgSettings.findUnique.mock.calls.length).toBeGreaterThanOrEqual(5);
  });
});

describe('MemberVisibilityService.setMode', () => {
  it('writes the new mode and reports the old one', async () => {
    const { service, orgSettings } = make();
    await expect(service.setMode(ORG, 'restricted')).resolves.toEqual({
      before: 'open',
      after: 'restricted',
      changed: true,
    });
    expect(orgSettings.upsert).toHaveBeenCalledWith({
      where: { organizationId_key: { organizationId: ORG, key: 'member_visibility' } },
      create: { organizationId: ORG, key: 'member_visibility', value: 'restricted' },
      update: { value: 'restricted' },
    });
  });

  it('writes nothing when the mode does not change', async () => {
    const { service, orgSettings } = make({ settings: restrictedSetting });
    await expect(service.setMode(ORG, 'restricted')).resolves.toEqual({
      before: 'restricted',
      after: 'restricted',
      changed: false,
    });
    const fresh = make();
    await expect(fresh.service.setMode(ORG, 'open')).resolves.toMatchObject({ changed: false });
    expect(orgSettings.upsert).not.toHaveBeenCalled();
    expect(fresh.orgSettings.upsert).not.toHaveBeenCalled();
  });

  it('reads the previous mode from the database, not from the cache', async () => {
    const { service, settings } = make();
    expect(await service.mode(ORG)).toBe('open');
    settings[`${ORG}:${MEMBER_VISIBILITY_KEY}`] = 'restricted';
    await expect(service.setMode(ORG, 'open')).resolves.toEqual({
      before: 'restricted',
      after: 'open',
      changed: true,
    });
  });
});

describe('visibility helpers', () => {
  const open: VisibilityScope = { restricted: false };
  const noWhitelist: VisibilityScope = { restricted: true, userId: 'u1', allowedToolIds: null };
  const someTools: VisibilityScope = { restricted: true, userId: 'u1', allowedToolIds: ['t1', 't3'] };
  const noTools: VisibilityScope = { restricted: true, userId: 'u1', allowedToolIds: [] };

  const owned = { userId: 'u1', tools: [{ id: 'x1' }, { id: 'x2' }] };
  const shared = { userId: 'u9', tools: [{ id: 't1' }, { id: 't2' }] };
  const hidden = { userId: 'u9', tools: [{ id: 't2' }] };
  const empty = { userId: 'u9', tools: [] as Array<{ id: string }> };

  describe('connectorWhere', () => {
    it('adds nothing when not restricted or when roles narrow nothing', () => {
      expect(connectorWhere(open)).toEqual({});
      expect(connectorWhere(noWhitelist)).toEqual({});
    });

    it('matches owned connectors or connectors with an allowed tool', () => {
      expect(connectorWhere(someTools)).toEqual({
        OR: [{ userId: 'u1' }, { tools: { some: { id: { in: ['t1', 't3'] } } } }],
      });
    });

    it('matches only owned connectors when no tool is allowed', () => {
      expect(connectorWhere(noTools)).toEqual({ userId: 'u1' });
    });
  });

  describe('canSeeConnector', () => {
    it('sees everything when not restricted or when roles narrow nothing', () => {
      for (const c of [owned, shared, hidden, empty]) {
        expect(canSeeConnector(open, c)).toBe(true);
        expect(canSeeConnector(noWhitelist, c)).toBe(true);
      }
    });

    it('sees owned connectors and connectors with an allowed tool', () => {
      expect(canSeeConnector(someTools, owned)).toBe(true);
      expect(canSeeConnector(someTools, shared)).toBe(true);
      expect(canSeeConnector(someTools, hidden)).toBe(false);
      expect(canSeeConnector(someTools, empty)).toBe(false);
    });

    it('sees only owned connectors when no tool is allowed', () => {
      expect(canSeeConnector(noTools, owned)).toBe(true);
      expect(canSeeConnector(noTools, shared)).toBe(false);
    });

    it('agrees with connectorWhere on the same inputs', () => {
      // A tiny evaluator for the shapes connectorWhere returns.
      const matches = (where: any, c: typeof owned): boolean => {
        if (Object.keys(where).length === 0) return true;
        if (where.OR) return where.OR.some((w: any) => matches(w, c));
        if (where.userId) return c.userId === where.userId;
        if (where.tools) return c.tools.some((t) => where.tools.some.id.in.includes(t.id));
        throw new Error('unknown shape');
      };
      for (const scope of [open, noWhitelist, someTools, noTools]) {
        for (const c of [owned, shared, hidden, empty]) {
          expect(canSeeConnector(scope, c)).toBe(matches(connectorWhere(scope), c));
        }
      }
    });
  });

  describe('visibleTools', () => {
    const tools = [{ id: 't1', name: 'a' }, { id: 't2', name: 'b' }, { id: 't3', name: 'c' }];

    it('returns every tool when not restricted or when roles narrow nothing', () => {
      expect(visibleTools(open, { userId: 'u9' }, tools)).toBe(tools);
      expect(visibleTools(noWhitelist, { userId: 'u9' }, tools)).toBe(tools);
    });

    it('returns every tool to the owner', () => {
      expect(visibleTools(someTools, { userId: 'u1' }, tools)).toBe(tools);
      expect(visibleTools(noTools, { userId: 'u1' }, tools)).toBe(tools);
    });

    it('returns only allowed tools, in order, to anyone else', () => {
      expect(visibleTools(someTools, { userId: 'u9' }, tools)).toEqual([
        { id: 't1', name: 'a' },
        { id: 't3', name: 'c' },
      ]);
      expect(visibleTools(noTools, { userId: 'u9' }, tools)).toEqual([]);
    });
  });

  describe('serverWhere', () => {
    it('adds nothing when not restricted', () => {
      expect(serverWhere(open)).toEqual({});
    });

    it('matches owned servers or servers holding a visible connector', () => {
      expect(serverWhere(someTools)).toEqual({
        OR: [
          { userId: 'u1' },
          {
            connectors: {
              some: {
                connector: {
                  OR: [{ userId: 'u1' }, { tools: { some: { id: { in: ['t1', 't3'] } } } }],
                },
              },
            },
          },
        ],
      });
    });

    it('with no whitelist: owned servers or servers with any connector', () => {
      expect(serverWhere(noWhitelist)).toEqual({
        OR: [{ userId: 'u1' }, { connectors: { some: { connector: {} } } }],
      });
    });

    it('with no allowed tool: owned servers or servers holding an owned connector', () => {
      expect(serverWhere(noTools)).toEqual({
        OR: [{ userId: 'u1' }, { connectors: { some: { connector: { userId: 'u1' } } } }],
      });
    });
  });
});
