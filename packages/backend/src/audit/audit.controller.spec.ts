import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MemberVisibilityService } from '../settings/member-visibility.service';
import { AuditController } from './audit.controller';

/**
 * Member visibility matrix of every GET route of AuditController:
 * ADMIN / EDITOR / VIEWER x open / restricted. Open workspaces and admins must
 * reach AuditService with exactly today's arguments; a restricted member gets
 * the same call plus their own user id. AuditService is mocked here; the
 * queries themselves are covered in audit.member-visibility.spec.ts and, on a
 * real database, in audit.member-visibility.integration.spec.ts.
 */
describe('AuditController member visibility', () => {
  const ORG = 'org-1';
  const ME = 'user-me';

  let audit: Record<string, jest.Mock>;
  let orgSettings: { get: jest.Mock };
  let roles: { getAllowedToolIds: jest.Mock };
  let controller: AuditController;

  const req = (role: string) => ({ user: { sub: ME, role, organizationId: ORG, email: 'me@example.invalid' } });

  /**
   * One entry per GET route: how to call it, the AuditService method it
   * reaches, and the arguments of the open path (today) and the restricted path.
   */
  const ROUTES: Record<
    string,
    {
      path: string;
      service: string;
      call: (c: AuditController, role: string) => Promise<unknown>;
      open: unknown[];
      restricted: unknown[];
    }
  > = {
    listInvocations: {
      path: 'invocations',
      service: 'getRecentInvocations',
      call: (c, role) => c.listInvocations(req(role), '20', '40', 'tool-1', 'ERROR', 'crm', 'conn-1', 'srv-1'),
      open: [
        20,
        40,
        { toolId: 'tool-1', status: 'ERROR', search: 'crm', connectorId: 'conn-1', mcpServerId: 'srv-1', organizationId: ORG },
      ],
      restricted: [
        20,
        40,
        {
          toolId: 'tool-1',
          status: 'ERROR',
          search: 'crm',
          connectorId: 'conn-1',
          mcpServerId: 'srv-1',
          organizationId: ORG,
          onlyUserId: ME,
        },
      ],
    },
    getStats: {
      path: 'stats',
      service: 'getStats',
      call: (c, role) => c.getStats(req(role)),
      open: [ORG],
      restricted: [ORG, ME],
    },
    getAnalytics: {
      path: 'analytics',
      service: 'getAnalytics',
      call: (c, role) => c.getAnalytics(req(role), { days: 30 }),
      open: [ORG, 30],
      restricted: [ORG, 30, ME],
    },
    getToolPerformance: {
      path: 'tool-performance',
      service: 'getToolPerformance',
      call: (c, role) => c.getToolPerformance(req(role), { hours: 48, connectorId: 'conn-1', mcpServerId: 'srv-1' }),
      open: [ORG, { hours: 48, connectorId: 'conn-1', mcpServerId: 'srv-1' }],
      restricted: [ORG, { hours: 48, connectorId: 'conn-1', mcpServerId: 'srv-1' }, ME],
    },
    getBreakdowns: {
      path: 'breakdowns',
      service: 'getBreakdowns',
      call: (c, role) => c.getBreakdowns(req(role), '14'),
      open: [ORG, 14],
      restricted: [ORG, 14, ME],
    },
  };

  beforeEach(() => {
    audit = {
      getRecentInvocations: jest.fn().mockResolvedValue([]),
      getStats: jest.fn().mockResolvedValue({}),
      getAnalytics: jest.fn().mockResolvedValue({}),
      getToolPerformance: jest.fn().mockResolvedValue({ items: [], hasMore: false }),
      getBreakdowns: jest.fn().mockResolvedValue({}),
    };
    orgSettings = { get: jest.fn().mockResolvedValue(null) };
    roles = { getAllowedToolIds: jest.fn().mockResolvedValue(null) };
    const visibility = new MemberVisibilityService(orgSettings as any, roles as any);
    controller = new AuditController(audit as any, visibility);
  });

  it('declares a visibility rule for every GET route of the controller', () => {
    const proto = AuditController.prototype as unknown as Record<string, unknown>;
    const getRoutes = Object.getOwnPropertyNames(proto).filter(
      (name) =>
        name !== 'constructor' &&
        typeof proto[name] === 'function' &&
        Reflect.getMetadata(METHOD_METADATA, proto[name] as object) === RequestMethod.GET,
    );
    expect(getRoutes.sort()).toEqual(Object.keys(ROUTES).sort());
    for (const name of getRoutes) {
      expect(Reflect.getMetadata(PATH_METADATA, proto[name] as object)).toBe(ROUTES[name].path);
    }
  });

  describe.each(Object.entries(ROUTES))('%s', (_name, route) => {
    const expectCall = (args: unknown[]) => {
      const mock = audit[route.service];
      expect(mock).toHaveBeenCalledTimes(1);
      // Exact arity: the open path must not pass even an undefined extra argument.
      expect(mock.mock.calls[0]).toEqual(args);
      expect(mock.mock.calls[0]).toHaveLength(args.length);
    };

    it.each(['open', 'restricted'])('ADMIN in a %s workspace: today’s call, no settings read', async (mode) => {
      orgSettings.get.mockResolvedValue(mode);
      await route.call(controller, 'ADMIN');
      expectCall(route.open);
      expect(orgSettings.get).not.toHaveBeenCalled();
      expect(roles.getAllowedToolIds).not.toHaveBeenCalled();
    });

    it.each(['EDITOR', 'VIEWER'])('%s in an open workspace: today’s call', async (role) => {
      orgSettings.get.mockResolvedValue('open');
      await route.call(controller, role);
      expectCall(route.open);
      expect(roles.getAllowedToolIds).not.toHaveBeenCalled();
    });

    it.each(['EDITOR', 'VIEWER'])('%s in a workspace that never set the mode: today’s call', async (role) => {
      orgSettings.get.mockResolvedValue(null);
      await route.call(controller, role);
      expectCall(route.open);
    });

    it.each(['EDITOR', 'VIEWER'])('%s in a restricted workspace: own calls only', async (role) => {
      orgSettings.get.mockResolvedValue('restricted');
      await route.call(controller, role);
      expectCall(route.restricted);
    });

    it.each([[['tool-1']], [[]]])(
      'a restricted member with a tool whitelist (%j) still gets own calls only',
      async (allowed) => {
        orgSettings.get.mockResolvedValue('restricted');
        roles.getAllowedToolIds.mockResolvedValue(allowed);
        await route.call(controller, 'VIEWER');
        expectCall(route.restricted);
      },
    );

    it('fails closed when the role lookup throws', async () => {
      orgSettings.get.mockResolvedValue('restricted');
      roles.getAllowedToolIds.mockRejectedValue(new Error('database down'));
      await expect(route.call(controller, 'VIEWER')).rejects.toThrow('database down');
      expect(audit[route.service]).not.toHaveBeenCalled();
    });

    it('fails closed when the mode lookup throws for a member', async () => {
      orgSettings.get.mockRejectedValue(new Error('database down'));
      await expect(route.call(controller, 'EDITOR')).rejects.toThrow('database down');
      expect(audit[route.service]).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['toolId', [undefined, undefined, 'tool-x']],
    ['status', [undefined, undefined, undefined, 'SUCCESS']],
    ['search', [undefined, undefined, undefined, undefined, 'export']],
    ['connectorId', [undefined, undefined, undefined, undefined, undefined, 'conn-x']],
    ['mcpServerId', [undefined, undefined, undefined, undefined, undefined, undefined, 'srv-x']],
  ] as const)('a restricted member filtering invocations by %s keeps the own-calls filter', async (_f, args) => {
    orgSettings.get.mockResolvedValue('restricted');
    await (controller.listInvocations as any)(req('VIEWER'), ...args);
    const filters = audit.getRecentInvocations.mock.calls[0][2];
    expect(filters).toMatchObject({ organizationId: ORG, onlyUserId: ME });
  });
});
