import { ForbiddenException } from '@nestjs/common';
import { OrganizationsController } from './organizations.controller';

/**
 * POST /api/organizations makes the caller the ADMIN of the workspace it
 * creates. In Cloud that is the product: everyone runs their own workspace.
 * On a self-hosted instance it was a way up for any member: a VIEWER created
 * a workspace, became its ADMIN, and with that role reached the admin pages
 * and the instance-wide settings a workspace ADMIN may change there. So on
 * self-hosted only someone who is already an ADMIN may create one.
 */
function build(mode: 'cloud' | 'self-hosted') {
  const organizationsService = {
    create: jest.fn(async (name: string) => ({ id: 'org-new', name })),
    addMember: jest.fn(async () => undefined),
  };
  const deployment = { isCloud: () => mode === 'cloud', isSelfHosted: () => mode !== 'cloud' };
  const controller = new OrganizationsController(
    organizationsService as any,
    {} as any, // authService
    {} as any, // configService
    deployment as any,
  );
  return { controller, organizationsService };
}

const req = (role: string) => ({ user: { sub: 'u1', role, organizationId: 'org-1' } });

describe('OrganizationsController.createOrg', () => {
  describe('self-hosted', () => {
    it.each(['VIEWER', 'EDITOR'])('refuses a %s and creates nothing', async (role) => {
      const { controller, organizationsService } = build('self-hosted');
      await expect(controller.createOrg(req(role), { name: 'Mine' })).rejects.toBeInstanceOf(ForbiddenException);
      expect(organizationsService.create).not.toHaveBeenCalled();
      expect(organizationsService.addMember).not.toHaveBeenCalled();
    });

    it('lets an ADMIN create a workspace and makes them its ADMIN', async () => {
      const { controller, organizationsService } = build('self-hosted');
      await expect(controller.createOrg(req('ADMIN'), { name: 'Second' })).resolves.toEqual({ id: 'org-new', name: 'Second' });
      expect(organizationsService.addMember).toHaveBeenCalledWith('u1', 'org-new', 'ADMIN');
    });

    it('refuses a caller without a role (fail closed)', async () => {
      const { controller, organizationsService } = build('self-hosted');
      await expect(controller.createOrg({ user: { sub: 'u1' } }, { name: 'Mine' })).rejects.toBeInstanceOf(ForbiddenException);
      expect(organizationsService.create).not.toHaveBeenCalled();
    });
  });

  describe('cloud', () => {
    it.each(['VIEWER', 'EDITOR', 'ADMIN'])('a %s creates their own workspace, as before', async (role) => {
      const { controller, organizationsService } = build('cloud');
      await expect(controller.createOrg(req(role), { name: 'Mine' })).resolves.toEqual({ id: 'org-new', name: 'Mine' });
      expect(organizationsService.addMember).toHaveBeenCalledWith('u1', 'org-new', 'ADMIN');
    });
  });
});

/**
 * A management API key acts in the workspace it was created in. Actions that
 * return a dashboard session or change the owner's active workspace need a
 * dashboard sign-in; listing shows only the key's workspace.
 */
describe('OrganizationsController with an API key', () => {
  function buildFull() {
    const user = { id: 'u1', email: 'u@x', name: 'U', role: 'ADMIN', organizationId: 'org-2', mcpRoleId: null };
    const organizationsService = {
      create: jest.fn(async (name: string) => ({ id: 'org-new', name })),
      addMember: jest.fn(async () => undefined),
      switchOrg: jest.fn(async () => user),
      findById: jest.fn(async (id: string) => ({ id, name: 'Org' })),
      deleteOrganization: jest.fn(async () => ({
        activeUser: user,
        activeOrganization: { id: 'org-2' },
        autoCreated: false,
      })),
      listUserOrgs: jest.fn(async () => [
        { id: 'org-1', name: 'One' },
        { id: 'org-2', name: 'Two' },
      ]),
    };
    const authService = { generateToken: jest.fn(() => 'dashboard-token') };
    const deployment = { isCloud: () => true, isSelfHosted: () => false };
    const controller = new OrganizationsController(
      organizationsService as any,
      authService as any,
      {} as any,
      deployment as any,
    );
    return { controller, organizationsService, authService };
  }

  const jwtReq = { user: { sub: 'u1', role: 'ADMIN', organizationId: 'org-1' } };
  const keyReq = { ...jwtReq, mcpKeyScope: 'MANAGEMENT_ADMIN' };

  it('refuses to switch the workspace and issues no token', async () => {
    const { controller, organizationsService, authService } = buildFull();
    await expect(controller.switchOrg(keyReq, { organizationId: 'org-2' })).rejects.toThrow(
      'Use a dashboard sign-in for this action',
    );
    expect(organizationsService.switchOrg).not.toHaveBeenCalled();
    expect(authService.generateToken).not.toHaveBeenCalled();
  });

  it('refuses to delete the workspace', async () => {
    const { controller, organizationsService, authService } = buildFull();
    await expect(controller.deleteCurrent(keyReq, { confirmName: 'Org' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(organizationsService.deleteOrganization).not.toHaveBeenCalled();
    expect(authService.generateToken).not.toHaveBeenCalled();
  });

  it('refuses to create a workspace', async () => {
    const { controller, organizationsService } = buildFull();
    await expect(controller.createOrg(keyReq, { name: 'New' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(organizationsService.create).not.toHaveBeenCalled();
  });

  it("lists only the key's own workspace", async () => {
    const { controller } = buildFull();
    await expect(controller.listMine(keyReq)).resolves.toEqual([{ id: 'org-1', name: 'One' }]);
  });

  describe('a dashboard session (JWT) is unchanged', () => {
    it('switches and gets a new token', async () => {
      const { controller } = buildFull();
      await expect(controller.switchOrg(jwtReq, { organizationId: 'org-2' })).resolves.toMatchObject({
        accessToken: 'dashboard-token',
      });
    });

    it('deletes and gets a new token', async () => {
      const { controller } = buildFull();
      await expect(controller.deleteCurrent(jwtReq, { confirmName: 'Org' })).resolves.toMatchObject({
        accessToken: 'dashboard-token',
      });
    });

    it('creates a workspace', async () => {
      const { controller } = buildFull();
      await expect(controller.createOrg(jwtReq, { name: 'New' })).resolves.toEqual({ id: 'org-new', name: 'New' });
    });

    it('lists every workspace', async () => {
      const { controller } = buildFull();
      await expect(controller.listMine(jwtReq)).resolves.toHaveLength(2);
    });
  });
});
