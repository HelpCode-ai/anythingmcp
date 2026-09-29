import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// A stand-in for ioredis: an event emitter with a connect() the test controls.
const instances: FakeRedis[] = [];
class FakeRedis extends EventEmitter {
  status = 'wait';
  constructor(
    public url: string,
    public opts: unknown,
  ) {
    super();
    instances.push(this);
  }
  connect = jest.fn(async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
  });
}
jest.mock('ioredis', () => ({ __esModule: true, default: FakeRedis }));

import { RedisService } from './redis.service';

const config = (env: Record<string, string | undefined>) =>
  ({ get: (key: string) => env[key] }) as unknown as ConfigService;

describe('RedisService', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    instances.length = 0;
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('creates no client and connects nowhere when REDIS_URL is not set', async () => {
    const svc = new RedisService(config({}));
    await svc.onModuleInit();

    expect(instances).toHaveLength(0);
    expect(svc.isConfigured).toBe(false);
    expect(svc.isConnected).toBe(false);
    expect(await svc.get('k')).toBeNull();
    expect(await svc.incr('k')).toBe(0);
    await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats a blank REDIS_URL as not set', async () => {
    const svc = new RedisService(config({ REDIS_URL: '   ' }));
    await svc.onModuleInit();
    expect(instances).toHaveLength(0);
  });

  it('logs a repeated connection error once, and again after a recovery', async () => {
    const svc = new RedisService(config({ REDIS_URL: 'redis://redis:6379' }));
    await svc.onModuleInit();

    expect(instances).toHaveLength(1);
    expect(instances[0].url).toBe('redis://redis:6379');
    expect(svc.isConfigured).toBe(true);
    warn.mockClear(); // the failed first connect() is reported on its own

    const refused = new Error('connect ECONNREFUSED 10.0.0.5:6379');
    for (let i = 0; i < 5; i++) instances[0].emit('error', refused);
    expect(warn).toHaveBeenCalledTimes(1);

    instances[0].emit('ready');
    instances[0].emit('error', refused);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
