import { DynamicMcpTools } from './dynamic-mcp-tools';
import type { RegisteredTool } from './tool-registry';
import { Logger } from '@nestjs/common';
import { ConnectorsService } from '../connectors/connectors.service';
import { envVarsForMcpTool } from '../connectors/mcp-connector-config.util';

/**
 * A bridge to a remote MCP server sends the call's parameters to that server
 * as tool arguments. The connector's variables used to be added to them on
 * every call, credentials included; now only the ones the remote tool's
 * schema names are.
 */
const TOKEN = 'ghp_' + 'Zq9xR4vN2pL7'.repeat(3);
const ENV = {
  GITHUB_TOKEN: TOKEN,
  GITHUB_ORG: 'acme',
  owner: 'acme-from-a-variable',
};

describe('envVarsForMcpTool', () => {
  it('keeps only the variables that are top-level properties of the schema', () => {
    expect(
      envVarsForMcpTool(ENV, { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } } }),
    ).toEqual({ owner: 'acme-from-a-variable' });
  });

  it('keeps none for a schema without properties', () => {
    expect(envVarsForMcpTool(ENV, { type: 'object' })).toEqual({});
    expect(envVarsForMcpTool(ENV, undefined)).toEqual({});
  });

  it('does not take a name from the object prototype for a property', () => {
    expect(envVarsForMcpTool({ toString: 'x' }, { type: 'object', properties: {} })).toEqual({});
  });
});

describe('DynamicMcpTools: arguments of a bridged MCP tool call', () => {
  function tool(connectorType: 'MCP' | 'REST'): RegisteredTool {
    return {
      id: 'tool-1',
      connectorId: 'conn-1',
      organizationId: 'org-1',
      name: 'github_list_issues',
      description: 'List issues',
      parameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } } },
      connectorType,
      connectorConfig: {
        baseUrl: 'https://mcp.example.test/mcp',
        authType: 'BEARER_TOKEN',
        envVars: ENV,
      },
      endpointMapping: { method: connectorType === 'MCP' ? 'list_issues' : 'GET', path: connectorType === 'MCP' ? '/mcp' : '/issues' },
    } as unknown as RegisteredTool;
  }

  function build(t: RegisteredTool) {
    const engine = { execute: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: '[]' }] }) };
    const unexpected = { execute: jest.fn().mockRejectedValue(new Error('unexpected engine')) };
    const isMcp = t.connectorType === 'MCP';
    const executor = new DynamicMcpTools(
      { getTool: () => t, getToolForOrg: () => t } as any,
      { logInvocation: jest.fn().mockResolvedValue(undefined) } as any,
      { get: jest.fn().mockResolvedValue(null), set: jest.fn(), incr: jest.fn(), expire: jest.fn(), ttl: jest.fn() } as any,
      { checkLicenseActive: jest.fn().mockResolvedValue(undefined) } as any,
      { isCloud: () => false } as any,
      {} as any,
      (isMcp ? unexpected : engine) as any,
      unexpected as any,
      unexpected as any,
      (isMcp ? engine : unexpected) as any,
      unexpected as any,
      { scheduleObservationalIngest: jest.fn() } as any,
      { recentEvents: jest.fn().mockResolvedValue([]) } as any,
      unexpected as any,
    );
    return { executor, engine };
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("sends only what the caller passed and the variables the remote schema names, never the connector's token", async () => {
    const { executor, engine } = build(tool('MCP'));
    await executor.executeTool('github_list_issues', { repo: 'web' });
    const [, , args] = engine.execute.mock.calls[0];
    expect(args).toEqual({ repo: 'web', owner: 'acme-from-a-variable' });
    expect(JSON.stringify(args)).not.toContain(TOKEN);
  });

  it('lets a value the caller passed win over a variable of the same name', async () => {
    const { executor, engine } = build(tool('MCP'));
    await executor.executeTool('github_list_issues', { owner: 'other', repo: 'web' });
    expect(engine.execute.mock.calls[0][2]).toEqual({ owner: 'other', repo: 'web' });
  });

  it('still gives a REST tool every variable, for $name in its mapping', async () => {
    const { executor, engine } = build(tool('REST'));
    await executor.executeTool('github_list_issues', { repo: 'web' });
    expect(engine.execute.mock.calls[0][2]).toMatchObject({ repo: 'web', GITHUB_ORG: 'acme' });
  });
});

describe('ConnectorsService.executeConnectorCall: a bridged MCP tool (Run Test, setup check)', () => {
  const mcpClientEngine = { execute: jest.fn().mockResolvedValue({ content: [] }) };
  const service = new ConnectorsService(
    {} as any,
    { get: () => 'k'.repeat(24) + 'Zq7!pL2@vN9#xR4$' } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    mcpClientEngine as any,
  );

  it('sends the same arguments a real call does', async () => {
    await service.executeConnectorCall(
      {
        id: 'c1',
        name: 'GitHub',
        type: 'MCP',
        baseUrl: 'https://mcp.example.test/mcp',
        authType: 'NONE',
        authConfig: null,
        headers: null,
        specUrl: null,
        envVars: ENV,
        config: {},
      } as any,
      { method: 'list_issues', path: '/mcp' },
      { repo: 'web' },
      'github_list_issues',
      { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } } },
    );
    const [, , args] = mcpClientEngine.execute.mock.calls[0];
    expect(args).toEqual({ repo: 'web', owner: 'acme-from-a-variable' });
  });
});
