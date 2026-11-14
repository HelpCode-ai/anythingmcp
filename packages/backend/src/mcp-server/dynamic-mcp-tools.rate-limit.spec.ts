import { Logger } from '@nestjs/common';
import { DynamicMcpTools } from './dynamic-mcp-tools';
import { ToolRateLimitService } from './tool-rate-limit.service';
import type { RegisteredTool } from './tool-registry';
import type { CodeRunInput } from './code-executor.service';

const readTool: RegisteredTool = {
  id: 'read', name: 'sap_query', connectorId: 'connector', organizationId: 'org',
  description: 'Query', parameters: { type: 'object', properties: {} }, connectorType: 'REST',
  connectorConfig: { baseUrl: 'https://example.test', authType: 'NONE' },
  endpointMapping: { method: 'GET', path: '/query' },
};
const context = { userId: 'user', organizationId: 'org', authMethod: 'jwt', allowedToolIds: ['read', 'code'] };

function build(cached = false) {
  const roles = {
    getToolRateLimits: jest.fn(async (_user: string, _org: string, toolId: string) =>
      toolId === 'read' ? { callsPerMinute: 1, callsPerHour: null } : null),
  };
  const redis = { isConfigured: false, get: jest.fn().mockResolvedValue(cached ? '{"cached":true}' : null), set: jest.fn() };
  const limiter = new ToolRateLimitService(roles as any, redis as any);
  const read = { ...readTool, responseMapping: cached ? { cacheTtl: 60 } : undefined };
  const code = {
    ...readTool, id: 'code', name: 'code_query',
    endpointMapping: {
      method: 'code', path: '', code: "return await amcp.run('sap_query', {});",
      uses: [{ connectorId: 'connector' }], runAs: 'invoker', allowWrites: false,
    },
  };
  const tools = [read, code] as RegisteredTool[];
  const engine = { execute: jest.fn().mockResolvedValue({ ok: true }) };
  const audit = { logInvocation: jest.fn().mockResolvedValue(undefined) };
  const runner = {
    isConfigured: () => true,
    run: jest.fn(async (input: CodeRunInput) => {
      try {
        const value = await input.bridge.run('sap_query', {});
        return { ok: true, value, calls: [], logs: [], durationMs: 1 };
      } catch (error) {
        return { ok: false, error: { name: 'Error', message: (error as Error).message }, calls: [], logs: [], durationMs: 1 };
      }
    }),
  };
  const executor = new DynamicMcpTools(
    {
      getTool: (name: string) => tools.find((tool) => tool.name === name),
      getToolForOrg: (name: string) => tools.find((tool) => tool.name === name),
    } as any,
    audit as any,
    redis as any,
    { checkLicenseActive: jest.fn().mockResolvedValue(undefined) } as any,
    { isCloud: () => false } as any,
    {
      codeRun: { create: jest.fn().mockResolvedValue({ id: 'run' }) },
      mcpServerConfig: { findUnique: jest.fn().mockResolvedValue({ codeMode: 'tools' }) },
    } as any,
    engine as any, engine as any, engine as any, engine as any, engine as any,
    { scheduleObservationalIngest: jest.fn() } as any, {} as any,
    undefined, undefined, undefined, runner as any, undefined, undefined, limiter,
  );
  return { executor, engine, roles, runner, audit };
}

describe('per-tool limits in the common executor', () => {
  beforeEach(() => { jest.spyOn(Logger.prototype, 'log').mockImplementation(); });
  afterEach(() => { jest.restoreAllMocks(); });

  it('returns an MCP tool error before the upstream call and shares usage across server entry points', async () => {
    const { executor, engine } = build();
    // Shared /mcp context versus per-server /mcp/<id> context.
    expect((await executor.executeTool('sap_query', {}, context)).isError).toBeUndefined();
    const refused = await executor.executeTool('sap_query', {}, { ...context, mcpServerId: 'server', connectorIds: ['connector'] });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0].text)).toMatchObject({ error: expect.stringContaining('1/min'), retryAfter: 60 });
    expect(engine.execute).toHaveBeenCalledTimes(1);
  });

  it('records a refused call in the invocation log, without the connector', async () => {
    const { executor, audit } = build();
    await executor.executeTool('sap_query', { q: 1 }, context);
    audit.logInvocation.mockClear();
    await executor.executeTool('sap_query', { q: 2 }, context);
    expect(audit.logInvocation).toHaveBeenCalledTimes(1);
    const row = audit.logInvocation.mock.calls[0][0];
    expect(row).toMatchObject({ toolId: 'read', organizationId: 'org', userId: 'user', status: 'ERROR', input: { q: 2 } });
    expect(row.error).toMatch(/^Rate limit reached: .*1\/min/);
    // Connector health and failure alerts group by connector; a refusal is not a connector failure.
    expect(row.connectorId).toBeUndefined();
  });

  it('still refuses when the log cannot be written', async () => {
    const { executor, audit, engine } = build();
    await executor.executeTool('sap_query', {}, context);
    audit.logInvocation.mockRejectedValueOnce(new Error('db down'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    expect((await executor.executeTool('sap_query', {}, context)).isError).toBe(true);
    expect(engine.execute).toHaveBeenCalledTimes(1);
  });

  it('counts cache hits as tool invocations', async () => {
    const { executor, engine } = build(true);
    expect((await executor.executeTool('sap_query', {}, context)).isError).toBeUndefined();
    expect((await executor.executeTool('sap_query', {}, context)).isError).toBe(true);
    expect(engine.execute).not.toHaveBeenCalled();
  });

  it('counts nested Code Mode calls against the direct-call budget', async () => {
    const { executor, engine, runner } = build();
    expect((await executor.executeTool('code_query', {}, context)).isError).toBeUndefined();
    expect(runner.run).toHaveBeenCalledTimes(1);
    const refused = await executor.executeTool('sap_query', {}, context);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('1/min');
    expect(engine.execute).toHaveBeenCalledTimes(1);
  });

  it('does not turn a policy-read failure into an upstream call or echo database errors', async () => {
    const { executor, engine, roles } = build();
    roles.getToolRateLimits.mockRejectedValue(new Error('postgres://user:secret@host'));
    const result = await executor.executeTool('sap_query', {}, context);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('secret');
    expect(engine.execute).not.toHaveBeenCalled();
  });
});
