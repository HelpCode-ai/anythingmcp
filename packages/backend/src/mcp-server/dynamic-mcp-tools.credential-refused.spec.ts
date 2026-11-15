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

  function build(
    tool: RegisteredTool,
    rest: jest.Mock,
    current: unknown = null,
    opts: { redis?: Record<string, jest.Mock>; workedBefore?: boolean } = {},
  ) {
    const audit = { logInvocation: jest.fn().mockResolvedValue(undefined) };
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      // Not connected, as in a self-hosted install without Redis: counts stay in the process.
      incr: jest.fn().mockResolvedValue(0),
      expire: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      ttl: jest.fn(),
      ...opts.redis,
    };
    const prisma = {
      toolInvocation: { findFirst: jest.fn().mockResolvedValue(opts.workedBefore ? { id: 'inv-1' } : null) },
    };
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
      prisma as any,
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
    return { executor, authStatus, redis, prisma };
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

    // Recorded: the next refusals write nothing more.
    authStatus.get.mockResolvedValue({ status: 'needs_reauth', code: 'credential_refused', message: issue.message });
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

  it('ignores write tools, and a 401 on a connector without a declared key that no hint knows', async () => {
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
  describe('keys that are not in an auth header', () => {
    const telegramTool = (): RegisteredTool =>
      ({
        id: 'tool-tg',
        connectorId: 'conn-tg',
        organizationId: 'org-1',
        name: 'telegram_bot_get_me',
        description: 'Who the bot is',
        parameters: { type: 'object', properties: {} },
        connectorType: 'REST',
        connectorConfig: {
          baseUrl: 'https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}',
          authType: 'NONE',
          envVars: { TELEGRAM_BOT_TOKEN: '123456789:AAtesttokenvalue' },
          config: { adapterSlug: 'telegram-bot' },
        },
        endpointMapping: { method: 'GET', path: '/getMe' },
      }) as unknown as RegisteredTool;

    const telegramRefusal = (status: number, description: string) =>
      new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', { url: 'https://api.telegram.org/botX/getMe' } as any, undefined, {
        status,
        statusText: description,
        headers: {},
        config: { url: 'https://api.telegram.org/botX/getMe' } as any,
        data: { ok: false, error_code: status, description },
      });

    it('marks a Telegram bot whose token is refused, with Telegram\'s own advice', async () => {
      for (const refusal of [telegramRefusal(401, 'Unauthorized'), telegramRefusal(404, 'Not Found')]) {
        const rest = jest.fn().mockRejectedValue(refusal);
        const { executor, authStatus } = build(telegramTool(), rest);
        for (let i = 0; i < REFUSALS_BEFORE_MARK; i++) await executor.executeTool('telegram_bot_get_me', {});
        await flush();
        expect(authStatus.mark).toHaveBeenCalledTimes(1);
        const [id, issue] = authStatus.mark.mock.calls[0];
        expect(id).toBe('conn-tg');
        expect(issue.code).toBe('credential_refused');
        expect(issue.message).toMatch(/@BotFather/);
        expect(issue.message).not.toMatch(/AAtesttokenvalue/);
        // Words for the owner, not instructions for the assistant.
        expect(issue.message).not.toMatch(/Tell the user/);
      }
    });

    it('marks an Odoo JSON-RPC connector whose key is denied inside a 200', async () => {
      const odooTool = {
        id: 'tool-odoo',
        connectorId: 'conn-odoo',
        organizationId: 'org-1',
        name: 'odoo_search_read',
        description: 'Search and read',
        parameters: { type: 'object', properties: { model: { type: 'string' } } },
        connectorType: 'REST',
        connectorConfig: {
          baseUrl: 'https://acme.odoo.example',
          authType: 'NONE',
          envVars: { ODOO_DB: 'acme', ODOO_UID: '2', ODOO_API_KEY: 'odoo-key-123456' },
          config: { adapterSlug: 'odoo-jsonrpc' },
        },
        endpointMapping: { method: 'POST', path: '/jsonrpc' },
        annotations: { readOnlyHint: true },
      } as unknown as RegisteredTool;
      const rest = jest.fn().mockRejectedValue(new Error('JSON-RPC error 200: Odoo Server Error: Access Denied'));
      const { executor, authStatus } = build(odooTool, rest);
      for (let i = 0; i < REFUSALS_BEFORE_MARK; i++) await executor.executeTool('odoo_search_read', { model: 'res.partner' });
      await flush();
      expect(authStatus.mark).toHaveBeenCalledTimes(1);
      const issue = authStatus.mark.mock.calls[0][1];
      expect(issue.message).toMatch(/^The API refused this connector's saved credentials on 3 calls in a row\. Odoo answered Access Denied/);
      expect(issue.message).not.toMatch(/odoo-key-123456/);
    });

    it('does not mark a Telegram bot for a chat it cannot reach', async () => {
      const rest = jest.fn().mockRejectedValue(telegramRefusal(400, 'Bad Request: chat not found'));
      const { executor, authStatus } = build(telegramTool(), rest);
      for (let i = 0; i < REFUSALS_BEFORE_MARK + 2; i++) await executor.executeTool('telegram_bot_get_me', {});
      await flush();
      expect(authStatus.mark).not.toHaveBeenCalled();
    });

    it('clears the Telegram status and the shared count when the token works again', async () => {
      const rest = jest.fn().mockRejectedValue(telegramRefusal(401, 'Unauthorized'));
      const { executor, authStatus, redis } = build(telegramTool(), rest);
      for (let i = 0; i < REFUSALS_BEFORE_MARK; i++) await executor.executeTool('telegram_bot_get_me', {});
      rest.mockResolvedValue({ ok: true, result: { id: 1 } });
      await executor.executeTool('telegram_bot_get_me', {});
      await flush();
      expect(authStatus.clear).toHaveBeenCalledWith('conn-tg', { onlyCodes: ['credential_refused'] });
      expect(redis.del).toHaveBeenCalledWith('cred_refused:conn-tg');
    });
  });

  it('marks again at the next refusal after an edit that did not fix the key', async () => {
    const rest = jest.fn().mockRejectedValue(cannotView());
    const { executor, authStatus } = build(wooTool(), rest);
    for (let i = 0; i < REFUSALS_BEFORE_MARK; i++) await executor.executeTool('woocommerce_list_orders', {});
    await flush();
    expect(authStatus.mark).toHaveBeenCalledTimes(1);
    // Saving the connector cleared the status (connectors.service); the key is still refused.
    authStatus.get.mockResolvedValue(null);
    await executor.executeTool('woocommerce_list_orders', {});
    await flush();
    expect(authStatus.mark).toHaveBeenCalledTimes(2);
    expect(authStatus.mark.mock.calls[1][1].message).toMatch(new RegExp(`on ${REFUSALS_BEFORE_MARK + 1} calls in a row`));
  });

  describe('a count that survives restarts', () => {
    it('marks at the third refusal counted in Redis, although this process saw one', async () => {
      const rest = jest.fn().mockRejectedValue(cannotView());
      const redis = { incr: jest.fn().mockResolvedValue(REFUSALS_BEFORE_MARK) };
      const { executor, authStatus } = build(wooTool(), rest, null, { redis });
      await executor.executeTool('woocommerce_list_orders', {});
      await flush();
      expect(redis.incr).toHaveBeenCalledWith('cred_refused:conn-woo');
      expect(authStatus.mark).toHaveBeenCalledTimes(1);
      expect(authStatus.mark.mock.calls[0][1].message).toMatch(
        new RegExp(`on ${REFUSALS_BEFORE_MARK} calls in a row \\(HTTP 401\\)`),
      );
    });

    it('gives the shared count an expiry when it starts', async () => {
      const rest = jest.fn().mockRejectedValue(cannotView());
      const redis = { incr: jest.fn().mockResolvedValue(1), expire: jest.fn().mockResolvedValue(undefined) };
      const { executor, authStatus } = build(wooTool(), rest, null, { redis });
      await executor.executeTool('woocommerce_list_orders', {});
      await flush();
      expect(redis.expire).toHaveBeenCalledWith('cred_refused:conn-woo', 14 * 24 * 60 * 60);
      expect(authStatus.mark).not.toHaveBeenCalled();
    });

    it('falls back to the count of this process when Redis fails', async () => {
      const rest = jest.fn().mockRejectedValue(cannotView());
      const redis = { incr: jest.fn().mockRejectedValue(new Error('redis down')) };
      const { executor, authStatus } = build(wooTool(), rest, null, { redis });
      for (let i = 0; i < REFUSALS_BEFORE_MARK; i++) await executor.executeTool('woocommerce_list_orders', {});
      await flush();
      expect(authStatus.mark).toHaveBeenCalledTimes(1);
    });
  });

  describe('the email to the owner', () => {
    const markOpts = async (opts: Parameters<typeof build>[3]) => {
      const rest = jest.fn().mockRejectedValue(cannotView());
      const built = build(wooTool(), rest, null, opts);
      for (let i = 0; i < REFUSALS_BEFORE_MARK; i++) await built.executor.executeTool('woocommerce_list_orders', {});
      await flush();
      expect(built.authStatus.mark).toHaveBeenCalledTimes(1);
      return { ...built, opts: built.authStatus.mark.mock.calls[0][2] };
    };

    it('goes out when the connector worked before', async () => {
      const { opts, redis, prisma } = await markOpts({ workedBefore: true });
      expect(opts).toEqual({ notify: true });
      expect(prisma.toolInvocation.findFirst).toHaveBeenCalledWith({
        where: { connectorId: 'conn-woo', status: 'SUCCESS' },
        select: { id: true },
      });
      // Remembered for a week, for a key that works on and off.
      expect(redis.set).toHaveBeenCalledWith('cred_refused_mail:conn-woo', '1', 7 * 24 * 60 * 60);
    });

    it('does not go out for a connector that never worked: it is still being set up', async () => {
      const { opts, redis } = await markOpts({ workedBefore: false });
      expect(opts).toEqual({ notify: false });
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('does not go out twice in a week', async () => {
      const { opts } = await markOpts({ workedBefore: true, redis: { get: jest.fn().mockResolvedValue('1') } });
      expect(opts).toEqual({ notify: false });
    });
  });

  it('does not count a 401 that asks for a scope', async () => {
    const needsScope = new AxiosError('Request failed with status code 401', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config: {} as any,
      data: { error: 'insufficient_scope', error_description: 'The request requires higher privileges than provided by the webhook token' },
    });
    const rest = jest.fn().mockRejectedValue(needsScope);
    const { executor, authStatus } = build(wooTool({}, { config: {} }), rest);
    for (let i = 0; i < REFUSALS_BEFORE_MARK + 1; i++) await executor.executeTool('woocommerce_list_orders', {});
    await flush();
    expect(authStatus.mark).not.toHaveBeenCalled();
  });
});
