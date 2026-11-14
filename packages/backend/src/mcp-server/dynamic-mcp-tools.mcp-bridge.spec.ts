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

  describe('fixed arguments (config.mcpFixedArguments)', () => {
    const withConfig = (connectorType: 'MCP' | 'REST', config: Record<string, unknown> | undefined): RegisteredTool => {
      const t = tool(connectorType);
      (t.connectorConfig as unknown as { config?: unknown }).config = config;
      return t;
    };

    it('hands the engine nothing extra for a connector without the setting', async () => {
      for (const config of [undefined, {}, { mcpToolPrefix: 'github_' }, { mcpFixedArguments: {} }]) {
        const { executor, engine } = build(withConfig('MCP', config));
        await executor.executeTool('github_list_issues', { repo: 'web' });
        expect(engine.execute.mock.calls[0][0]).not.toHaveProperty('fixedArguments');
        expect(engine.execute.mock.calls[0][2]).toEqual({ repo: 'web', owner: 'acme-from-a-variable' });
      }
    });

    it('hands the engine the fixed arguments with the connector variables filled in', async () => {
      const { executor, engine } = build(
        withConfig('MCP', {
          mcpFixedArguments: { meta: { agent: { profile: 'https://agent.example.test/{{GITHUB_ORG}}.json' } } },
        }),
      );
      await executor.executeTool('github_list_issues', { repo: 'web' });
      expect(engine.execute.mock.calls[0][0].fixedArguments).toEqual({
        meta: { agent: { profile: 'https://agent.example.test/acme.json' } },
      });
      // The caller's arguments are still passed as they were; the engine merges.
      expect(engine.execute.mock.calls[0][2]).toEqual({ repo: 'web', owner: 'acme-from-a-variable' });
    });

    it('refuses the call, with nothing sent, when a fixed argument names a variable nobody set', async () => {
      const { executor, engine } = build(withConfig('MCP', { mcpFixedArguments: { meta: { profile: '{{AGENT_PROFILE_URL}}' } } }));
      const out = await executor.executeTool('github_list_issues', { repo: 'web' });
      expect(engine.execute).not.toHaveBeenCalled();
      expect(JSON.stringify(out)).toContain('AGENT_PROFILE_URL');
    });

    it('ignores the setting on a connector that is not an MCP bridge', async () => {
      const { executor, engine } = build(withConfig('REST', { mcpFixedArguments: { meta: { profile: '{{AGENT_PROFILE_URL}}' } } }));
      await executor.executeTool('github_list_issues', { repo: 'web' });
      expect(engine.execute).toHaveBeenCalledTimes(1);
      expect(engine.execute.mock.calls[0][0]).not.toHaveProperty('fixedArguments');
    });
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
    expect(mcpClientEngine.execute.mock.calls[0][0]).not.toHaveProperty('fixedArguments');
  });

  const connector = (config: unknown) =>
    ({
      id: 'c1',
      name: 'Acme Shop',
      type: 'MCP',
      baseUrl: 'https://shop.example.test/api/ucp/mcp',
      authType: 'NONE',
      authConfig: null,
      headers: null,
      specUrl: null,
      envVars: { AGENT_HOST: 'agent.example.test' },
      config,
    }) as any;

  it("sends the connector's fixed arguments with the variables filled in, as a real call does", async () => {
    mcpClientEngine.execute.mockClear();
    await service.executeConnectorCall(
      connector({ mcpFixedArguments: { meta: { 'ucp-agent': { profile: 'https://{{AGENT_HOST}}/ucp-agent.json' } } } }),
      { method: 'search_catalog', path: '/mcp' },
      { catalog: { query: 'tent' } },
      'acme_shop_search_catalog',
      { type: 'object', properties: { catalog: { type: 'object' } } },
    );
    const [config, , args] = mcpClientEngine.execute.mock.calls[0];
    expect(config.fixedArguments).toEqual({ meta: { 'ucp-agent': { profile: 'https://agent.example.test/ucp-agent.json' } } });
    expect(config.authConfig).toBeUndefined();
    expect(args).toEqual({ catalog: { query: 'tent' } });
  });

  it('refuses a fixed argument whose variable has no value before anything is sent', async () => {
    mcpClientEngine.execute.mockClear();
    await expect(
      service.executeConnectorCall(
        connector({ mcpFixedArguments: { meta: { profile: '{{AGENT_PROFILE_URL}}' } } }),
        { method: 'search_catalog', path: '/mcp' },
        {},
        'acme_shop_search_catalog',
        { type: 'object', properties: {} },
      ),
    ).rejects.toThrow(/AGENT_PROFILE_URL/);
    expect(mcpClientEngine.execute).not.toHaveBeenCalled();
  });
});
