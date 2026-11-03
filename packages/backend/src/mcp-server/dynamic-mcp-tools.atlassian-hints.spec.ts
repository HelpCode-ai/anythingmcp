import { DynamicMcpTools } from './dynamic-mcp-tools';
import type { RegisteredTool } from './tool-registry';
import { Logger } from '@nestjs/common';

/**
 * Calls through the catalog bridge to Atlassian's Rovo MCP server: the advice
 * a refusal comes back with.
 */
describe('DynamicMcpTools: refusals of the Atlassian MCP bridge', () => {
  const TOKEN = 'ATATT' + 'Zq9'.repeat(40);

  function atlassianTool(parameters: Record<string, unknown>): RegisteredTool {
    return {
      id: 'tool-1',
      connectorId: 'conn-1',
      organizationId: 'org-1',
      name: 'atlassian_getJiraIssue',
      description: 'Get a Jira work item',
      parameters,
      connectorType: 'MCP',
      connectorConfig: {
        baseUrl: 'https://mcp.atlassian.com/v2/mcp',
        authType: 'BASIC_AUTH',
        envVars: {
          ATLASSIAN_EMAIL: 'jane.doe@acme.test',
          ATLASSIAN_API_TOKEN: TOKEN,
          ATLASSIAN_SITE: 'acme.atlassian.net',
        },
        config: { adapterSlug: 'atlassian', mcpToolPrefix: 'atlassian_' },
      },
      endpointMapping: { method: 'getJiraIssue', path: '/mcp' },
    } as unknown as RegisteredTool;
  }

  function build(tool: RegisteredTool, mcp: jest.Mock) {
    const audit = { logInvocation: jest.fn().mockResolvedValue(undefined) };
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), incr: jest.fn(), expire: jest.fn(), ttl: jest.fn() };
    const unexpected = { execute: jest.fn().mockRejectedValue(new Error('unexpected engine')) };
    const executor = new DynamicMcpTools(
      { getTool: () => tool, getToolForOrg: () => tool } as any,
      audit as any,
      redis as any,
      { checkLicenseActive: jest.fn().mockResolvedValue(undefined) } as any,
      { isCloud: () => false } as any,
      {} as any,
      unexpected as any,
      unexpected as any,
      unexpected as any,
      { execute: mcp } as any,
      unexpected as any,
      { scheduleObservationalIngest: jest.fn() } as any,
      { recentEvents: jest.fn().mockResolvedValue([]) } as any,
      unexpected as any,
    );
    return { executor, audit };
  }

  const frontend = process.env.FRONTEND_URL;
  beforeAll(() => {
    process.env.FRONTEND_URL = 'https://app.example.test';
  });
  afterAll(() => {
    if (frontend === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = frontend;
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('adds the advice to a tool result refused for a token without scopes', async () => {
    const refusal =
      'Unable to resolve user scopes from the user-context token for "getJiraIssue". The session token is ' +
      'missing the scope claim required to authorize this operation.';
    const mcp = jest.fn().mockResolvedValue({ isError: true, content: [{ type: 'text', text: refusal }] });
    const { executor } = build(atlassianTool({ type: 'object', properties: {} }), mcp);
    const res: any = await executor.executeTool('atlassian_getJiraIssue', {});
    expect(res.isError).toBe(true);
    const text: string = res.content[0].text;
    expect(text.startsWith(refusal)).toBe(true);
    expect(text).toContain('This Atlassian API token has no scopes');
    expect(text).toContain('read:jira:agent-interface');
    expect(text).toContain('/connectors/conn-1');
    // Not the OAuth advice for a missing scope: there is nothing to re-authorize.
    expect(text).not.toContain('Authorize with Provider');
  });

  it('explains a 401 invalid_token from the MCP SDK and keeps its status', async () => {
    const err: any = new Error('Error POSTing to endpoint: {"error":"invalid_token"}');
    err.code = 'CLIENT_HTTP_NOT_IMPLEMENTED';
    err.data = { status: 401 };
    const { executor } = build(atlassianTool({ type: 'object', properties: {} }), jest.fn().mockRejectedValue(err));
    const res: any = await executor.executeTool('atlassian_getJiraIssue', {});
    const detail = JSON.parse(res.content[0].text);
    expect(detail.status).toBe(401);
    expect(detail.hint).toContain('Atlassian refused the email and token together');
    expect(detail.hint).toContain('/connectors/conn-1');
  });

  it('leaves an unrelated refusal of another MCP server as the server wrote it', async () => {
    const tool = atlassianTool({ type: 'object', properties: {} });
    (tool.connectorConfig as any).config = { adapterSlug: 'linear' };
    const mcp = jest.fn().mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'Issue not found' }] });
    const { executor } = build(tool, mcp);
    const res: any = await executor.executeTool('atlassian_getJiraIssue', {});
    expect(res.content).toEqual([{ type: 'text', text: 'Issue not found' }]);
  });
});
