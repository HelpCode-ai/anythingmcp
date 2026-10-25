import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { UsersController } from './users.controller';

function setup(user: Record<string, unknown>, opts: { social?: boolean; iatSecondsAgo?: number | null } = {}) {
  const usersService = {
    findById: jest.fn(async () => ({ id: 'u1', ...user })),
    hasSocialIdentity: jest.fn(async () => opts.social ?? false),
    deleteSelf: jest.fn(async () => undefined),
  };
  const iat = opts.iatSecondsAgo == null ? undefined : Math.floor(Date.now() / 1000) - opts.iatSecondsAgo;
  const authService = {
    comparePassword: jest.fn(async (pw: string) => pw === 'right'),
    verifyToken: jest.fn(() => ({ sub: 'u1', iat })),
  };
  const controller = new UsersController(usersService as any, authService as any, {} as any, {} as any);
  const req = { user: { sub: 'u1' }, headers: { authorization: 'Bearer tok' } };
  return { controller, usersService, req };
}

describe('UsersController.deleteSelf', () => {
  it('deletes a password account with the right password', async () => {
    const { controller, usersService, req } = setup({ passwordHash: 'h' });
    await controller.deleteSelf(req, { password: 'right', confirm: 'DELETE' });
    expect(usersService.deleteSelf).toHaveBeenCalledWith('u1');
  });

  it('refuses a password account without its password', async () => {
    const { controller, usersService, req } = setup({ passwordHash: 'h' });
    await expect(controller.deleteSelf(req, { confirm: 'DELETE' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(usersService.deleteSelf).not.toHaveBeenCalled();
  });

  it('deletes a social-only account right after a sign-in', async () => {
    const { controller, usersService, req } = setup({ passwordHash: null }, { social: true, iatSecondsAgo: 60 });
    await controller.deleteSelf(req, { confirm: 'DELETE' });
    expect(usersService.deleteSelf).toHaveBeenCalledWith('u1');
  });

  it('asks a social-only account for a fresh sign-in when the session is old', async () => {
    const { controller, usersService, req } = setup({ passwordHash: null }, { social: true, iatSecondsAgo: 3600 });
    await expect(controller.deleteSelf(req, { confirm: 'DELETE' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(usersService.deleteSelf).not.toHaveBeenCalled();
  });

  it('still refuses an SSO-only account', async () => {
    const { controller, usersService, req } = setup({ passwordHash: null }, { social: false, iatSecondsAgo: 10 });
    await expect(controller.deleteSelf(req, { confirm: 'DELETE' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(usersService.deleteSelf).not.toHaveBeenCalled();
  });
});
