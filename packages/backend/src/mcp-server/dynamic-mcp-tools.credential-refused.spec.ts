import { AxiosError } from 'axios';
import { Logger } from '@nestjs/common';
import { DynamicMcpTools } from './dynamic-mcp-tools';
import type { RegisteredTool } from './tool-registry';
import { REFUSALS_BEFORE_MARK } from '../connectors/engines/credential-refusal-tracker';

/**
 * A WooCommerce key that stopped working: repeated 401s on read tools become
 * the connector's credential status (shown on the dashboard and by
 * setup_get_status), without an email, and a call that works clears it.
 */
describe('DynamicMcpTools: repeated 401s on a stored key', () => {
  function wooTool(overrides: Partial<RegisteredTool> = {}, connector: Record<string, unknown> = {}): RegisteredTool {
    return {
      id: 'tool-1',
      connectorId: 'conn-woo',
      organizationId: 'org-1',
      name: 'woocommerce_list_orders',
      description: 'List orders',
      parameters: { type: 'object', properties: {} },
      connectorType: 'REST',
      connectorConfig: {
        baseUrl: 'https://shop.example/wp-json/wc/v3',
        authType: 'QUERY_AUTH',
        authConfig: JSON.stringify({ consumer_key: 'ck_x', consumer_secret: 'cs_y' }),
        envVars: {},
        config: { adapterSlug: 'woocommerce' },
        ...connector,
      },
      endpointMapping: { method: 'GET', path: '/orders' },
      ...overrides,
    } as unknown as RegisteredTool;
  }

  const cannotView = () =>
    new AxiosError('Request failed with status code 401', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config: {} as any,
      data: { code: 'woocommerce_rest_cannot_view', message: 'Sorry, you cannot list resources.', data: { status: 401 } },
    });

  function build(tool: RegisteredTool, rest: jest.Mock, current: unknown = null) {
    const audit = { logInvocation: jest.fn().mockResolvedValue(undefined) };
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), incr: jest.fn(), expire: jest.fn(), ttl: jest.fn() };
    const unexpected = { execute: jest.fn().mockRejectedValue(new Error('unexpected engine')) };
    const authStatus = {
      get: jest.fn().mockResolvedValue(current),
      mark: jest.fn().mockResolvedValue(undefined),
      clear: jest.fn().mockResolvedValue(undefined),
    };
    const executor = new DynamicMcpTools(
      { getTool: () => tool, getToolForOrg: () => tool } as any,
      audit as any,
      redis as any,
      { checkLicenseActive: jest.fn().mockResolvedValue(undefined) } as any,
      { isCloud: () => false } as any,
      {} as any,
      { execute: rest } as any,
      unexpected as any,
      unexpected as any,
      unexpected as any,
      unexpected as any,
      { scheduleObservationalIngest: jest.fn() } as any,
      { recentEvents: jest.fn().mockResolvedValue([]) } as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      authStatus as any,
    );
    return { executor, authStatus };
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('marks the connector after the threshold, once, with WooCommerce\'s own advice and no email', async () => {
    const rest = jest.fn().mockRejectedValue(cannotView());
    const { executor, authStatus } = build(wooTool(), rest);
    for (let i = 0; i < REFUSALS_BEFORE_MARK - 1; i++) await executor.executeTool('woocommerce_list_orders', {});
    await flush();
    expect(authStatus.mark).not.toHaveBeenCalled();

    const res: any = await executor.executeTool('woocommerce_list_orders', {});
    await flush();
    expect(res.isError).toBe(true);
    expect(authStatus.mark).toHaveBeenCalledTimes(1);
    const [id, issue, opts] = authStatus.mark.mock.calls[0];
    expect(id).toBe('conn-woo');
    expect(issue).toMatchObject({ status: 'needs_reauth', code: 'credential_refused' });
    expect(issue.message).toMatch(new RegExp(`on ${REFUSALS_BEFORE_MARK} calls in a row \\(HTTP 401\\)`));
    expect(issue.message).toMatch(/administrator or shop manager/);
    expect(issue.message).not.toMatch(/ck_x|cs_y/);
    expect(opts).toEqual({ notify: false });

    await executor.executeTool('woocommerce_list_orders', {});
    await flush();
    expect(authStatus.mark).toHaveBeenCalledTimes(1);
  });

  it('clears the status when a call works again', async () => {
    const rest = jest.fn().mockRejectedValue(cannotView());
    const { executor, authStatus } = build(wooTool(), rest);
    for (let i = 0; i < REFUSALS_BEFORE_MARK; i++) await executor.executeTool('woocommerce_list_orders', {});
    rest.mockResolvedValue([{ id: 1 }]);
    await executor.executeTool('woocommerce_list_orders', {});
    await flush();
    expect(authStatus.clear).toHaveBeenCalledWith('conn-woo', { onlyCodes: ['credential_refused'] });
    // Once: later successes cost no query.
    await executor.executeTool('woocommerce_list_orders', {});
    expect(authStatus.clear).toHaveBeenCalledTimes(1);
  });

  it('leaves a status another service recorded alone', async () => {
    const rest = jest.fn().mockRejectedValue(cannotView());
    const { executor, authStatus } = build(wooTool(), rest, { status: 'needs_reauth', code: 'meta_logged_out', message: 'x' });
    for (let i = 0; i < REFUSALS_BEFORE_MARK; i++) await executor.executeTool('woocommerce_list_orders', {});
    await flush();
    expect(authStatus.get).toHaveBeenCalled();
    expect(authStatus.mark).not.toHaveBeenCalled();
  });

  it('ignores write tools and connectors without a stored key (here: no auth)', async () => {
    for (const tool of [
      wooTool({ name: 'woocommerce_update_order', endpointMapping: { method: 'PUT', path: '/orders/1' } } as any),
      wooTool({}, { authType: 'NONE', authConfig: undefined }),
    ]) {
      const rest = jest.fn().mockRejectedValue(cannotView());
      const { executor, authStatus } = build(tool, rest);
      for (let i = 0; i < REFUSALS_BEFORE_MARK; i++) await executor.executeTool(tool.name, {});
      await flush();
      expect(rest).toHaveBeenCalledTimes(REFUSALS_BEFORE_MARK);
      expect(authStatus.mark).not.toHaveBeenCalled();
    }
  });
});
