import { DynamicMcpTools } from './dynamic-mcp-tools';
import type { RegisteredTool } from './tool-registry';
import type { CodeRunInput, CodeRunResult } from './code-executor.service';

/**
 * Integration of the code-tool branch in executeTool: the real bridge wiring
 * (resolveTool / runTool / allowedToolIds / inCodeRun guard) against a fake
 * code-runner and static inner tools (which need no engine or network). Sandbox
 * containment is covered by deploy/code-runner; the bridge's access rules by
 * code-tool.util.spec; this proves they are wired together correctly.
 */

const codeTool = (over: Record<string, unknown> = {}): RegisteredTool => ({
  id: 'code-1',
  connectorId: 'c-home',
  organizationId: 'org1',
  name: 'summary',
  description: 'A code tool',
  parameters: { type: 'object', properties: {} },
  connectorType: 'REST',
  connectorConfig: { baseUrl: 'https://x', authType: 'NONE' },
  endpointMapping: {
    method: 'code',
    code: 'return 1;',
    uses: [{ connectorId: 'c1' }],
    runAs: 'invoker',
    allowWrites: false,
    ...over,
  } as any,
});

const innerRead: RegisteredTool = {
  id: 'read-1',
  connectorId: 'c1',
  organizationId: 'org1',
  name: 'inner_read',
  description: 'reads',
  parameters: { type: 'object', properties: {} },
  connectorType: 'REST',
  connectorConfig: { baseUrl: 'https://x', authType: 'NONE' },
  endpointMapping: { method: 'static', path: '', staticResponse: 'READVALUE' } as any,
};

const innerWrite: RegisteredTool = {
  id: 'write-1',
  connectorId: 'c1',
  organizationId: 'org1',
  name: 'inner_write',
  description: 'writes',
  parameters: { type: 'object', properties: {} },
  connectorType: 'REST',
  connectorConfig: { baseUrl: 'https://x', authType: 'NONE' },
  endpointMapping: { method: 'POST', path: '/write' } as any,
};

/** A fake runner that runs a provided program against the real bridge. */
function fakeRunner(program: (bridge: any) => Promise<unknown>, configured = true) {
  return {
    isConfigured: () => configured,
    run: async (input: CodeRunInput): Promise<CodeRunResult> => {
      const calls: { fn: string; tool?: string }[] = [];
      const wrapped = {
        search: (q: string, o: any) => (calls.push({ fn: 'search' }), input.bridge.search(q, o)),
        describe: (t: string) => (calls.push({ fn: 'describe', tool: t }), input.bridge.describe(t)),
        run: (t: string, a: any) => (calls.push({ fn: 'run', tool: t }), input.bridge.run(t, a)),
      };
      try {
        const value = await program(wrapped);
        return { ok: true, value, logs: [], calls, durationMs: 1 };
      } catch (e: any) {
        return { ok: false, error: { name: e?.name ?? 'Error', message: String(e?.message ?? e) }, logs: [], calls, durationMs: 1 };
      }
    },
  };
}

function build(tools: RegisteredTool[], program: (bridge: any) => Promise<unknown>, opts: { configured?: boolean } = {}) {
  const byId = new Map(tools.map((t) => [t.id, t]));
  const registry = {
    getTool: (name: string, connectorIds?: string[]) => {
      const matches = tools.filter((t) => t.name === name);
      if (!connectorIds) return matches[0];
      return matches.find((t) => connectorIds.includes(t.connectorId));
    },
    getToolForOrg: (name: string, org: string) => tools.find((t) => t.name === name && t.organizationId === org),
    getAllTools: () => tools,
  };
  const audit = { logInvocation: jest.fn().mockResolvedValue(undefined) };
  const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), incr: jest.fn(), expire: jest.fn(), ttl: jest.fn() };
  const license = { checkLicenseActive: jest.fn().mockResolvedValue(undefined) };
  const kg = { scheduleObservationalIngest: jest.fn() };
  const reject = { execute: jest.fn().mockRejectedValue(new Error('unexpected engine call')) };
  const codeExecutor = fakeRunner(program, opts.configured ?? true);
  const prisma = {
    codeRun: { create: jest.fn().mockResolvedValue({ id: 'cr1' }) },
    mcpServerConfig: { findUnique: jest.fn().mockResolvedValue({ codeMode: 'tools' }) },
  };
  const executor = new DynamicMcpTools(
    registry as any,
    audit as any,
    redis as any,
    license as any,
    { isCloud: () => false } as any,
    prisma as any,
    reject as any, // rest
    reject as any, // graphql
    reject as any, // soap
    reject as any, // mcpClient
    reject as any, // database
    kg as any,
    reject as any, // odata
    undefined, // userCredentials
    undefined, // emailEngine
    codeExecutor as any,
  );
  void byId;
  return { executor, audit, codeExecutor, prisma };
}

describe('DynamicMcpTools — code tools', () => {
  it('runs a code tool and reaches an allowed read tool through the bridge', async () => {
    const { executor, audit, prisma } = build([codeTool(), innerRead], (b) => b.run('inner_read', {}));
    const res = await executor.executeTool('summary', {}, {
      userId: 'u1',
      organizationId: 'org1',
      allowedToolIds: ['code-1', 'read-1'],
    });
    expect(res.isError).toBeUndefined();
    expect(res.structured).toEqual({ text: 'READVALUE' });
    // one audit row for the code tool itself, flagged as a code run
    const codeRow = audit.logInvocation.mock.calls.map((c: any[]) => c[0]).find((r: any) => r.toolId === 'code-1');
    expect(codeRow).toBeTruthy();
    expect(JSON.parse(codeRow.clientInfo).codeRun).toBe(true);
    // one code_runs row for the run itself
    expect(prisma.codeRun.create).toHaveBeenCalledTimes(1);
    const runRow = prisma.codeRun.create.mock.calls[0][0].data;
    expect(runRow).toMatchObject({ organizationId: 'org1', toolId: 'code-1', source: 'tool', status: 'SUCCESS', toolCallCount: 1 });
  });

  it('refuses when the server has code mode turned off', async () => {
    const { executor, prisma } = build([codeTool(), innerRead], (b) => b.run('inner_read', {}));
    prisma.mcpServerConfig.findUnique.mockResolvedValueOnce({ codeMode: 'off' });
    const res = await executor.executeTool('summary', {}, {
      userId: 'u1',
      organizationId: 'org1',
      mcpServerId: 'srv1',
      allowedToolIds: ['code-1', 'read-1'],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('turned off');
    expect(prisma.codeRun.create).not.toHaveBeenCalled();
  });

  it('invoker mode denies an inner tool the caller role does not allow', async () => {
    const { executor } = build([codeTool(), innerRead], (b) => b.run('inner_read', {}));
    const res = await executor.executeTool('summary', {}, {
      userId: 'u1',
      organizationId: 'org1',
      allowedToolIds: ['code-1'], // read-1 NOT allowed
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Access denied');
  });

  it('fails closed for an identified caller when allowedToolIds is unknown', async () => {
    const { executor } = build([codeTool(), innerRead], (b) => b.run('inner_read', {}));
    const res = await executor.executeTool('summary', {}, { userId: 'u1', organizationId: 'org1' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Access denied');
  });

  it('allows an operator (no userId) with no allowedToolIds', async () => {
    const { executor } = build([codeTool(), innerRead], (b) => b.run('inner_read', {}));
    const res = await executor.executeTool('summary', {});
    expect(res.isError).toBeUndefined();
    expect(res.structured).toEqual({ text: 'READVALUE' });
  });

  it('refuses a write tool from a read-only code tool', async () => {
    const { executor } = build([codeTool(), innerWrite], (b) => b.run('inner_write', {}));
    const res = await executor.executeTool('summary', {}, { organizationId: 'org1' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('read-only');
  });

  it('allows a write tool when the code tool is allowWrites (and reaches the engine)', async () => {
    // innerWrite is POST; with allowWrites the bridge permits it. The engine is
    // the rejecting stub, so a reached call throws "unexpected engine call" —
    // proof the bridge let it through rather than refusing on policy.
    const { executor } = build([codeTool({ allowWrites: true }), innerWrite], (b) => b.run('inner_write', {}));
    const res = await executor.executeTool('summary', {}, { organizationId: 'org1' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('unexpected engine call');
    expect(res.content[0].text).not.toContain('read-only');
  });

  it('refuses a code tool called from within another code run (no recursion)', async () => {
    const { executor } = build([codeTool()], (b) => b.run('x', {}));
    const res = await executor.executeTool('summary', {}, { inCodeRun: true });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('within a code run');
  });

  it('refuses when no runner is configured', async () => {
    const { executor } = build([codeTool(), innerRead], (b) => b.run('inner_read', {}), { configured: false });
    const res = await executor.executeTool('summary', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not available');
  });

  it('refuses reaching a connector not in uses', async () => {
    const other: RegisteredTool = { ...innerRead, id: 'o-1', name: 'other_read', connectorId: 'c-other' };
    const { executor } = build([codeTool(), other], (b) => b.run('other_read', {}));
    const res = await executor.executeTool('summary', {}, { organizationId: 'org1' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not a tool this code tool can use|uses/);
  });
});

describe('DynamicMcpTools — inline code', () => {
  it('runs inline code over the given connectors and writes an inline code_runs row', async () => {
    const { executor, prisma } = build([innerRead], (b) => b.run('inner_read', {}));
    const res = await executor.executeInlineCode(
      'return await amcp.run("inner_read", {});',
      { userId: 'u1', organizationId: 'org1' },
      { connectorIds: ['c1'], allowedToolIds: ['read-1'] },
    );
    expect(res.isError).toBeUndefined();
    expect(res.structured).toEqual({ text: 'READVALUE' });
    expect(prisma.codeRun.create).toHaveBeenCalledTimes(1);
    expect(prisma.codeRun.create.mock.calls[0][0].data).toMatchObject({
      organizationId: 'org1',
      toolId: null,
      source: 'inline',
      status: 'SUCCESS',
    });
  });

  it('inline code is read-only: a write tool is refused', async () => {
    const { executor } = build([innerWrite], (b) => b.run('inner_write', {}));
    const res = await executor.executeInlineCode(
      'return await amcp.run("inner_write", {});',
      { userId: 'u1', organizationId: 'org1' },
      { connectorIds: ['c1'], allowedToolIds: ['write-1'] },
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('read-only');
  });

  it('inline code re-checks the caller role (invoker rights)', async () => {
    const { executor } = build([innerRead], (b) => b.run('inner_read', {}));
    const res = await executor.executeInlineCode(
      'return await amcp.run("inner_read", {});',
      { userId: 'u1', organizationId: 'org1' },
      { connectorIds: ['c1'], allowedToolIds: [] }, // caller may use nothing
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Access denied');
  });

  it('refuses inline code when no runner is configured', async () => {
    const { executor } = build([innerRead], (b) => b.run('inner_read', {}), { configured: false });
    const res = await executor.executeInlineCode('return 1;', { organizationId: 'org1' }, { connectorIds: ['c1'], allowedToolIds: null });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not available');
  });

  it('reports codeModeAvailable from the runner', () => {
    const { executor } = build([innerRead], (b) => b.run('x', {}));
    expect(executor.codeModeAvailable()).toBe(true);
    const off = build([innerRead], (b) => b.run('x', {}), { configured: false });
    expect(off.executor.codeModeAvailable()).toBe(false);
  });
});
