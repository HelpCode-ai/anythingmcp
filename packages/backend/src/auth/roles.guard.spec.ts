import { ForbiddenException } from '@nestjs/common';
import { RolesGuard, ROLES_KEY } from './roles.guard';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let mockReflector: any;

  const mockContext = (user?: { role: string }) =>
    ({
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    }) as any;

  beforeEach(() => {
    mockReflector = { getAllAndOverride: jest.fn() };
    guard = new RolesGuard(mockReflector);
  });

  it('should export ROLES_KEY as "roles"', () => {
    expect(ROLES_KEY).toBe('roles');
  });

  it('should allow when no roles are required', () => {
    mockReflector.getAllAndOverride.mockReturnValue(undefined);
    expect(guard.canActivate(mockContext({ role: 'USER' }))).toBe(true);
  });

  it('should allow when required roles is empty array', () => {
    mockReflector.getAllAndOverride.mockReturnValue([]);
    expect(guard.canActivate(mockContext({ role: 'USER' }))).toBe(true);
  });

  it('should allow when user role matches a required role', () => {
    mockReflector.getAllAndOverride.mockReturnValue(['ADMIN', 'EDITOR']);
    expect(guard.canActivate(mockContext({ role: 'ADMIN' }))).toBe(true);
  });

  it('should throw ForbiddenException when user role does not match', () => {
    mockReflector.getAllAndOverride.mockReturnValue(['ADMIN']);
    expect(() => guard.canActivate(mockContext({ role: 'USER' }))).toThrow(
      ForbiddenException,
    );
  });

  it('should throw ForbiddenException when request has no user', () => {
    mockReflector.getAllAndOverride.mockReturnValue(['ADMIN']);
    expect(() => guard.canActivate(mockContext(undefined))).toThrow(
      ForbiddenException,
    );
  });
});
