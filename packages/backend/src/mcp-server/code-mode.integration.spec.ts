import { DynamicMcpTools } from './dynamic-mcp-tools';
import { ToolRegistry, type RegisteredTool } from './tool-registry';
import { CodeExecutorService } from './code-executor.service';

/**
 * End-to-end code mode: the REAL backend executor and the REAL code-runner
 * container wired as one system. A code tool runs in the isolated Deno
 * subprocess, calls two tools back over the amcp bridge, and the program
 * combines their results — the whole path (CodeExecutorService → WebSocket →
 * supervisor → sandbox → bridge → executeTool → engine dispatch) exercised live.
 *
 * Opt-in: needs a running runner. Start one and point the backend at it:
 *   docker build -t amcp-code-runner:test deploy/code-runner
 *   docker run -d -p 18799:8777 --read-only --tmpfs /tmp/code-runner:mode=1777 \
 *     --security-opt no-new-privileges=true --cap-drop ALL --cap-add SETUID \
 *     --cap-add SETGID amcp-code-runner:test
 *   RUN_CODE_RUNNER_LIVE=1 CODE_RUNNER_URL=ws://127.0.0.1:18799 \
 *     npx jest src/mcp-server/code-mode.integration.spec.ts
 */

const RUN = process.env.RUN_CODE_RUNNER_LIVE === '1';

const baseTool = (over: Partial<RegisteredTool> & { id: string; name: string; endpointMapping: any }): RegisteredTool => ({
  connectorId: 'c1',
  organizationId: 'org1',
  description: over.name,
  parameters: { type: 'object', properties: {} },
  connectorType: 'REST',
  connectorConfig: { baseUrl: 'https://x', authType: 'NONE' },
  responseMapping: undefined,
  ...over,
}) as RegisteredTool;

(RUN ? describe : describe.skip)('code mode — live end-to-end through the real runner', () => {
  let executor: DynamicMcpTools;
  const audit = { logInvocation: jest.fn().mockResolvedValue(undefined) };

  beforeAll(() => {
    const registry = new ToolRegistry();
    // Two read-only "static" tools (no network/engine) and a code tool that
    // orchestrates both. Static keeps the test off the SSRF-guarded HTTP path
    // while still exercising executeTool's real engine dispatch.
    registry.registerTool(baseTool({ id: 'a', name: 'tool_a', endpointMapping: { method: 'static', path: '', staticResponse: '{"a":2}' } }));
    registry.registerTool(baseTool({ id: 'b', name: 'tool_b', endpointMapping: { method: 'static', path: '', staticResponse: '{"b":40}' } }));
    registry.registerTool(
      baseTool({
        id: 'code',
        name: 'sum_two',
        endpointMapping: {
          method: 'code',
          path: '',
          code:
            "const a = JSON.parse((await amcp.run('tool_a', {})).text);\n" +
            "const b = JSON.parse((await amcp.run('tool_b', {})).text);\n" +
            'return { total: a.a + b.b };',
          uses: [{ connectorId: 'c1' }],
          runAs: 'invoker',
          allowWrites: false,
        },
      }),
    );

    const stub = { execute: jest.fn() };
    const prisma = {
      codeRun: { create: jest.fn().mockResolvedValue({ id: 'cr1' }) },
      mcpServerConfig: { findUnique: jest.fn().mockResolvedValue({ codeMode: 'tools' }) },
    };
    executor = new DynamicMcpTools(
      registry as any,
      audit as any,
      { get: jest.fn().mockResolvedValue(null), set: jest.fn(), incr: jest.fn(), expire: jest.fn(), ttl: jest.fn() } as any,
      { checkLicenseActive: jest.fn().mockResolvedValue(undefined) } as any,
      { isCloud: () => false } as any,
      prisma as any,
      stub as any,
      stub as any,
      stub as any,
      stub as any,
      stub as any,
      { scheduleObservationalIngest: jest.fn() } as any,
      { recentEvents: jest.fn().mockResolvedValue([]) } as any,
      stub as any,
      undefined,
      undefined,
      new CodeExecutorService(),
    );
  });

  it('runs a code tool that orchestrates two tools in the sandbox and returns their sum', async () => {
    const res = await executor.executeTool('sum_two', {}, {
      organizationId: 'org1',
      // operator-style (no userId): unrestricted role, so invoker allows the calls
    });
    expect(res.isError).toBeUndefined();
    expect(res.structured).toEqual({ total: 42 });
  }, 20000);

  it('contains an escape attempt made from inside a code tool', async () => {
    const registry = (executor as any).toolRegistry as ToolRegistry;
    registry.registerTool(
      baseTool({
        id: 'evil',
        name: 'evil',
        endpointMapping: {
          method: 'code',
          path: '',
          code: "return await fetch('https://example.com').then(r => r.status);",
          uses: [{ connectorId: 'c1' }],
          runAs: 'invoker',
          allowWrites: false,
        },
      }),
    );
    const res = await executor.executeTool('evil', {}, { organizationId: 'org1' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/NotCapable|net access|denied/i);
  }, 20000);
});
