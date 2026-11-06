import { Logger } from '@nestjs/common';
import { ToolRateLimitService } from './tool-rate-limit.service';

const tool = { id: 'tool', name: 'sap_query' };
const context = { userId: 'user', organizationId: 'org', authMethod: 'jwt' };

function build(redisOverrides = {}) {
  const roles = { getToolRateLimits: jest.fn().mockResolvedValue({ callsPerMinute: 2, callsPerHour: 3 }) };
  const client = { eval: jest.fn().mockResolvedValue([0, 0, 0]) };
  const redis = { isConfigured: false, isConnected: false, getClient: () => client, ...redisOverrides };
  return { service: new ToolRateLimitService(roles as any, redis as any), roles, client };
}

describe('per-tool rate-limit admission', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(0); });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('enforces both windows; refusals do not use hourly quota or extend expiry', async () => {
    const { service } = build();
    expect(await service.check(tool, context)).toBeNull();
    expect(await service.check(tool, context)).toBeNull();
    jest.setSystemTime(10_000);
    expect(await service.check(tool, context)).toEqual({
      error: "Rate limit for tool 'sap_query': 2/min; retry in 50s.", retryAfter: 50,
    });
    jest.setSystemTime(60_000);
    expect(await service.check(tool, context)).toBeNull();
    expect(await service.check(tool, context)).toMatchObject({ retryAfter: 3540, error: expect.stringContaining('3/hour') });
    jest.setSystemTime(3_600_000);
    expect(await service.check(tool, context)).toBeNull();
  });

  it('uses the longest wait when both windows are exhausted', async () => {
    const { service, roles } = build();
    roles.getToolRateLimits.mockResolvedValue({ callsPerMinute: 1, callsPerHour: 1 });
    await service.check(tool, context);
    expect(await service.check(tool, context)).toMatchObject({ retryAfter: 3600, error: expect.stringContaining('1/min, 1/hour') });
  });

  it('admits exactly the limit under simultaneous calls without Redis', async () => {
    const { service } = build();
    const results = await Promise.all(Array.from({ length: 50 }, () => service.check(tool, context)));
    expect(results.filter((value) => value === null)).toHaveLength(2);
  });

  it('isolates organizations, tools, users and API-key names', async () => {
    const { service, roles } = build();
    roles.getToolRateLimits.mockResolvedValue({ callsPerMinute: 1, callsPerHour: null });
    await service.check(tool, context);
    expect(await service.check(tool, context)).not.toBeNull();
    for (const other of [
      { ...context, organizationId: 'other-org' },
      { ...context, userId: 'other-user' },
      { ...context, authMethod: 'mcp_api_key', apiKeyName: 'agent-a' },
      { ...context, authMethod: 'mcp_api_key', apiKeyName: 'agent-b' },
    ]) {
      expect(await service.check(tool, other)).toBeNull();
      expect(await service.check(tool, other)).not.toBeNull();
    }
    expect(await service.check({ ...tool, id: 'other-tool' }, context)).toBeNull();
  });

  it('uses the same 80-character API-key name bucket as the principal guard', async () => {
    const { service, roles } = build();
    roles.getToolRateLimits.mockResolvedValue({ callsPerMinute: 1, callsPerHour: null });
    await service.check(tool, { ...context, authMethod: 'mcp_api_key', apiKeyName: 'a'.repeat(80) + 'x' });
    expect(await service.check(tool, { ...context, authMethod: 'mcp_api_key', apiKeyName: 'a'.repeat(80) + 'y' })).not.toBeNull();
  });

  it('does not count unrestricted callers, operator calls, or unlimited grants', async () => {
    const { service, roles } = build();
    expect(await service.check(tool)).toBeNull();
    expect(roles.getToolRateLimits).not.toHaveBeenCalled();
    for (const policy of [null, { callsPerMinute: null, callsPerHour: null }]) {
      roles.getToolRateLimits.mockResolvedValue(policy);
      for (let i = 0; i < 5; i++) expect(await service.check(tool, context)).toBeNull();
    }
    roles.getToolRateLimits.mockResolvedValue({ callsPerMinute: 1, callsPerHour: null });
    expect(await service.check(tool, context)).toBeNull();
  });

  it('applies policy edits without resetting usage or creating role-specific allowances', async () => {
    const { service, roles } = build();
    await service.check(tool, context);
    roles.getToolRateLimits.mockResolvedValue({ callsPerMinute: 1, callsPerHour: null });
    expect(await service.check(tool, context)).not.toBeNull();
    roles.getToolRateLimits.mockResolvedValue({ callsPerMinute: 3, callsPerHour: null });
    expect(await service.check(tool, context)).toBeNull();
  });

  it('fails open with a throttled warning at local capacity, preserves existing quotas and reclaims expired buckets', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { service, roles } = build();
    roles.getToolRateLimits.mockResolvedValue({ callsPerMinute: 1, callsPerHour: null });
    for (let i = 0; i < 10_000; i++) await service.check(tool, { ...context, userId: `u${i}` });
    expect(await service.check(tool, context)).toBeNull();
    expect(await service.check(tool, context)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('local counter store is full'));
    expect(await service.check(tool, { ...context, userId: 'u0' })).toMatchObject({ error: expect.stringContaining('1/min') });
    jest.setSystemTime(60_000);
    expect(await service.check(tool, context)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    jest.setSystemTime(3_600_000);
    expect(await service.check(tool, context)).toBeNull();
    expect(await service.check(tool, context)).not.toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('fails open with a throttled warning if configured Redis is disconnected; no local fallback', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { service, roles, client } = build({ isConfigured: true });
    roles.getToolRateLimits.mockResolvedValue({ callsPerMinute: 1, callsPerHour: null });
    for (let i = 0; i < 5; i++) expect(await service.check(tool, context)).toBeNull();
    expect(client.eval).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    jest.setSystemTime(60_000);
    expect(await service.check(tool, context)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('fails open without logging connection credentials on a Redis command error', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { service, client } = build({ isConfigured: true, isConnected: true });
    client.eval.mockRejectedValue(new Error('redis://user:secret@host'));
    expect(await service.check(tool, context)).toBeNull();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });
});
