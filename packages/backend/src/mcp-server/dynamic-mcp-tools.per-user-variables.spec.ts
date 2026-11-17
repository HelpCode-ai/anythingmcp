import { DynamicMcpTools } from './dynamic-mcp-tools';
import type { RegisteredTool } from './tool-registry';
import { UserCredentialError } from '../connectors/user-credentials.service';
import { userCredentialKey } from '../common/credential-key.util';

/**
 * Tool calls on a connector whose users enter their own values of some
 * variables (credentialScope USER with config.userVariables): the caller's
 * values resolve every `{{VAR}}`, the connector's own value of such a
 * variable is never sent, and a shared connector resolves as it always did.
 */

function makeTool(over: Partial<RegisteredTool['connectorConfig']> = {}): RegisteredTool {
  return {
    id: 'tool-1',
    connectorId: 'conn-1',
    organizationId: 'org-1',
    connectorName: 'Acme',
    name: 'acme_list_orders',
    description: 'List orders',
    parameters: { type: 'object', properties: {} },
    connectorType: 'REST',
    connectorConfig: {
      baseUrl: 'https://{{ACME_TENANT}}.example.test/api',
      authType: 'API_KEY',
      authConfig: JSON.stringify({ headerName: 'X-Api-Key', apiKey: '{{ACME_API_KEY}}' }),
      headers: { 'X-Acme-User': '{{ACME_USER}}' },
      // What a switch leaves behind: the per-user variables emptied.
      envVars: { ACME_TENANT: 'shop', ACME_API_KEY: '', ACME_USER: '' },
      config: { userVariables: ['ACME_API_KEY', 'ACME_USER'] },
      credentialScope: 'USER',
      ...over,
    },
    endpointMapping: { method: 'GET', path: '/orders' },
  };
}

function build(tool: RegisteredTool, valuesByUser: Record<string, Record<string, string>>) {
  const restEngine = {
    executeWithMeta: jest.fn().mockResolvedValue({ body: { orders: [] }, meta: {} }),
    execute: jest.fn().mockResolvedValue({ orders: [] }),
  };
  const userCredentials = {
    resolveForCall: jest.fn(),
    variablesForCall: jest.fn(async (input: any) => {
      if (!input.userId) throw new UserCredentialError('no user. No request was sent to the API.', 'no_user');
      const userVars = valuesByUser[input.userId];
      if (!userVars) {
        throw new UserCredentialError(
          'You have not connected your own account. No request was sent to the API. Open https://amcp.example.test/auth/connect/conn-1',
          'not_connected',
        );
      }
      return { userVars, credentialKey: userCredentialKey(input.connectorId, input.userId) };
    }),
  };
  const logInvocation = jest.fn().mockResolvedValue(undefined);
  const executor = new DynamicMcpTools(
    { getTool: () => tool, getToolForOrg: () => tool, getToolsForConnectors: () => [tool] } as any,
    { logInvocation } as any,
    { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) } as any,
    { checkLicenseActive: jest.fn().mockResolvedValue(undefined) } as any,
    { isCloud: () => false } as any,
    {} as any,
    restEngine as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { scheduleObservationalIngest: jest.fn() } as any,
    { recentEvents: jest.fn().mockResolvedValue([]) } as any,
    undefined,
    userCredentials as any,
  );
  const sent = () => (restEngine.executeWithMeta.mock.calls[0] ?? restEngine.execute.mock.calls[0])?.[0];
  const calls = () => restEngine.executeWithMeta.mock.calls.length + restEngine.execute.mock.calls.length;
  return { executor, restEngine, userCredentials, sent, calls, logInvocation };
}

const ctx = (userId?: string) => ({ userId, organizationId: 'org-1' });
const U1 = { ACME_API_KEY: 'u1-key-0123456789', ACME_USER: 'u1@example.test' };
const U2 = { ACME_API_KEY: 'u2-key-9876543210', ACME_USER: 'u2@example.test' };

describe('DynamicMcpTools — per-user variables', () => {
  it("resolves every field from the caller's own values, under the caller's own key", async () => {
    const { executor, sent } = build(makeTool(), { u1: U1, u2: U2 });
    const res = await executor.executeTool('acme_list_orders', {}, ctx('u2'));
    expect(res.isError).toBeFalsy();
    const config = sent();
    expect(config.baseUrl).toBe('https://shop.example.test/api');
    expect(config.authConfig).toEqual({ headerName: 'X-Api-Key', apiKey: 'u2-key-9876543210' });
    expect(config.headers['X-Acme-User']).toBe('u2@example.test');
    expect(config.connectorId).toBe('conn-1:user:u2');
    expect(JSON.stringify(config)).not.toContain('u1-key');
  });

  it("never sends the connector's own value of a per-user variable", async () => {
    // Values left on the connector (typed in again after the switch, say).
    const tool = makeTool({ envVars: { ACME_TENANT: 'shop', ACME_API_KEY: 'admin-key-000000', ACME_USER: 'admin@example.test' } });
    const connected = build(tool, { u1: U1 });
    await connected.executor.executeTool('acme_list_orders', {}, ctx('u1'));
    // (logSecrets, the list of values to mask in log lines, is not part of the request.)
    const { baseUrl, authConfig, headers } = connected.sent();
    expect(JSON.stringify({ baseUrl, authConfig, headers })).not.toContain('admin');

    const notConnected = build(tool, { u1: U1 });
    const res = await notConnected.executor.executeTool('acme_list_orders', {}, ctx('u2'));
    expect(res.isError).toBe(true);
    expect(notConnected.calls()).toBe(0);
  });

  it('answers a user who has not connected with the page to open, and sends nothing', async () => {
    const { executor, calls } = build(makeTool(), { u1: U1 });
    const res = await executor.executeTool('acme_list_orders', {}, ctx('u2'));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('https://amcp.example.test/auth/connect/conn-1');
    expect(res.content[0].text).toContain('No request was sent');
    expect(calls()).toBe(0);
  });

  it('sends nothing for a call without a user', async () => {
    const { executor, calls } = build(makeTool(), { u1: U1 });
    const res = await executor.executeTool('acme_list_orders', {}, ctx(undefined));
    expect(res.isError).toBe(true);
    expect(calls()).toBe(0);
  });

  it('sends nothing when a field no longer refers to the per-user variable', async () => {
    // The key written straight into the auth config after the switch.
    const tool = makeTool({ authConfig: JSON.stringify({ headerName: 'X-Api-Key', apiKey: 'one-key-for-everyone' }) });
    const { executor, calls, userCredentials } = build(tool, { u1: U1 });
    const res = await executor.executeTool('acme_list_orders', {}, ctx('u1'));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('ACME_API_KEY');
    expect(res.content[0].text).toContain('No request was sent');
    expect(calls()).toBe(0);
    expect(userCredentials.variablesForCall).not.toHaveBeenCalled();
  });

  it('sends nothing when a per-user variable has moved into the address', async () => {
    const tool = makeTool({ baseUrl: 'https://{{ACME_USER}}.example.test/api' });
    const { executor, calls, userCredentials } = build(tool, { u1: U1 });
    const res = await executor.executeTool('acme_list_orders', {}, ctx('u1'));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("part of the connector's address");
    expect(res.content[0].text).toContain('No request was sent');
    expect(calls()).toBe(0);
    expect(userCredentials.variablesForCall).not.toHaveBeenCalled();
  });

  it("keeps the user's own values out of an error that quotes them", async () => {
    const { executor, restEngine } = build(makeTool(), { u1: U1 });
    restEngine.executeWithMeta.mockRejectedValue(new Error('upstream refused key u1-key-0123456789'));
    restEngine.execute.mockRejectedValue(new Error('upstream refused key u1-key-0123456789'));
    const res = await executor.executeTool('acme_list_orders', {}, ctx('u1'));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).not.toContain('u1-key-0123456789');
  });

  it('does not ask for own values on a shared connector, whatever its config says', async () => {
    const tool = makeTool({
      credentialScope: 'SHARED',
      envVars: { ACME_TENANT: 'shop', ACME_API_KEY: 'shared-key-0123456', ACME_USER: 'shared@example.test' },
    });
    const { executor, sent, userCredentials } = build(tool, {});
    const res = await executor.executeTool('acme_list_orders', {}, ctx('u1'));
    expect(res.isError).toBeFalsy();
    expect(userCredentials.variablesForCall).not.toHaveBeenCalled();
    expect(sent().authConfig.apiKey).toBe('shared-key-0123456');
    expect(sent().connectorId).toBe('conn-1');
  });
});
