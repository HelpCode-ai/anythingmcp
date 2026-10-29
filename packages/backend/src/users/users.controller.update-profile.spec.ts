import { BadRequestException } from '@nestjs/common';
import { UsersController } from './users.controller';

function setup() {
  const usersService = {
    findById: jest.fn(async () => ({ id: 'u1', email: 'jane.doe@example.com', name: 'Jane' })),
    update: jest.fn(async (_id: string, data: Record<string, unknown>) => ({
      id: 'u1',
      email: 'jane.doe@example.com',
      name: 'Jane',
      passwordHash: 'h',
      ...data,
    })),
  };
  const controller = new UsersController(usersService as any, {} as any, {} as any, {} as any);
  const req = { user: { sub: 'u1' } };
  return { controller, usersService, req };
}

describe('UsersController.updateProfile', () => {
  const originalMode = process.env.DEPLOYMENT_MODE;
  afterEach(() => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
  });

  describe.each([
    ['self-hosted', undefined, /Ask your administrator/],
    ['cloud', 'cloud', /support@anythingmcp\.com/],
  ])('%s', (_label, mode, message) => {
    beforeEach(() => {
      if (mode === undefined) delete process.env.DEPLOYMENT_MODE;
      else process.env.DEPLOYMENT_MODE = mode;
    });

    // The address is what `{{amcp.user_email}}` forwards to connected
    // systems: taking a colleague's address would mean acting as them there.
    it('refuses a different email address and changes nothing', async () => {
      const { controller, usersService, req } = setup();
      const call = controller.updateProfile(req, { name: 'Jane', email: 'boss@example.com' });
      await expect(call).rejects.toBeInstanceOf(BadRequestException);
      await expect(call).rejects.toThrow(message);
      expect(usersService.update).not.toHaveBeenCalled();
    });

    it('accepts the current address in another spelling and leaves it as stored', async () => {
      const { controller, usersService, req } = setup();
      const profile = await controller.updateProfile(req, { name: 'Jane D.', email: 'Jane.Doe@Example.com' });
      expect(usersService.update).toHaveBeenCalledWith('u1', { name: 'Jane D.' });
      expect(profile).toMatchObject({ email: 'jane.doe@example.com', name: 'Jane D.' });
      expect(profile).not.toHaveProperty('passwordHash');
    });

    it('updates the name alone', async () => {
      const { controller, usersService, req } = setup();
      await controller.updateProfile(req, { name: 'J. Doe' });
      expect(usersService.findById).not.toHaveBeenCalled();
      expect(usersService.update).toHaveBeenCalledWith('u1', { name: 'J. Doe' });
    });
  });
});
