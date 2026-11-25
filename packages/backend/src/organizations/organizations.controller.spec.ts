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
