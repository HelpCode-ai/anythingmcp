import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';
import type { ExecutionContext } from '@nestjs/common';
import { AppThrottlerGuard, REGISTER_LIMIT_PER_MINUTE } from './app-throttler.guard';
import {
  DEFAULT_THROTTLERS,
  RedisThrottlerStorage,
  THROTTLE_KEY_PREFIX,
  throttlerModuleOptions,
} from './redis-throttler.storage';

/**
 * A stand-in for the Redis server: `eval` applies the storage's script rules
 * (fixed window, block on going over the limit, no counting while blocked)
 * to an in-process map with a fake clock, and records every call.
 */
function fakeRedis() {
  let now = 1_000_000;
  const values = new Map<string, { value: number; expiresAt: number }>();
  const live = (key: string) => {
    const v = values.get(key);
    if (v && v.expiresAt > now) return v;
    values.delete(key);
    return null;
  };
  const evalCalls: unknown[][] = [];
  const client = {
    eval: jest.fn(async (_script: string, _n: number, hitsKey: string, blockKey: string, ttl: string, limit: string, block: string) => {
      evalCalls.push([hitsKey, blockKey, ttl, limit, block]);
      const blocked = live(blockKey);
      if (blocked) {
        const hits = live(hitsKey);
        return [hits?.value ?? 0, hits ? hits.expiresAt - now : 0, 1, blocked.expiresAt - now];
      }
      let hits = live(hitsKey);
      if (!hits) {
        hits = { value: 0, expiresAt: now + Number(ttl) };
        values.set(hitsKey, hits);
      }
      hits.value += 1;
      const hitsTtl = hits.expiresAt - now;
      if (hits.value > Number(limit)) {
        if (Number(block) > 0) {
          values.set(blockKey, { value: 1, expiresAt: now + Number(block) });
          values.delete(hitsKey);
          return [hits.value, hitsTtl, 1, Number(block)];
        }
        return [hits.value, hitsTtl, 1, hitsTtl];
      }
      return [hits.value, hitsTtl, 0, 0];
    }),
  };
  const redis = { isConnected: true, getClient: () => client };
  return { redis, client, values, evalCalls, advance: (ms: number) => (now += ms) };
}

function contextFor(ip: string, method: string, path: string): ExecutionContext {
  class FakeController {
    handler() {}
  }
  const req = { ip, method, path, headers: {} };
  const res = { header: () => undefined };
  return {
    getHandler: () => FakeController.prototype.handler,
    getClass: () => FakeController,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

describe('RedisThrottlerStorage', () => {
  it('counts in Redis under namespaced keys that expire', async () => {
    const { redis, evalCalls } = fakeRedis();
    const storage = new RedisThrottlerStorage(redis as any);
    const record = await storage.increment('abc123', 60_000, 5, 60_000, 'default');
    expect(record).toEqual({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 });
    expect(evalCalls[0]).toEqual([
      `${THROTTLE_KEY_PREFIX}default:abc123`,
      `${THROTTLE_KEY_PREFIX}default:abc123:blocked`,
      '60000',
      '5',
      '60000',
    ]);
  });

  it('blocks over the limit for the block duration, then counts again', async () => {
    const { redis, advance } = fakeRedis();
    const storage = new RedisThrottlerStorage(redis as any);
    for (let i = 0; i < 5; i++) expect((await storage.increment('k', 60_000, 5, 30_000, 'default')).isBlocked).toBe(false);
    const over = await storage.increment('k', 60_000, 5, 30_000, 'default');
    expect(over).toMatchObject({ isBlocked: true, timeToBlockExpire: 30 });
    advance(10_000);
    expect(await storage.increment('k', 60_000, 5, 30_000, 'default')).toMatchObject({
      isBlocked: true,
      timeToBlockExpire: 20,
    });
    advance(20_001);
    expect(await storage.increment('k', 60_000, 5, 30_000, 'default')).toMatchObject({ isBlocked: false, totalHits: 1 });
  });

  it('keeps the counts across a restart (a new storage on the same Redis)', async () => {
    const fake = fakeRedis();
    const first = new RedisThrottlerStorage(fake.redis as any);
    for (let i = 0; i < 5; i++) await first.increment('k', 60_000, 5, 60_000, 'default');
    const afterDeploy = new RedisThrottlerStorage(fake.redis as any);
    expect((await afterDeploy.increment('k', 60_000, 5, 60_000, 'default')).isBlocked).toBe(true);
  });

  it('counts in memory while Redis is not connected', async () => {
    const fallback = new ThrottlerStorageService();
    const fake = fakeRedis();
    const storage = new RedisThrottlerStorage({ isConnected: false, getClient: () => fake.client } as any, fallback);
    for (let i = 0; i < 2; i++) expect((await storage.increment('k', 60_000, 2, 60_000, 'default')).isBlocked).toBe(false);
    expect((await storage.increment('k', 60_000, 2, 60_000, 'default')).isBlocked).toBe(true);
    expect(fake.client.eval).not.toHaveBeenCalled();
    storage.onApplicationShutdown();
  });

  it('counts in memory when a Redis call fails, without failing the request', async () => {
    const fallback = new ThrottlerStorageService();
    const client = { eval: jest.fn(async () => Promise.reject(new Error('READONLY'))) };
    const storage = new RedisThrottlerStorage({ isConnected: true, getClient: () => client } as any, fallback);
    await expect(storage.increment('k', 60_000, 2, 60_000, 'default')).resolves.toMatchObject({ totalHits: 1 });
    expect(client.eval).toHaveBeenCalled();
    storage.onApplicationShutdown();
  });

  it('keeps the stricter POST /register cap of AppThrottlerGuard', async () => {
    const { redis } = fakeRedis();
    const storage = new RedisThrottlerStorage(redis as any);
    const guard = new AppThrottlerGuard(DEFAULT_THROTTLERS, storage, new Reflector());
    await guard.onModuleInit();
    const register = (ip: string) => guard.canActivate(contextFor(ip, 'POST', '/register'));
    for (let i = 0; i < REGISTER_LIMIT_PER_MINUTE; i++) await expect(register('203.0.113.7')).resolves.toBe(true);
    await expect(register('203.0.113.7')).rejects.toBeInstanceOf(ThrottlerException);
    await expect(register('203.0.113.8')).resolves.toBe(true);
  });
});

describe('throttlerModuleOptions', () => {
  const redis = { isConnected: false, getClient: () => null } as any;

  it('keeps the in-memory default without REDIS_URL', () => {
    expect(throttlerModuleOptions(undefined, redis)).toBe(DEFAULT_THROTTLERS);
    expect(throttlerModuleOptions('  ', redis)).toBe(DEFAULT_THROTTLERS);
    expect(DEFAULT_THROTTLERS).toEqual([{ ttl: 60_000, limit: 100 }]);
  });

  it('uses Redis storage with REDIS_URL, with the same bucket', () => {
    const options = throttlerModuleOptions('redis://localhost:6379', redis) as any;
    expect(options.throttlers).toBe(DEFAULT_THROTTLERS);
    expect(options.storage).toBeInstanceOf(RedisThrottlerStorage);
  });
});
