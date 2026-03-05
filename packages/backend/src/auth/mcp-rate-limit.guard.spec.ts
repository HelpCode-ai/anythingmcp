import { HttpException, HttpStatus } from '@nestjs/common';
import { McpRateLimitGuard } from './mcp-rate-limit.guard';

describe('McpRateLimitGuard', () => {
  let guard: McpRateLimitGuard;
  let mockRedis: any;
  let mockConfig: any;

  const mockContext = (
    headers: Record<string, string> = {},
    ip = '127.0.0.1',
  ) => {
    const mockResponse = { header: jest.fn() };
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers, ip }),
        getResponse: () => mockResponse,
      }),
      _response: mockResponse,
    } as any;
  };

  beforeEach(() => {
    mockRedis = {
      isConnected: true,
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(true),
      ttl: jest.fn().mockResolvedValue(55),
    };
    mockConfig = {
      get: jest.fn().mockReturnValue('60'),
    };
    guard = new McpRateLimitGuard(mockRedis, mockConfig);
  });

  it('should allow request when Redis is not connected', async () => {
    mockRedis.isConnected = false;
    const result = await guard.canActivate(mockContext());
    expect(result).toBe(true);
    expect(mockRedis.incr).not.toHaveBeenCalled();
  });

  it('should allow request under rate limit', async () => {
    mockRedis.incr.mockResolvedValue(5);
    const result = await guard.canActivate(mockContext());
    expect(result).toBe(true);
  });

  it('should set rate limit headers on response', async () => {
    mockRedis.incr.mockResolvedValue(10);
    const ctx = mockContext();
    await guard.canActivate(ctx);
    const response = ctx.switchToHttp().getResponse();
    expect(response.header).toHaveBeenCalledWith('X-RateLimit-Limit', '60');
    expect(response.header).toHaveBeenCalledWith('X-RateLimit-Remaining', '50');
    expect(response.header).toHaveBeenCalledWith(
      'X-RateLimit-Reset',
      expect.any(String),
    );
  });

  it('should throw HttpException 429 when limit exceeded', async () => {
    mockRedis.incr.mockResolvedValue(61);
    await expect(guard.canActivate(mockContext())).rejects.toThrow(HttpException);
    try {
      await guard.canActivate(mockContext());
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    }
  });

  it('should set TTL on first request (incr returns 1)', async () => {
    mockRedis.incr.mockResolvedValue(1);
    await guard.canActivate(mockContext());
    expect(mockRedis.expire).toHaveBeenCalledWith(expect.any(String), 60);
  });

  it('should not set TTL on subsequent requests', async () => {
    mockRedis.incr.mockResolvedValue(5);
    await guard.canActivate(mockContext());
    expect(mockRedis.expire).not.toHaveBeenCalled();
  });

  it('should use API key for client identification when present', async () => {
    mockRedis.incr.mockResolvedValue(1);
    await guard.canActivate(mockContext({ 'x-api-key': 'my-key' }));
    expect(mockRedis.incr).toHaveBeenCalledWith('mcp:rate:key:my-key');
  });

  it('should fall back to IP for client identification', async () => {
    mockRedis.incr.mockResolvedValue(1);
    await guard.canActivate(mockContext({}, '10.0.0.1'));
    expect(mockRedis.incr).toHaveBeenCalledWith('mcp:rate:ip:10.0.0.1');
  });

  it('should allow request on Redis error (graceful degradation)', async () => {
    mockRedis.incr.mockRejectedValue(new Error('Redis connection lost'));
    const result = await guard.canActivate(mockContext());
    expect(result).toBe(true);
  });
});
