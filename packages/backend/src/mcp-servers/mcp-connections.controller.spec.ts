import { ForbiddenException } from '@nestjs/common';
import { McpConnectionsController } from './mcp-connections.controller';

/**
 * Connection grants belong to the user across all their workspaces. A
 * management API key acts in one workspace, so with a key the list, the
 * targets and every change are limited to that workspace. A dashboard session
 * keeps seeing and changing all of them.
 */
describe('McpConnectionsController', () => {
  const SERVERS = [
    { id: 'srv-a', name: 'A', organizationId: 'org-a' },
    { id: 'srv-b', name: 'B', organizationId: 'org-b' },
  ];
  const GRANTS = [
    { clientId: 'c-a', organizationId: null, serverIds: ['srv-a'], revokedAt: null, createdAt: new Date(0), updatedAt: new Date(0) },
    { clientId: 'c-b', organizationId: null, serverIds: ['srv-b'], revokedAt: null, createdAt: new Date(0), updatedAt: new Date(0) },
    { clientId: 'c-wa', organizationId: 'org-a', serverIds: [], revokedAt: null, createdAt: new Date(0), updatedAt: new Date(0) },
    { clientId: 'c-mixed', organizationId: null, serverIds: ['srv-a', 'srv-b'], revokedAt: null, createdAt: new Date(0), updatedAt: new Date(0) },
  ];

  function build() {
    const grants = {
      listForUser: jest.fn(async () => GRANTS),
      keepVisible: jest.fn(async (_u: string, servers: unknown[]) => servers),
      listSelectableTargets: jest.fn(async () => [
        { organizationId: 'org-a', organizationName: 'A', servers: [] },
        { organizationId: 'org-b', organizationName: 'B', servers: [] },
      ]),
      grantWholeOrganization: jest.fn(async () => true),
      grantServers: jest.fn(async (_c: string, _u: string, ids: string[]) => ids),
      revoke: jest.fn(async () => true),
    };
    const prisma = {
      oAuthClient: { findMany: jest.fn(async () => []) },
      organization: { findMany: jest.fn(async () => [{ id: 'org-a', name: 'A' }]) },
      mcpServerConfig: {
        findMany: jest.fn(async ({ where }: any) =>
          SERVERS.filter(
            (s) => where.id.in.includes(s.id) && (!where.organizationId || where.organizationId === s.organizationId),
          ),
        ),
      },
      mcpConnectionGrant: {
        findUnique: jest.fn(async ({ where }: any) =>
          GRANTS.find((g) => g.clientId === where.clientId_userId.clientId) ?? null,
        ),
      },
    };
    const securityEvents = { log: jest.fn(async () => undefined) };
    const controller = new McpConnectionsController(grants as any, prisma as any, securityEvents as any);
    return { controller, grants };
  }

  const jwtReq = { user: { sub: 'u1', organizationId: 'org-a' } };
  const keyReq = { ...jwtReq, mcpKeyScope: 'MANAGEMENT_ADMIN' };

  describe('with an API key', () => {
    it("lists only connections that lie in the key's workspace", async () => {
      const { controller } = build();
      const out = await controller.list(keyReq);
      expect(out.map((g) => g.clientId).sort()).toEqual(['c-a', 'c-wa']);
    });

    it("offers only the key's workspace as a target", async () => {
      const { controller } = build();
      const out = await controller.targets(keyReq);
      expect(out.map((t) => t.organizationId)).toEqual(['org-a']);
    });

    it('refuses to change a connection of another workspace', async () => {
      const { controller, grants } = build();
      await expect(controller.update(keyReq, 'c-b', { serverIds: ['srv-a'] })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(controller.update(keyReq, 'c-mixed', { serverIds: ['srv-a'] })).rejects.toBeInstanceOf(ForbiddenException);
      expect(grants.grantServers).not.toHaveBeenCalled();
    });

    it('refuses to change a connection that has no grant yet', async () => {
      const { controller, grants } = build();
      await expect(controller.update(keyReq, 'c-new', { serverIds: ['srv-a'] })).rejects.toBeInstanceOf(ForbiddenException);
      expect(grants.grantServers).not.toHaveBeenCalled();
    });

    it('refuses to grant another workspace', async () => {
      const { controller, grants } = build();
      await expect(controller.update(keyReq, 'c-a', { organizationId: 'org-b' })).rejects.toBeInstanceOf(ForbiddenException);
      expect(grants.grantWholeOrganization).not.toHaveBeenCalled();
    });

    it("drops servers of other workspaces and grants the key's own", async () => {
      const { controller, grants } = build();
      await expect(controller.update(keyReq, 'c-a', { serverIds: ['srv-a', 'srv-b'] })).resolves.toEqual({ ok: true });
      expect(grants.grantServers).toHaveBeenCalledWith('c-a', 'u1', ['srv-a']);
    });

    it('answers nothing-granted when only servers of other workspaces are named', async () => {
      const { controller, grants } = build();
      await expect(controller.update(keyReq, 'c-a', { serverIds: ['srv-b'] })).resolves.toEqual({
        ok: false,
        reason: 'nothing-granted',
      });
      expect(grants.grantServers).not.toHaveBeenCalled();
    });

    it("grants the key's own workspace", async () => {
      const { controller, grants } = build();
      await expect(controller.update(keyReq, 'c-wa', { organizationId: 'org-a' })).resolves.toEqual({ ok: true });
      expect(grants.grantWholeOrganization).toHaveBeenCalledWith('c-wa', 'u1', 'org-a');
    });

    it('revokes only connections of its workspace', async () => {
      const { controller, grants } = build();
      await expect(controller.revoke(keyReq, 'c-b')).rejects.toBeInstanceOf(ForbiddenException);
      expect(grants.revoke).not.toHaveBeenCalled();
      await expect(controller.revoke(keyReq, 'c-a')).resolves.toEqual({ ok: true });
    });
  });

  describe('with a dashboard session (unchanged)', () => {
    it('lists every connection', async () => {
      const { controller } = build();
      expect(await controller.list(jwtReq)).toHaveLength(4);
    });

    it('offers every workspace as a target', async () => {
      const { controller } = build();
      expect(await controller.targets(jwtReq)).toHaveLength(2);
    });

    it('changes and revokes a connection in any workspace', async () => {
      const { controller, grants } = build();
      await expect(controller.update(jwtReq, 'c-b', { serverIds: ['srv-b'] })).resolves.toEqual({ ok: true });
      expect(grants.grantServers).toHaveBeenCalledWith('c-b', 'u1', ['srv-b']);
      await expect(controller.revoke(jwtReq, 'c-b')).resolves.toEqual({ ok: true });
    });
  });
});
