import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';
import type { ExecutionContext } from '@nestjs/common';
import { AppThrottlerGuard, isRegisterPost, REGISTER_LIMIT_PER_MINUTE } from './app-throttler.guard';

class FakeOAuthController {
  registerClient() {}
  token() {}
}

function contextFor(ip: string, method: string, path: string, handler: () => void): ExecutionContext {
  const req = { ip, method, path, headers: {} };
  const res = { header: () => undefined };
  return {
    getHandler: () => handler,
    getClass: () => FakeOAuthController,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

describe('AppThrottlerGuard', () => {
  let guard: AppThrottlerGuard;
  let storage: ThrottlerStorageService;

  beforeEach(async () => {
    storage = new ThrottlerStorageService();
    // The application's own throttler (app.module.ts).
    guard = new AppThrottlerGuard([{ ttl: 60_000, limit: 100 }], storage, new Reflector());
    await guard.onModuleInit();
  });
  afterEach(() => storage.onApplicationShutdown());

  const register = (ip: string) =>
    guard.canActivate(contextFor(ip, 'POST', '/register', FakeOAuthController.prototype.registerClient));

  it('allows 20 registrations a minute per address, then refuses', async () => {
    expect(REGISTER_LIMIT_PER_MINUTE).toBe(20);
    for (let i = 0; i < REGISTER_LIMIT_PER_MINUTE; i++) await expect(register('203.0.113.7')).resolves.toBe(true);
    await expect(register('203.0.113.7')).rejects.toBeInstanceOf(ThrottlerException);
    // Another address has its own budget.
    await expect(register('203.0.113.8')).resolves.toBe(true);
  });

  it('keeps the default 100 a minute for every other route', async () => {
    const other = () =>
      guard.canActivate(contextFor('203.0.113.7', 'POST', '/token', FakeOAuthController.prototype.token));
    for (let i = 0; i < 100; i++) await expect(other()).resolves.toBe(true);
    await expect(other()).rejects.toBeInstanceOf(ThrottlerException);
  });

  it('matches only POST /register', () => {
    expect(isRegisterPost({ method: 'POST', path: '/register' })).toBe(true);
    expect(isRegisterPost({ method: 'POST', path: '/register/' })).toBe(true);
    expect(isRegisterPost({ method: 'GET', path: '/register' })).toBe(false);
    expect(isRegisterPost({ method: 'POST', path: '/api/auth/register' })).toBe(false);
    expect(isRegisterPost(undefined)).toBe(false);
  });
});
