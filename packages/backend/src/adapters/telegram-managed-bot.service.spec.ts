import { Logger } from '@nestjs/common';
import { TelegramManagedBotService } from './telegram-managed-bot.service';
import {
  MANAGED_BOT_CONFIG_KEY,
  MANAGED_BOT_TTL_MS,
  WELCOME_TEXT,
  codeFromUsername,
  hashSetupCode,
  readManagedBotState,
} from './telegram-managed-bot';

const MANAGER_TOKEN = '7000000001:AAF4kq0ManagerBotTokenForTestsOnly00';
const SECRET = 'webhook-secret-for-tests-0123456789';
const BOT_ID = 8123456789;
const BOT_TOKEN = `${BOT_ID}:AAGnewBotTokenForTestsOnly0123456789ab`;
const CREATOR_ID = 555001;
const PLACEHOLDER = 'https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}';
const T0 = Date.parse('2026-11-15T09:00:00.000Z');

type Row = {
  id: string;
  organizationId: string;
  type: string;
  authType: string;
  authConfig: string | null;
  headers: unknown;
  baseUrl: string;
  envVars: Record<string, string> | null;
  config: Record<string, any> | null;
  createdAt: Date;
};

type Call = { token: string; method: string; body: Record<string, any> };

/**
 * The service with Telegram and the database replaced: every Bot API call
 * goes to `telegram`, which answers from `answers` (by method), and nothing
 * reaches the network.
 */
function setup(env: Record<string, string | undefined> = {}) {
  const rows: Row[] = [];
  const addConnector = (over: Partial<Row> = {}): Row => {
    const row: Row = {
      id: `c${rows.length + 1}`,
      organizationId: 'org-1',
      type: 'REST',
      authType: 'NONE',
      authConfig: null,
      headers: null,
      baseUrl: PLACEHOLDER,
      envVars: null,
      config: { adapterSlug: 'telegram-bot' },
      createdAt: new Date(T0 + rows.length),
      ...over,
    };
    rows.push(row);
    return row;
  };

  const matches = (row: Row, where: any): boolean => {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.organizationId !== undefined && row.organizationId !== where.organizationId) return false;
    if (where.config) {
      let value: any = row.config;
      for (const key of where.config.path) value = value?.[key];
      if (value !== where.config.equals) return false;
    }
    return true;
  };
  const executeRaw = jest.fn(async (strings: TemplateStringsArray, ...values: any[]) => {
    // The two statements of the service, with the meaning they have in
    // PostgreSQL (checked there by hand): replace the state, or merge into it
    // while one of its keys is still empty.
    const sql = strings.join('?');
    const [json, id, organizationId, unlessSet] = values;
    const row = rows.find((r) => r.id === id && r.organizationId === organizationId);
    if (!row) return 0;
    const config = row.config && typeof row.config === 'object' ? row.config : {};
    if (!sql.includes('IS NULL')) {
      row.config = { ...config, [MANAGED_BOT_CONFIG_KEY]: JSON.parse(json) };
      return 1;
    }
    const state = config[MANAGED_BOT_CONFIG_KEY];
    if (!state || typeof state !== 'object' || state[unlessSet] != null) return 0;
    row.config = { ...config, [MANAGED_BOT_CONFIG_KEY]: { ...state, ...JSON.parse(json) } };
    return 1;
  });
  const prisma = {
    connector: {
      findFirst: jest.fn(async ({ where }: any) => {
        const row = rows.find((r) => matches(r, where));
        return row ? { ...row } : null;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        rows
          .filter((r) => matches(r, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((r) => ({ ...r })),
      ),
    },
    $executeRaw: executeRaw,
  };
  const connectors = {
    update: jest.fn(async (id: string, data: Partial<Row>) => {
      const row = rows.find((r) => r.id === id)!;
      Object.assign(row, data);
      return { ...row };
    }),
  };
  const mcpServer = { reloadConnectorTools: jest.fn().mockResolvedValue(undefined) };
  const adapters = {
    verifyCredentials: jest.fn().mockResolvedValue({ ok: true, toolName: 'telegram_bot_get_me', durationMs: 5, sample: '{}' }),
  };
  const productEvents = { log: jest.fn().mockResolvedValue(undefined) };
  const settings: Record<string, string | undefined> = {
    SERVER_URL: 'https://cloud.example.com',
    ENCRYPTION_KEY: 'k9Xw2Lr8Qp4Zt6Vb1Nc3Md5Fg7Hj0SaEuYiOoPlKmJnBhGv',
  };
  const config = { get: jest.fn((key: string) => settings[key]) };

  const calls: Call[] = [];
  const answers: Record<string, (call: Call) => { status?: number; body: unknown } | Error> = {
    getMe: (call) =>
      call.token === MANAGER_TOKEN
        ? { body: { ok: true, result: { id: 7000000001, is_bot: true, username: 'AnythingMCPBot', can_manage_bots: true } } }
        : { body: { ok: true, result: { id: BOT_ID, is_bot: true, username: 'my_own_bot' } } },
    setWebhook: () => ({ body: { ok: true, result: true } }),
    getManagedBotToken: () => ({ body: { ok: true, result: BOT_TOKEN } }),
    sendMessage: () => ({ status: 400, body: { ok: false, description: 'Bad Request: chat not found' } }),
    getUpdates: () => ({ body: { ok: true, result: [] } }),
  };
  const telegram = jest.fn(async (url: string, init: any) => {
    const match = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
    if (!match) throw new Error(`not a Telegram call: ${url}`);
    const call = { token: match[1], method: match[2], body: JSON.parse(init.body) };
    calls.push(call);
    const answer = answers[call.method]?.(call);
    if (!answer) throw new Error(`no answer for ${call.method}`);
    if (answer instanceof Error) throw answer;
    const status = answer.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => answer.body } as Response;
  });

  const clock = { now: T0 };
  const processEnv: Record<string, string | undefined> = {
    TELEGRAM_MANAGER_BOT_TOKEN: MANAGER_TOKEN,
    TELEGRAM_MANAGER_WEBHOOK_SECRET: SECRET,
    ...env,
  };
  class TestService extends TelegramManagedBotService {
    protected fetchImpl(): typeof fetch {
      return telegram as unknown as typeof fetch;
    }
    protected env() {
      return processEnv;
    }
    protected now() {
      return clock.now;
    }
  }
  const service = new TestService(
    prisma as any,
    adapters as any,
    connectors as any,
    mcpServer as any,
    productEvents as any,
    config as any,
  );
  const callsTo = (method: string) => calls.filter((c) => c.method === method);
  const events = (event: string) => productEvents.log.mock.calls.map((c) => c[0]).filter((e) => e.event === event);
  /** Telegram is picked on the page: the pending setup, and the code its link carries. */
  const begin = async (row: Row, userId = 'u1') => {
    const started = await service.begin({ connectorId: row.id, organizationId: row.organizationId, userId });
    return { started, code: started ? codeFromUsername(started.username)! : '' };
  };
  const stateOf = (row: Row) => readManagedBotState(rows.find((r) => r.id === row.id)!.config)!;
  const managedBot = (username: string, id = BOT_ID) => ({
    update_id: 1,
    managed_bot: {
      user: { id: CREATOR_ID, is_bot: false, first_name: 'Ada' },
      bot: { id, is_bot: true, first_name: 'My AnythingMCP bot', username },
    },
  });

  return {
    service, rows, addConnector, prisma, connectors, mcpServer, adapters, productEvents, settings, processEnv,
    telegram, calls, callsTo, answers, clock, events, begin, stateOf, managedBot, executeRaw,
  };
}

describe('TelegramManagedBotService', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }
  });

  afterEach(() => {
    // No token in any log line, in any test.
    for (const line of logged) {
      expect(line).not.toContain(MANAGER_TOKEN);
      expect(line).not.toContain(BOT_TOKEN);
      expect(line).not.toContain(SECRET);
    }
    jest.restoreAllMocks();
  });

  describe('at start-up', () => {
    it('does nothing and offers nothing without a manager token', async () => {
      const t = setup({ TELEGRAM_MANAGER_BOT_TOKEN: undefined });
      expect(await t.service.register()).toBe('off');
      expect(t.telegram).not.toHaveBeenCalled();
      expect(t.service.isEnabledFor('org-1')).toBe(false);
      expect(t.service.isConfigured()).toBe(false);
    });

    it('registers the webhook for managed_bot and message updates, with the secret', async () => {
      const t = setup();
      expect(await t.service.register()).toBe('registered');
      expect(t.callsTo('setWebhook')).toEqual([
        {
          token: MANAGER_TOKEN,
          method: 'setWebhook',
          body: {
            url: 'https://cloud.example.com/api/telegram/manager-webhook',
            secret_token: SECRET,
            allowed_updates: ['managed_bot', 'message'],
          },
        },
      ]);
      expect(t.service.isEnabledFor('org-1')).toBe(true);
      // The same call again changes nothing at Telegram: safe on every boot.
      expect(await t.service.register()).toBe('registered');
    });

    it('stays off when the bot cannot manage bots', async () => {
      const t = setup();
      t.answers.getMe = () => ({ body: { ok: true, result: { id: 1, is_bot: true, username: 'PlainBot' } } });
      expect(await t.service.register()).toBe('not_a_manager');
      expect(t.callsTo('setWebhook')).toHaveLength(0);
      expect(t.service.isEnabledFor('org-1')).toBe(false);
      expect(logged.join('\n')).toContain('Bot Management Mode');
    });

    it('stays off when Telegram could not reach this server', async () => {
      const t = setup();
      t.settings.SERVER_URL = 'http://localhost:4000';
      expect(await t.service.register()).toBe('no_public_url');
      expect(t.callsTo('setWebhook')).toHaveLength(0);
      expect(t.service.isEnabledFor('org-1')).toBe(false);
    });

    it('never stops the boot: Telegram down is a warning', async () => {
      const t = setup();
      t.answers.getMe = () => new Error(`connect ECONNREFUSED https://api.telegram.org/bot${MANAGER_TOKEN}/getMe`);
      expect(() => t.service.onApplicationBootstrap()).not.toThrow();
      expect(await t.service.register()).toBe('failed');
      expect(t.service.isEnabledFor('org-1')).toBe(false);
    });

    it('tries again later, in the background, when Telegram was down at start-up', async () => {
      const t = setup();
      t.answers.getMe = () => ({ status: 502, body: null });
      expect(await t.service.register()).toBe('failed');
      // Within a minute: no new attempt.
      expect(t.service.isEnabledFor('org-1')).toBe(false);
      expect(t.callsTo('getMe')).toHaveLength(1);

      delete (t.answers as any).getMe;
      t.answers.getMe = () => ({ body: { ok: true, result: { id: 1, is_bot: true, username: 'AnythingMCPBot', can_manage_bots: true } } });
      t.clock.now += 61_000;
      expect(t.service.isEnabledFor('org-1')).toBe(false);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(t.service.isEnabledFor('org-1')).toBe(true);
    });

    it('refuses a webhook secret Telegram would not accept', async () => {
      const t = setup({ TELEGRAM_MANAGER_WEBHOOK_SECRET: 'too short' });
      expect(await t.service.register()).toBe('off');
      expect(t.telegram).not.toHaveBeenCalled();
      expect(logged.join('\n')).toContain('TELEGRAM_MANAGER_WEBHOOK_SECRET');
    });
  });

  describe('the allowlist', () => {
    it('offers only the listed workspaces when one is set', async () => {
      const t = setup({ TELEGRAM_MANAGED_BOT_ORG_IDS: 'org-7, org-8' });
      await t.service.register();
      expect(t.service.isEnabledFor('org-7')).toBe(true);
      expect(t.service.isEnabledFor('org-8')).toBe(true);
      expect(t.service.isEnabledFor('org-1')).toBe(false);
      // And starts nothing for the others.
      const row = t.addConnector();
      expect((await t.begin(row)).started).toBeNull();
      expect(t.executeRaw).not.toHaveBeenCalled();
    });

    it('offers every workspace without one', async () => {
      const t = setup();
      await t.service.register();
      expect(t.service.isEnabledFor('org-1')).toBe(true);
      expect(t.service.isEnabledFor('any-other')).toBe(true);
    });
  });

  describe('starting a setup', () => {
    it('keeps the code as a keyed hash with a 30-minute expiry, and hands out the link', async () => {
      const t = setup();
      await t.service.register();
      const row = t.addConnector({ config: { adapterSlug: 'telegram-bot', other: { kept: true } } });
      const { started, code } = await t.begin(row);

      expect(started!.link).toBe(`https://t.me/newbot/AnythingMCPBot/amcp_${code}_bot?name=My%20AnythingMCP%20bot`);
      expect(started!.username).toBe(`amcp_${code}_bot`);
      const stored = t.rows[0].config!;
      expect(stored.other).toEqual({ kept: true });
      expect(stored[MANAGED_BOT_CONFIG_KEY]).toEqual({
        codeHash: hashSetupCode(code, SECRET),
        expiresAt: new Date(T0 + MANAGED_BOT_TTL_MS).toISOString(),
        startedAt: new Date(T0).toISOString(),
        userId: 'u1',
      });
      expect(JSON.stringify(stored)).not.toContain(code);
    });

    it('starts nothing for a connector of another workspace, another app, or one with a token', async () => {
      const t = setup();
      await t.service.register();
      const other = t.addConnector({ organizationId: 'org-2' });
      const shopify = t.addConnector({ config: { adapterSlug: 'shopify' } });
      const full = t.addConnector({ baseUrl: 'https://api.telegram.org/bot1:x', envVars: { TELEGRAM_BOT_TOKEN: '1:x' } });

      expect(await t.service.begin({ connectorId: other.id, organizationId: 'org-1', userId: 'u1' })).toBeNull();
      expect((await t.begin(shopify)).started).toBeNull();
      expect((await t.begin(full)).started).toBeNull();
      expect(t.executeRaw).not.toHaveBeenCalled();
    });
  });

  describe('the manager bot is told about a new bot', () => {
    it('finds the connector by the username, fetches the token and stores it like a pasted one', async () => {
      const t = setup();
      await t.service.register();
      const row = t.addConnector();
      const { code } = await t.begin(row);

      expect(await t.service.handleUpdate(t.managedBot(`amcp_${code}_bot`))).toBe('connected');

      expect(t.callsTo('getManagedBotToken')).toEqual([
        { token: MANAGER_TOKEN, method: 'getManagedBotToken', body: { user_id: BOT_ID } },
      ]);
      // Written by the setup page's own writer, to this connector only.
      expect(t.connectors.update).toHaveBeenCalledTimes(1);
      expect(t.connectors.update.mock.calls[0][0]).toBe(row.id);
      expect(t.connectors.update.mock.calls[0][1].envVars).toEqual({ TELEGRAM_BOT_TOKEN: BOT_TOKEN });
      expect(t.mcpServer.reloadConnectorTools).toHaveBeenCalledWith(row.id);
      expect(t.rows[0].envVars).toEqual({ TELEGRAM_BOT_TOKEN: BOT_TOKEN });

      const state = t.stateOf(row);
      expect(state.connectedAt).toBe(new Date(T0).toISOString());
      expect(state.via).toBe('managed_bot');
      expect(state.botUsername).toBe(`amcp_${code}_bot`);
      // Neither the token nor the creator's Telegram id is kept in the config.
      const config = JSON.stringify(t.rows[0].config);
      expect(config).not.toContain(BOT_TOKEN);
      expect(config).not.toContain(String(CREATOR_ID));

      expect(t.events('telegram_bot_connected')).toEqual([
        {
          event: 'telegram_bot_connected',
          userId: 'u1',
          organizationId: 'org-1',
          metadata: { adapterSlug: 'telegram-bot', connectorId: row.id },
        },
      ]);
      expect(t.events('setup_completed')).toEqual([
        expect.objectContaining({ organizationId: 'org-1', metadata: { adapterSlug: 'telegram-bot', via: 'telegram_one_tap', verified: true } }),
      ]);
      expect(t.events('telegram_bot_unmatched')).toHaveLength(0);
    });

    it('matches whatever case Telegram reports the username in', async () => {
      const t = setup();
      await t.service.register();
      const row = t.addConnector();
      const { code } = await t.begin(row);
      expect(await t.service.handleUpdate(t.managedBot(`AMCP_${code.toUpperCase()}_Bot`))).toBe('connected');
      expect(t.rows[0].envVars).toEqual({ TELEGRAM_BOT_TOKEN: BOT_TOKEN });
    });

    it('takes the second announcement of the same bot as done: one token write, one event', async () => {
      const t = setup();
      await t.service.register();
      const row = t.addConnector();
      const { code } = await t.begin(row);
      const username = `amcp_${code}_bot`;

      await t.service.handleUpdate(t.managedBot(username));
      const asMessage = {
        update_id: 2,
        message: {
          message_id: 9,
          from: { id: CREATOR_ID, is_bot: false },
          chat: { id: CREATOR_ID, type: 'private' },
          managed_bot_created: { bot: { id: BOT_ID, is_bot: true, username } },
        },
      };
      expect(await t.service.handleUpdate(asMessage)).toBe('already_connected');
      // A later token change of a connected bot is left alone as well.
      expect(await t.service.handleUpdate(t.managedBot(username))).toBe('already_connected');

      expect(t.connectors.update).toHaveBeenCalledTimes(1);
      expect(t.callsTo('getManagedBotToken')).toHaveLength(1);
      expect(t.events('telegram_bot_connected')).toHaveLength(1);
    });

    it('also works from the service message alone', async () => {
      const t = setup();
      await t.service.register();
      const row = t.addConnector();
      const { code } = await t.begin(row);
      const outcome = await t.service.handleUpdate({
        update_id: 2,
        message: {
          from: { id: CREATOR_ID },
          chat: { id: CREATOR_ID, type: 'private' },
          managed_bot_created: { bot: { id: BOT_ID, is_bot: true, username: `amcp_${code}_bot` } },
        },
      });
      expect(outcome).toBe('connected');
      expect(t.rows[0].envVars).toEqual({ TELEGRAM_BOT_TOKEN: BOT_TOKEN });
    });

    it('logs a bot whose username carries no code as unmatched, once, and writes nothing', async () => {
      const t = setup();
      await t.service.register();
      const row = t.addConnector();
      await t.begin(row);
      t.executeRaw.mockClear();

      expect(await t.service.handleUpdate(t.managedBot('my_renamed_shop_bot'))).toBe('unmatched');
      // The same bot announced a second time, as a message.
      expect(
        await t.service.handleUpdate({
          message: { from: { id: CREATOR_ID }, managed_bot_created: { bot: { id: BOT_ID, username: 'my_renamed_shop_bot' } } },
        }),
      ).toBe('unmatched');

      expect(t.events('telegram_bot_unmatched')).toEqual([
        { event: 'telegram_bot_unmatched', userId: null, organizationId: null, metadata: { adapterSlug: 'telegram-bot', kind: 'no_code' } },
      ]);
      expect(t.callsTo('getManagedBotToken')).toHaveLength(0);
      expect(t.connectors.update).not.toHaveBeenCalled();
      expect(t.executeRaw).not.toHaveBeenCalled();
      expect(t.rows[0].envVars).toBeNull();
      // Nothing about the bot or its owner in the log either.
      expect(logged.join('\n')).not.toContain('my_renamed_shop_bot');
      expect(logged.join('\n')).not.toContain(String(CREATOR_ID));
    });

    it('logs a code nobody is waiting for as unmatched and writes nothing', async () => {
      const t = setup();
      await t.service.register();
      t.addConnector();
      expect(await t.service.handleUpdate(t.managedBot('amcp_0badc0de_bot'))).toBe('unmatched');
      expect(t.events('telegram_bot_unmatched')[0].metadata).toEqual({ adapterSlug: 'telegram-bot', kind: 'unknown_code' });
      expect(t.callsTo('getManagedBotToken')).toHaveLength(0);
      expect(t.connectors.update).not.toHaveBeenCalled();
    });

    it('refuses a code after its 30 minutes', async () => {
      const t = setup();
      await t.service.register();
      const row = t.addConnector();
      const { code } = await t.begin(row);
      t.executeRaw.mockClear();
      t.clock.now = T0 + MANAGED_BOT_TTL_MS + 1_000;

      expect(await t.service.handleUpdate(t.managedBot(`amcp_${code}_bot`))).toBe('expired');

      expect(t.callsTo('getManagedBotToken')).toHaveLength(0);
      expect(t.connectors.update).not.toHaveBeenCalled();
      expect(t.executeRaw).not.toHaveBeenCalled();
      expect(t.rows[0].envVars).toBeNull();
      expect(t.events('telegram_bot_unmatched')).toEqual([
        { event: 'telegram_bot_unmatched', userId: 'u1', organizationId: 'org-1', metadata: { adapterSlug: 'telegram-bot', kind: 'expired' } },
      ]);
    });

    it('still accepts a code one second before it expires', async () => {
      const t = setup();
      await t.service.register();
      const row = t.addConnector();
      const { code } = await t.begin(row);
      t.clock.now = T0 + MANAGED_BOT_TTL_MS - 1_000;
      expect(await t.service.handleUpdate(t.managedBot(`amcp_${code}_bot`))).toBe('connected');
    });

    it('leaves a token the user pasted in the meantime', async () => {
      const t = setup();
      await t.service.register();
      const row = t.addConnector();
      const { code } = await t.begin(row);
      t.rows[0].envVars = { TELEGRAM_BOT_TOKEN: '111:AAHpastedByTheUserInTheDashboard00000000' };

      expect(await t.service.handleUpdate(t.managedBot(`amcp_${code}_bot`))).toBe('connector_has_token');
      expect(t.callsTo('getManagedBotToken')).toHaveLength(0);
      expect(t.connectors.update).not.toHaveBeenCalled();
      expect(t.rows[0].envVars!.TELEGRAM_BOT_TOKEN).toContain('pastedByTheUser');
    });

    it('asks for the update again when Telegram does not answer, and gives up on a refusal', async () => {
      const t = setup();
      await t.service.register();
      const row = t.addConnector();
      const { code } = await t.begin(row);
      const update = t.managedBot(`amcp_${code}_bot`);

      t.answers.getManagedBotToken = () => new Error('timeout');
      expect(await t.service.handleUpdate(update)).toBe('retry');
      t.answers.getManagedBotToken = () => ({ status: 502, body: null });
      expect(await t.service.handleUpdate(update)).toBe('retry');
      expect(t.connectors.update).not.toHaveBeenCalled();
      expect(t.events('telegram_bot_unmatched')).toHaveLength(0);

      t.answers.getManagedBotToken = () => ({ status: 400, body: { ok: false, description: 'Bad Request: bot is not managed' } });
      expect(await t.service.handleUpdate(update)).toBe('token_refused');
      expect(t.connectors.update).not.toHaveBeenCalled();
      expect(t.events('telegram_bot_unmatched')[0].metadata).toEqual({ adapterSlug: 'telegram-bot', kind: 'token_refused' });
    });

    it('refuses a token that is not that bot\'s', async () => {
      const t = setup();
      await t.service.register();
      const row = t.addConnector();
      const { code } = await t.begin(row);
      t.answers.getManagedBotToken = () => ({ body: { ok: true, result: '999:AAGsomeOtherBotsTokenForTestsOnly0123456' } });
      expect(await t.service.handleUpdate(t.managedBot(`amcp_${code}_bot`))).toBe('token_refused');
      expect(t.connectors.update).not.toHaveBeenCalled();
    });

    it('ignores every other update', async () => {
      const t = setup();
      await t.service.register();
      for (const update of [null, {}, { message: { text: '/start abc', from: { id: 1 }, chat: { id: 1 } } }, { managed_bot: { bot: { id: 'x' } } }]) {
        expect(await t.service.handleUpdate(update)).toBe('ignored');
      }
      expect(t.productEvents.log).not.toHaveBeenCalled();
    });

    it('does nothing when the feature is off', async () => {
      const t = setup({ TELEGRAM_MANAGER_BOT_TOKEN: '' });
      expect(await t.service.handleUpdate(t.managedBot('amcp_1a2b3c4d_bot'))).toBe('ignored');
      expect(t.telegram).not.toHaveBeenCalled();
    });
  });

  describe('the webhook secret', () => {
    it('accepts only this instance\'s secret', async () => {
      const t = setup();
      expect(t.service.verifyWebhookSecret(SECRET)).toBe(true);
      for (const wrong of [undefined, '', `${SECRET}x`, SECRET.slice(1), SECRET.toUpperCase(), ['x']]) {
        expect(t.service.verifyWebhookSecret(wrong)).toBe(false);
      }
    });

    it('accepts nothing when the feature is off', () => {
      const t = setup({ TELEGRAM_MANAGER_BOT_TOKEN: undefined });
      expect(t.service.verifyWebhookSecret(SECRET)).toBe(false);
    });
  });

  describe('the status the page polls', () => {
    it('says none, waiting, connected and expired', async () => {
      const t = setup();
      await t.service.register();
      expect(await t.service.status({ organizationId: 'org-1', userId: 'u1' })).toEqual({ state: 'none' });

      const row = t.addConnector();
      const { code } = await t.begin(row);
      expect(await t.service.status({ organizationId: 'org-1', userId: 'u1' })).toEqual({ state: 'waiting' });
      // Another user, or another workspace, sees nothing of it.
      expect(await t.service.status({ organizationId: 'org-1', userId: 'u2' })).toEqual({ state: 'none' });
      expect(await t.service.status({ organizationId: 'org-2', userId: 'u1' })).toEqual({ state: 'none' });

      t.clock.now = T0 + MANAGED_BOT_TTL_MS + 1;
      expect(await t.service.status({ organizationId: 'org-1', userId: 'u1' })).toEqual({ state: 'expired' });

      t.clock.now = T0 + 60_000;
      await t.service.handleUpdate(t.managedBot(`amcp_${code}_bot`));
      expect(await t.service.status({ organizationId: 'org-1', userId: 'u1' })).toEqual({
        state: 'connected',
        bot: `@amcp_${code}_bot`,
        startUrl: `https://t.me/amcp_${code}_bot`,
      });
    });

    it('records the first click on the link, once', async () => {
      const t = setup();
      await t.service.register();
      await t.begin(t.addConnector());
      await t.service.status({ organizationId: 'org-1', userId: 'u1', opened: true, device: 'mobile' });
      await t.service.status({ organizationId: 'org-1', userId: 'u1', opened: true, device: 'mobile' });
      await t.service.status({ organizationId: 'org-1', userId: 'u1' });
      expect(t.events('telegram_bot_link_opened')).toEqual([
        { event: 'telegram_bot_link_opened', userId: 'u1', organizationId: 'org-1', metadata: { adapterSlug: 'telegram-bot', device: 'mobile' } },
      ]);
    });
  });

  describe('the welcome message', () => {
    const startFrom = (userId: number) => ({
      update_id: 77,
      message: { message_id: 1, text: '/start', from: { id: userId, is_bot: false }, chat: { id: userId, type: 'private' } },
    });
    const connect = async () => {
      const t = setup();
      await t.service.register();
      const row = t.addConnector();
      const { code } = await t.begin(row);
      await t.service.handleUpdate(t.managedBot(`amcp_${code}_bot`));
      return { t, row };
    };

    it('is tried at once, and a refusal ("chat not found") does not fail the setup', async () => {
      const { t, row } = await connect();
      expect(t.callsTo('sendMessage')).toEqual([
        { token: BOT_TOKEN, method: 'sendMessage', body: { chat_id: CREATOR_ID, text: WELCOME_TEXT } },
      ]);
      expect(t.stateOf(row).welcomedAt).toBeUndefined();
      expect(t.stateOf(row).connectedAt).toBeDefined();
    });

    it('is marked done when the first try works', async () => {
      const t = setup();
      await t.service.register();
      const row = t.addConnector();
      const { code } = await t.begin(row);
      t.answers.sendMessage = () => ({ body: { ok: true, result: { message_id: 3 } } });
      await t.service.handleUpdate(t.managedBot(`amcp_${code}_bot`));

      expect(t.stateOf(row).welcomedAt).toBeDefined();
      expect(await t.service.status({ organizationId: 'org-1', userId: 'u1' })).toEqual({ state: 'connected', bot: `@amcp_${code}_bot` });
      // Nothing to look for any more.
      expect(t.callsTo('getUpdates')).toHaveLength(0);
    });

    it('is sent once after the creator\'s /start, read without confirming any update', async () => {
      const { t, row } = await connect();
      t.answers.sendMessage = () => ({ body: { ok: true, result: { message_id: 3 } } });

      // Nobody pressed Start yet.
      t.clock.now += 3_000;
      let status = await t.service.status({ organizationId: 'org-1', userId: 'u1' });
      expect(status).toEqual(expect.objectContaining({ state: 'connected', startUrl: expect.any(String) }));
      expect(t.callsTo('sendMessage')).toHaveLength(1);

      // A stranger's /start is not the creator's; then the creator presses Start.
      t.answers.getUpdates = () => ({ body: { ok: true, result: [startFrom(999)] } });
      t.clock.now += 3_000;
      await t.service.status({ organizationId: 'org-1', userId: 'u1' });
      expect(t.callsTo('sendMessage')).toHaveLength(1);

      t.answers.getUpdates = () => ({ body: { ok: true, result: [startFrom(999), startFrom(CREATOR_ID)] } });
      t.clock.now += 3_000;
      status = await t.service.status({ organizationId: 'org-1', userId: 'u1' });
      expect(status).toEqual({ state: 'connected', bot: expect.stringMatching(/^@amcp_/) });
      expect(t.callsTo('sendMessage')).toHaveLength(2);
      expect(t.callsTo('sendMessage')[1]).toEqual({
        token: BOT_TOKEN,
        method: 'sendMessage',
        body: { chat_id: CREATOR_ID, text: WELCOME_TEXT },
      });
      expect(t.stateOf(row).welcomedAt).toBeDefined();

      // No offset and no allowed_updates: nothing is confirmed, and nothing is
      // changed for the connector's own telegram_bot_get_updates.
      for (const call of t.callsTo('getUpdates')) {
        expect(call.token).toBe(BOT_TOKEN);
        expect(call.body).toEqual({ timeout: 0 });
      }
      // Never a webhook on the user's bot.
      expect(t.callsTo('setWebhook').every((c) => c.token === MANAGER_TOKEN)).toBe(true);

      // Later checks send nothing more.
      t.clock.now += 3_000;
      await t.service.status({ organizationId: 'org-1', userId: 'u1' });
      expect(t.callsTo('sendMessage')).toHaveLength(2);
    });

    it('does not look more often than every few seconds, nor after 15 minutes', async () => {
      const { t } = await connect();
      await t.service.status({ organizationId: 'org-1', userId: 'u1' });
      await t.service.status({ organizationId: 'org-1', userId: 'u1' });
      expect(t.callsTo('getUpdates')).toHaveLength(1);

      t.clock.now += 16 * 60_000;
      await t.service.status({ organizationId: 'org-1', userId: 'u1' });
      expect(t.callsTo('getUpdates')).toHaveLength(1);
    });

    it('never breaks the status when Telegram fails', async () => {
      const { t } = await connect();
      t.answers.getUpdates = () => new Error('boom');
      await expect(t.service.status({ organizationId: 'org-1', userId: 'u1' })).resolves.toEqual(
        expect.objectContaining({ state: 'connected' }),
      );
    });
  });

  describe('pasting the token of a bot one already has', () => {
    const PASTED = `${BOT_ID}:AAGpastedTokenForTestsOnly0123456789abc`;
    const ready = async () => {
      const t = setup();
      await t.service.register();
      const row = t.addConnector();
      await t.begin(row);
      return { t, row };
    };

    it('checks it like the setup page and stores it the same way', async () => {
      const { t, row } = await ready();
      const answer = await t.service.saveToken({ organizationId: 'org-1', userId: 'u1', token: `  ${PASTED}\n` });

      expect(answer).toEqual({ ok: true, bot: '@my_own_bot' });
      expect(t.adapters.verifyCredentials).toHaveBeenCalledWith('telegram-bot', 'org-1', { TELEGRAM_BOT_TOKEN: PASTED }, row.id);
      expect(t.connectors.update.mock.calls[0][1].envVars).toEqual({ TELEGRAM_BOT_TOKEN: PASTED });
      expect(t.mcpServer.reloadConnectorTools).toHaveBeenCalledWith(row.id);
      expect(t.stateOf(row)).toEqual(expect.objectContaining({ via: 'pasted', botUsername: 'my_own_bot' }));
      expect(t.events('telegram_bot_token_pasted')).toEqual([
        {
          event: 'telegram_bot_token_pasted',
          userId: 'u1',
          organizationId: 'org-1',
          metadata: { adapterSlug: 'telegram-bot', connectorId: row.id, status: 'saved' },
        },
      ]);
      expect(t.events('setup_completed')[0].metadata).toEqual({ adapterSlug: 'telegram-bot', via: 'post_approve_token', verified: true });
      // A bot the user already had is never greeted: its chats are theirs.
      expect(await t.service.status({ organizationId: 'org-1', userId: 'u1' })).toEqual({ state: 'connected', bot: '@my_own_bot' });
      expect(t.callsTo('sendMessage')).toHaveLength(0);
      expect(t.callsTo('getUpdates')).toHaveLength(0);
    });

    it.each(['', 'hello', '123456789:short', 42, null])('refuses %p before asking Telegram', async (token) => {
      const { t } = await ready();
      const answer = await t.service.saveToken({ organizationId: 'org-1', userId: 'u1', token });
      expect(answer).toEqual({ ok: false, error: expect.stringContaining('does not look like a bot token') });
      expect(t.adapters.verifyCredentials).not.toHaveBeenCalled();
      expect(t.connectors.update).not.toHaveBeenCalled();
    });

    it('says what Telegram said when it refuses the token, and stores nothing', async () => {
      const { t, row } = await ready();
      t.adapters.verifyCredentials.mockResolvedValue({ ok: false, kind: 'auth_failed', message: 'Telegram refused the bot token.', status: 401 });
      const answer = await t.service.saveToken({ organizationId: 'org-1', userId: 'u1', token: PASTED });

      expect(answer).toEqual({ ok: false, error: 'Telegram refused the bot token.' });
      expect(t.connectors.update).not.toHaveBeenCalled();
      expect(t.events('telegram_bot_token_pasted')[0].metadata).toEqual({
        adapterSlug: 'telegram-bot',
        connectorId: row.id,
        status: 'refused',
        kind: 'auth_failed',
      });
    });

    it('never replaces a token, and takes none for another user or workspace', async () => {
      const { t } = await ready();
      expect(await t.service.saveToken({ organizationId: 'org-1', userId: 'u2', token: PASTED })).toEqual(
        expect.objectContaining({ ok: false }),
      );
      expect(await t.service.saveToken({ organizationId: 'org-2', userId: 'u1', token: PASTED })).toEqual(
        expect.objectContaining({ ok: false }),
      );
      t.rows[0].envVars = { TELEGRAM_BOT_TOKEN: '111:AAHalreadyThereBeforeThePaste000000000000' };
      expect(await t.service.saveToken({ organizationId: 'org-1', userId: 'u1', token: PASTED })).toEqual({
        ok: false,
        error: 'Telegram is already connected.',
      });
      expect(t.connectors.update).not.toHaveBeenCalled();
      expect(t.adapters.verifyCredentials).not.toHaveBeenCalled();
    });

    it('is refused where the feature is off for the workspace', async () => {
      const t = setup({ TELEGRAM_MANAGED_BOT_ORG_IDS: 'org-9' });
      await t.service.register();
      t.addConnector();
      expect(await t.service.saveToken({ organizationId: 'org-1', userId: 'u1', token: PASTED })).toEqual(
        expect.objectContaining({ ok: false }),
      );
      expect(t.adapters.verifyCredentials).not.toHaveBeenCalled();
    });
  });
});
