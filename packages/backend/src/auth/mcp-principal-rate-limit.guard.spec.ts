import { HttpException } from '@nestjs/common';
import {
  DEFAULT_MCP_PRINCIPAL_LIMIT_PER_MINUTE,
  McpPrincipalRateLimitGuard,
} from './mcp-principal-rate-limit.guard';

function makeRedis(connected = true) {
  const counts = new Map<string, number>();
  return {
    counts,
    get isConnected() {
      return connected;
    },
    incr: jest.fn(async (k: string) => {
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      return n;
    }),
    expire: jest.fn(async () => undefined),
    ttl: jest.fn(async () => 42),
  };
}

function ctx(req: any) {
  const res = { setHeader: jest.fn() };
  return {
    res,
    context: {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as any,
  };
}

const config = (v?: string) => ({ get: jest.fn(() => v) }) as any;

describe('McpPrincipalRateLimitGuard', () => {
  it('defaults to a high ceiling', async () => {
    const redis = makeRedis();
    const guard = new McpPrincipalRateLimitGuard(redis as any, config(undefined));
    const req = { method: 'POST', headers: { 'x-api-key': 'mcp_a' }, user: { authMethod: 'mcp_api_key', sub: 'u1' } };
    for (let i = 0; i < DEFAULT_MCP_PRINCIPAL_LIMIT_PER_MINUTE; i++) {
      await expect(guard.canActivate(ctx(req).context)).resolves.toBe(true);
    }
    await expect(guard.canActivate(ctx(req).context)).rejects.toBeInstanceOf(HttpException);
  });

  it('refuses over the limit with 429 and Retry-After, per API key', async () => {
    const redis = makeRedis();
    const guard = new McpPrincipalRateLimitGuard(redis as any, config('2'));
    const a = { method: 'POST', headers: { 'x-api-key': 'mcp_a' }, user: { authMethod: 'mcp_api_key', sub: 'u1', apiKeyName: 'Backend' } };
    const b = { method: 'POST', headers: { 'x-api-key': 'mcp_b' }, user: { authMethod: 'mcp_api_key', sub: 'u1', apiKeyName: 'Laptop' } };
    await guard.canActivate(ctx(a).context);
    await guard.canActivate(ctx(a).context);
    const third = ctx(a);
    await expect(guard.canActivate(third.context)).rejects.toMatchObject({ status: 429 });
    expect(third.res.setHeader).toHaveBeenCalledWith('Retry-After', '42');
    // Another key of the same user has its own bucket.
    await expect(guard.canActivate(ctx(b).context)).resolves.toBe(true);
  });

  it('never puts the API key into the bucket name', async () => {
    const redis = makeRedis();
    const guard = new McpPrincipalRateLimitGuard(redis as any, config('5'));
    await guard.canActivate(
      ctx({ method: 'POST', headers: { 'x-api-key': 'mcp_secret_value' }, user: { authMethod: 'mcp_api_key', sub: 'u1', apiKeyName: 'Backend' } }).context,
    );
    expect([...redis.counts.keys()]).toEqual(['mcp:prl:key:u1:Backend']);
  });

  it('buckets sessions by user and anonymous callers by IP', () => {
    expect(McpPrincipalRateLimitGuard.bucketFor({ user: { authMethod: 'jwt', sub: 'u9' }, headers: {} })).toBe('user:u9');
    expect(McpPrincipalRateLimitGuard.bucketFor({ user: { authMethod: 'none' }, headers: {}, ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
  });

  it('ignores GET (the event stream), honours 0 = off, and fails open without Redis', async () => {
    const redis = makeRedis();
    const guard = new McpPrincipalRateLimitGuard(redis as any, config('1'));
    const get = { method: 'GET', headers: {}, user: { authMethod: 'none' }, ip: '1.1.1.1' };
    await guard.canActivate(ctx(get).context);
    await guard.canActivate(ctx(get).context);
    expect(redis.incr).not.toHaveBeenCalled();

    const off = new McpPrincipalRateLimitGuard(makeRedis() as any, config('0'));
    const post = { method: 'POST', headers: {}, user: { authMethod: 'none' }, ip: '1.1.1.1' };
    for (let i = 0; i < 5; i++) await expect(off.canActivate(ctx(post).context)).resolves.toBe(true);

    const noRedis = new McpPrincipalRateLimitGuard(makeRedis(false) as any, config('1'));
    for (let i = 0; i < 3; i++) await expect(noRedis.canActivate(ctx(post).context)).resolves.toBe(true);
  });
});
