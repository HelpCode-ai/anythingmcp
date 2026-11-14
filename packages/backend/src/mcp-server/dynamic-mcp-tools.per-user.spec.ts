import { DynamicMcpTools } from './dynamic-mcp-tools';
import type { RegisteredTool } from './tool-registry';
import { UserCredentialError } from '../connectors/user-credentials.service';
import { mergeUserCredential } from '../connectors/user-credential.util';
import { userCredentialKey } from '../common/credential-key.util';

/**
 * Tool calls on a connector with per-user credentials (credentialScope USER):
 * each call carries the caller's own sign-in under a key of its own, the
 * response cache is per user, and nothing falls back to the connector's
 * token.
 */

function makeTool(responseMapping?: Record<string, unknown>): RegisteredTool {
  return {
    id: 'tool-1',
    connectorId: 'conn-1',
    organizationId: 'org-1',
    connectorName: 'MFR',
    name: 'mfr_search_orders',
    description: 'Search orders',
    parameters: { type: 'object', properties: {} },
    connectorType: 'MCP',
    connectorConfig: {
      baseUrl: 'https://mcp.example.com',
      authType: 'OAUTH2',
      // A token of the admin who authorized before the switch: never sent.
      authConfig: JSON.stringify({ clientId: 'client-1', tokenUrl: 'https://mcp.example.com/token', accessToken: 'admin-at' }),
      credentialScope: 'USER',
    },
    endpointMapping: { method: 'search_orders', path: '/mcp' },
    responseMapping,
  };
}

function build(tool: RegisteredTool, tokensByUser: Record<string, Record<string, unknown>>) {
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const mcpClientEngine = { execute: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }) };
  const userCredentials = {
    resolveForCall: jest.fn(async (input: any) => {
      if (!input.userId) throw new UserCredentialError('no user. No request was sent to the API.', 'no_user');
      const tokens = tokensByUser[input.userId];
      if (!tokens) throw new UserCredentialError('not connected. No request was sent to the API.', 'not_connected');
      return {
        authConfig: mergeUserCredential(input.connectorAuthConfig, tokens),
        credentialKey: userCredentialKey(input.connectorId, input.userId),
      };
    }),
  };
  const executor = new DynamicMcpTools(
    { getTool: () => tool, getToolForOrg: () => tool } as any,
    { logInvocation: jest.fn().mockResolvedValue(undefined) } as any,
    redis as any,
    { checkLicenseActive: jest.fn().mockResolvedValue(undefined) } as any,
    { isCloud: () => false } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    mcpClientEngine as any,
    {} as any,
    { scheduleObservationalIngest: jest.fn() } as any,
    { recentEvents: jest.fn().mockResolvedValue([]) } as any,
    undefined,
    userCredentials as any,
  );
  return { executor, redis, mcpClientEngine, userCredentials };
}

const ctx = (userId?: string) => ({ userId, organizationId: 'org-1' });

describe('DynamicMcpTools — per-user credentials', () => {
  it("sends the caller's own token under the caller's own key", async () => {
    const { executor, mcpClientEngine } = build(makeTool(), { u1: { accessToken: 'u1-at' } });
    const res = await executor.executeTool('mfr_search_orders', {}, ctx('u1'));
    expect(res.isError).toBeFalsy();
    const config = mcpClientEngine.execute.mock.calls[0][0];
    expect(config.connectorId).toBe('conn-1:user:u1');
    expect(config.authConfig.accessToken).toBe('u1-at');
    expect(JSON.stringify(config.authConfig)).not.toContain('admin-at');
  });

  it('sends nothing for a user who has not connected', async () => {
    const { executor, mcpClientEngine } = build(makeTool(), { u1: { accessToken: 'u1-at' } });
    const res = await executor.executeTool('mfr_search_orders', {}, ctx('u2'));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not connected');
    expect(mcpClientEngine.execute).not.toHaveBeenCalled();
  });

  it('sends nothing for a call without a user', async () => {
    const { executor, mcpClientEngine } = build(makeTool(), { u1: { accessToken: 'u1-at' } });
    const res = await executor.executeTool('mfr_search_orders', {}, ctx(undefined));
    expect(res.isError).toBe(true);
    expect(mcpClientEngine.execute).not.toHaveBeenCalled();
  });

  it('keeps the response cache apart per user', async () => {
    const { executor, redis } = build(makeTool({ cacheTtl: 60 }), {
      u1: { accessToken: 'u1-at' },
      u2: { accessToken: 'u2-at' },
    });
    await executor.executeTool('mfr_search_orders', { q: 'x' }, ctx('u1'));
    await executor.executeTool('mfr_search_orders', { q: 'x' }, ctx('u2'));
    const readKeys = redis.get.mock.calls.map((c) => c[0]);
    const writtenKeys = redis.set.mock.calls.map((c) => c[0]);
    expect(readKeys[0]).toContain(':user:u1:');
    expect(readKeys[1]).toContain(':user:u2:');
    expect(writtenKeys[0]).not.toBe(writtenKeys[1]);
  });

  it('does not read the cache for a call without a user', async () => {
    const { executor, redis } = build(makeTool({ cacheTtl: 60 }), {});
    await executor.executeTool('mfr_search_orders', { q: 'x' }, ctx(undefined));
    expect(redis.get).not.toHaveBeenCalled();
  });
});
