import 'reflect-metadata';
import { BadRequestException, ForbiddenException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, RolesGuard } from '../auth/roles.guard';
import { MemberVisibilityService } from '../settings/member-visibility.service';
import { AuditController } from './audit.controller';

const ROW = {
  id: 'inv-1',
  createdAt: new Date('2026-10-20T08:15:00.000Z'),
  status: 'ERROR',
  durationMs: 5,
  repeatCount: 1,
  error: 'x,y',
  clientInfo: null,
  tool: { name: 'echo', connector: { name: 'Echo', type: 'REST' } },
  user: null,
  mcpServer: null,
};

function fakeRes() {
  const res: any = {
    headers: {} as Record<string, string>,
    body: '',
    headersSent: false,
    destroyed: false,
    ended: false,
    setHeader: jest.fn((k: string, v: string) => (res.headers[k.toLowerCase()] = v)),
    write: jest.fn((chunk: string) => {
      res.headersSent = true;
      res.body += chunk;
      return true;
    }),
    end: jest.fn((chunk?: string) => {
      res.headersSent = true;
      if (chunk) res.body += chunk;
      res.ended = true;
    }),
    destroy: jest.fn(() => (res.destroyed = true)),
    on: jest.fn(),
    off: jest.fn(),
  };
  return res;
}

function build(exportImpl?: jest.Mock) {
  const auditService = {
    getRecentInvocations: jest.fn().mockResolvedValue([]),
    exportInvocations:
      exportImpl ??
      jest.fn(async (_f: any, _o: any, onBatch: (rows: any[]) => Promise<boolean | void>) => {
        await onBatch([ROW]);
        return { rowCount: 1, truncated: false, aborted: false };
      }),
  };
  // An open workspace; the visibility matrix above covers restricted members.
  const visibility = { scopeFor: jest.fn().mockResolvedValue({ restricted: false }) };
  return { controller: new AuditController(auditService as any, visibility as any), auditService };
}

const admin = (organizationId: string | null = 'org-1') => ({ user: { role: 'ADMIN', organizationId } });

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
      call: (c, role) =>
        c.listInvocations(req(role), {
          limit: 20,
          offset: 40,
          toolId: 'tool-1',
          status: 'ERROR',
          search: 'crm',
          connectorId: 'conn-1',
          mcpServerId: 'srv-1',
        }),
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
    exportInvocations: {
      path: 'invocations/export',
      service: 'exportInvocations',
      call: (c, role) => c.exportInvocations(req(role), { format: 'csv', status: 'ERROR' }, fakeRes()),
      open: [{ status: 'ERROR', organizationId: ORG }, { payloads: false }, expect.any(Function)],
      restricted: [{ status: 'ERROR', organizationId: ORG, onlyUserId: ME }, { payloads: false }, expect.any(Function)],
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
      exportInvocations: jest.fn().mockResolvedValue({ rowCount: 0, truncated: false, aborted: false }),
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
    ['toolId', { toolId: 'tool-x' }],
    ['status', { status: 'SUCCESS' }],
    ['search', { search: 'export' }],
    ['connectorId', { connectorId: 'conn-x' }],
    ['mcpServerId', { mcpServerId: 'srv-x' }],
    ['date range', { from: '2026-10-01', to: '2026-10-08' }],
  ] as const)('a restricted member filtering invocations by %s keeps the own-calls filter', async (_f, query) => {
    orgSettings.get.mockResolvedValue('restricted');
    await controller.listInvocations(req('VIEWER'), query);
    const filters = audit.getRecentInvocations.mock.calls[0][2];
    expect(filters).toMatchObject({ organizationId: ORG, onlyUserId: ME });
  });
});

describe('AuditController', () => {
  describe('export access', () => {
    const contextFor = (role: string) =>
      ({
        getHandler: () => AuditController.prototype.exportInvocations,
        getClass: () => AuditController,
        switchToHttp: () => ({ getRequest: () => ({ user: { organizationId: 'org-1', role } }) }),
      }) as any;

    it('is limited to admins', () => {
      const roles = new Reflector().get<string[]>(ROLES_KEY, AuditController.prototype.exportInvocations);
      expect(roles).toEqual(['ADMIN']);
    });

    it('rejects editors and viewers with 403 and lets admins through', () => {
      const guard = new RolesGuard(new Reflector());
      expect(() => guard.canActivate(contextFor('EDITOR'))).toThrow(ForbiddenException);
      expect(() => guard.canActivate(contextFor('VIEWER'))).toThrow(ForbiddenException);
      expect(guard.canActivate(contextFor('ADMIN'))).toBe(true);
    });

    it('leaves the list open to every role', () => {
      const roles = new Reflector().get<string[]>(ROLES_KEY, AuditController.prototype.listInvocations);
      expect(roles).toBeUndefined();
    });

    it('answers 403 for a token without an organization, before reading anything', async () => {
      const { controller, auditService } = build();
      const res = fakeRes();
      await expect(
        controller.exportInvocations(admin(null), { format: 'csv' }, res),
      ).rejects.toThrow(ForbiddenException);
      expect(auditService.exportInvocations).not.toHaveBeenCalled();
      expect(res.write).not.toHaveBeenCalled();
    });
  });

  describe('exportInvocations', () => {
    it('passes the page filters and the org, and streams a CSV attachment', async () => {
      const { controller, auditService } = build();
      const res = fakeRes();

      await controller.exportInvocations(
        admin(),
        {
          format: 'csv',
          status: 'ERROR',
          search: 'echo',
          connectorId: 'c1',
          mcpServerId: 's1',
          toolId: 't1',
          from: '2026-10-01',
          to: '2026-10-08T00:00:00Z',
        },
        res,
      );

      expect(auditService.exportInvocations).toHaveBeenCalledWith(
        {
          organizationId: 'org-1',
          status: 'ERROR',
          search: 'echo',
          connectorId: 'c1',
          mcpServerId: 's1',
          toolId: 't1',
          from: new Date('2026-10-01T00:00:00Z'),
          to: new Date('2026-10-08T00:00:00Z'),
        },
        { payloads: false },
        expect.any(Function),
      );
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="anythingmcp-audit-2026-10-01-2026-10-08.csv"',
      );
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.startsWith('﻿createdAt,')).toBe(true);
      expect(res.body).toContain(',"x,y"\r\n');
      expect(res.ended).toBe(true);
    });

    it('streams JSON with payloads and names an open range after today', async () => {
      const { controller, auditService } = build();
      const res = fakeRes();
      await controller.exportInvocations(admin(), { format: 'json', payloads: true }, res);

      expect(auditService.exportInvocations.mock.calls[0][1]).toEqual({ payloads: true });
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      const today = new Date().toISOString().slice(0, 10);
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="anythingmcp-audit-all-${today}.json"`,
      );
      expect(JSON.parse(res.body)).toMatchObject({ rowCount: 1, truncated: false, rows: [{ tool: 'echo' }] });
    });

    it('writes a valid empty file when nothing matches', async () => {
      const { controller } = build(jest.fn().mockResolvedValue({ rowCount: 0, truncated: false, aborted: false }));
      const res = fakeRes();
      await controller.exportInvocations(admin(), { format: 'json' }, res);
      expect(JSON.parse(res.body)).toEqual({ rows: [], rowCount: 0, truncated: false });
    });

    it('rejects a range whose start is not before its end', async () => {
      const { controller, auditService } = build();
      await expect(
        controller.exportInvocations(admin(), { format: 'csv', from: '2026-10-08', to: '2026-10-08' }, fakeRes()),
      ).rejects.toThrow(BadRequestException);
      expect(auditService.exportInvocations).not.toHaveBeenCalled();
    });

    it('lets an error before the first row reach the client as an error response', async () => {
      const { controller } = build(jest.fn().mockRejectedValue(new Error('db down')));
      const res = fakeRes();
      await expect(controller.exportInvocations(admin(), { format: 'csv' }, res)).rejects.toThrow('db down');
      expect(res.write).not.toHaveBeenCalled();
    });

    it('breaks the download instead of ending it cleanly when a later batch fails', async () => {
      const { controller } = build(
        jest.fn(async (_f: any, _o: any, onBatch: (rows: any[]) => Promise<boolean | void>) => {
          await onBatch([ROW]);
          throw new Error('db down');
        }),
      );
      const res = fakeRes();
      await controller.exportInvocations(admin(), { format: 'csv' }, res);
      expect(res.destroy).toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
    });

    it('waits for the socket to drain before reading the next batch', async () => {
      const order: string[] = [];
      const { controller } = build(
        jest.fn(async (_f: any, _o: any, onBatch: (rows: any[]) => Promise<boolean | void>) => {
          await onBatch([ROW]);
          order.push('next batch');
          return { rowCount: 1, truncated: false, aborted: false };
        }),
      );
      const res = fakeRes();
      const handlers: Record<string, () => void> = {};
      res.on.mockImplementation((event: string, fn: () => void) => (handlers[event] = fn));
      res.write.mockImplementation((chunk: string) => {
        res.headersSent = true;
        res.body += chunk;
        setTimeout(() => {
          order.push('drain');
          handlers.drain();
        }, 10);
        return false;
      });
      await controller.exportInvocations(admin(), { format: 'csv' }, res);
      expect(order).toEqual(['drain', 'next batch']);
      expect(res.off).toHaveBeenCalledWith('close', expect.any(Function));
      expect(res.ended).toBe(true);
    });

    it('stops reading once the client has gone', async () => {
      let answer: boolean | void = true;
      const { controller } = build(
        jest.fn(async (_f: any, _o: any, onBatch: (rows: any[]) => Promise<boolean | void>) => {
          answer = await onBatch([ROW]);
          return { rowCount: 1, truncated: false, aborted: answer === false };
        }),
      );
      const res = fakeRes();
      res.write.mockImplementation(() => {
        res.headersSent = true;
        res.destroyed = true;
        return false;
      });
      await controller.exportInvocations(admin(), { format: 'csv' }, res);
      expect(answer).toBe(false);
      expect(res.end).not.toHaveBeenCalled();
    });
  });

  describe('listInvocations', () => {
    it('parses the date range and keeps the defaults', async () => {
      const { controller, auditService } = build();
      await controller.listInvocations(admin(), { from: '2026-10-01', status: 'SUCCESS' });
      expect(auditService.getRecentInvocations).toHaveBeenCalledWith(100, 0, {
        organizationId: 'org-1',
        status: 'SUCCESS',
        from: new Date('2026-10-01T00:00:00Z'),
      });
    });
  });
});
