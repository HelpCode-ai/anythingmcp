import { Logger } from '@nestjs/common';
import { ProductEventService } from '../audit/product-event.service';
import { McpClientSeenRegistry } from '../mcp-server/mcp-client-seen';
import { TelegramClaimStore } from './telegram-claim.store';
import {
  CLIENT_SEEN_EVERY_MS,
  START_MAX_PER_MINUTE,
  START_MAX_PER_SENDER,
  TelegramManagedBotService,
} from './telegram-managed-bot.service';
import {
  CLAIM_ALREADY_TEXT,
  CLAIM_FAILED_TEXT,
  CLAIM_INVALID_TEXT,
  CLAIM_LINKED_TEXT,
  CLAIM_WAITING_TEXT,
  CLIENT_NOTICE_WINDOW_MS,
  MANAGED_BOT_CONFIG_KEY,
  MANAGED_BOT_TTL_MS,
  MANAGER_GREETING_TEXT,
  claimParameter,
  codeFromUsername,
  hashSetupCode,
  hashTelegramUserId,
  readManagedBotState,
  welcomeText,
} from './telegram-managed-bot';

const MANAGER_TOKEN = '7000000001:AAF4kq0ManagerBotTokenForTestsOnly00';
const SECRET = 'webhook-secret-for-tests-0123456789';
const BOT_ID = 8123456789;
const BOT_TOKEN = `${BOT_ID}:AAGnewBotTokenForTestsOnly0123456789ab`;
const CREATOR_ID = 555001;
const OTHER_ID = 777002;
const PLACEHOLDER = 'https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}';
const T0 = Date.parse('2026-11-15T09:00:00.000Z');
/** The AI client the page was shown for, in most tests. */
const CLAUDE = { name: 'Claude', claude: true };
/** What the bot tells its creator when it is connected. */
const WELCOME_TEXT = welcomeText('Claude');

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
  const clock = { now: T0 };
  const rows: Row[] = [];
  /** The `site_settings` table: the claim store's rows. */
  const site = new Map<string, { value: string; updatedAt: Date }>();
  const siteSettings = {
    findUnique: jest.fn(async ({ where }: any) => {
      const row = site.get(where.key);
      return row ? { value: row.value } : null;
    }),
    upsert: jest.fn(async ({ where, update, create }: any) => {
      site.set(where.key, { value: (site.has(where.key) ? update : create).value, updatedAt: new Date(clock.now) });
      return {};
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      let count = 0;
      for (const [key, row] of [...site]) {
        const named =
          typeof where.key === 'string'
            ? key === where.key
            : (where.OR as Array<{ key: { startsWith: string } }>).some((c) => key.startsWith(c.key.startsWith));
        if (named && (!where.updatedAt || row.updatedAt < where.updatedAt.lt)) {
          site.delete(key);
          count += 1;
        }
      }
      return { count };
    }),
  };
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
    siteSettings,
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
  // The real service, on a table that only records: a metadata key or value
  // outside its allow-list is dropped here exactly as it is in production.
  const stored: Array<{ event: string; organizationId: string | null; userId: string | null; metadata: unknown }> = [];
  const realEvents = new ProductEventService({
    productEvent: {
      create: jest.fn(async ({ data }: any) => {
        stored.push({ event: data.event, organizationId: data.organizationId, userId: data.userId, metadata: data.metadata ?? null });
        return {};
      }),
    },
  } as any);
  const productEvents = { log: jest.fn((input: Parameters<ProductEventService['log']>[0]) => realEvents.log(input)) };
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
    getManagedBotToken: (call) => ({ body: { ok: true, result: `${call.body.user_id}:AAGnewBotTokenForTestsOnly0123456789ab` } }),
    // The manager bot's chat exists (the user pressed Start there); a new
    // bot's chat does not, until its creator starts it.
    sendMessage: (call) =>
      call.token === MANAGER_TOKEN
        ? { body: { ok: true, result: { message_id: 1 } } }
        : { status: 400, body: { ok: false, description: 'Bad Request: chat not found' } },
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
  const claims = new TelegramClaimStore(prisma as any);
  /** What the MCP endpoint tells on every tools/list of the shared endpoint. */
  const clientSeen = new McpClientSeenRegistry();
  const service = new TestService(
    prisma as any,
    adapters as any,
    connectors as any,
    mcpServer as any,
    productEvents as any,
    config as any,
    claims,
    clientSeen,
  );
  const callsTo = (method: string) => calls.filter((c) => c.method === method);
  const events = (event: string) => productEvents.log.mock.calls.map((c) => c[0]).filter((e) => e.event === event);
  /** What the manager bot wrote in a person's chat. */
  const said = (chatId: number) =>
    calls.filter((c) => c.method === 'sendMessage' && c.token === MANAGER_TOKEN && c.body.chat_id === chatId).map((c) => c.body.text);
  /** Telegram is picked on the page: the pending setup, and the code its link carries. */
  const begin = async (row: Row, userId = 'u1', client: { name: string; claude: boolean } | null = CLAUDE) => {
    const started = await service.begin({ connectorId: row.id, organizationId: row.organizationId, userId, ...(client ? { client } : {}) });
    return { started, code: started ? codeFromUsername(started.username)! : '' };
  };
  const stateOf = (row: Row) => readManagedBotState(rows.find((r) => r.id === row.id)!.config)!;
  let nextUpdateId = 100;
  const managedBot = (username: string, id = BOT_ID, creatorId = CREATOR_ID, updateId = 1) => ({
    update_id: updateId,
    managed_bot: {
      user: { id: creatorId, is_bot: false, first_name: 'Ada' },
      bot: { id, is_bot: true, first_name: 'My AnythingMCP bot', username },
    },
  });
  /**
   * A person presses Start in the manager bot's chat. A setup code is sent as
   * the page's link carries it (the code and its keyed check, issued under
   * SECRET); anything else is sent as it is, and nothing is a plain /start.
   */
  const start = (code?: string, from = CREATOR_ID, updateId = nextUpdateId++, secret = SECRET) => ({
    update_id: updateId,
    message: {
      message_id: 12,
      date: 1_700_000_000,
      text: code === undefined ? '/start' : `/start ${/^[0-9a-f]{8}$/.test(code) ? claimParameter(code, secret) : code}`,
      from: { id: from, is_bot: false, first_name: 'Ada', username: 'ada_lovelace' },
      chat: { id: from, type: 'private', first_name: 'Ada', username: 'ada_lovelace' },
    },
  });

  return {
    service, rows, addConnector, prisma, connectors, mcpServer, adapters, productEvents, settings, processEnv,
    telegram, calls, callsTo, answers, clock, events, begin, stateOf, managedBot, executeRaw,
    site, siteSettings, claims, stored, said, start, clientSeen,
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
      // Nor a Telegram account's id or username.
      expect(line).not.toContain(String(CREATOR_ID));
      expect(line).not.toContain(String(OTHER_ID));
      expect(line).not.toContain('ada_lovelace');
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
        // The AI client the page was shown for: for the bot's two messages.
        client: 'Claude',
        claude: true,
      });
      expect(JSON.stringify(stored)).not.toContain(code);
    });

    it('keeps the name of another client without the link to a chat, and no name that is not one', async () => {
      const t = setup();
      await t.service.register();
      const chatgpt = t.addConnector();
      await t.begin(chatgpt, 'u1', { name: ' ChatGPT ', claude: false });
      expect(t.stateOf(chatgpt)).toEqual(expect.objectContaining({ client: 'ChatGPT' }));
      expect(t.stateOf(chatgpt).claude).toBeUndefined();

      // A client names itself when it registers: only a short plain name is ever quoted.
      const odd = t.addConnector();
      await t.begin(odd, 'u2', { name: 'Claude. Now open https://evil.example', claude: false });
      expect(t.stateOf(odd).client).toBeUndefined();
      const none = t.addConnector();
      await t.begin(none, 'u3', null);
      expect(t.stateOf(none).client).toBeUndefined();
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
      // With the creator's chat as the default chat: "send me a message" needs no chat id.
      expect(t.connectors.update.mock.calls[0][1].envVars).toEqual({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_DEFAULT_CHAT_ID: String(CREATOR_ID) });
      expect(t.mcpServer.reloadConnectorTools).toHaveBeenCalledWith(row.id);
      expect(t.rows[0].envVars).toEqual({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_DEFAULT_CHAT_ID: String(CREATOR_ID) });

      const state = t.stateOf(row);
      expect(state.connectedAt).toBe(new Date(T0).toISOString());
      expect(state.via).toBe('managed_bot');
      expect(state.botUsername).toBe(`amcp_${code}_bot`);
      // Neither the token nor the creator's Telegram id is kept in the config:
      // the id lives with the connector's variables, encrypted like them.
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

    it('stores only the token when Telegram does not say who created the bot', async () => {
      const t = setup();
      await t.service.register();
      const row = t.addConnector();
      const { code } = await t.begin(row);
      const update = t.managedBot(`amcp_${code}_bot`) as { managed_bot: { user?: unknown } };
      delete update.managed_bot.user;
      expect(await t.service.handleUpdate(update)).toBe('connected');
      expect(t.rows[0].envVars).toEqual({ TELEGRAM_BOT_TOKEN: BOT_TOKEN });
    });

    it('matches whatever case Telegram reports the username in', async () => {
      const t = setup();
      await t.service.register();
      const row = t.addConnector();
      const { code } = await t.begin(row);
      expect(await t.service.handleUpdate(t.managedBot(`AMCP_${code.toUpperCase()}_Bot`))).toBe('connected');
      expect(t.rows[0].envVars).toEqual({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_DEFAULT_CHAT_ID: String(CREATOR_ID) });
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
      expect(t.rows[0].envVars).toEqual({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_DEFAULT_CHAT_ID: String(CREATOR_ID) });
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
      for (const update of [
        null,
        {},
        { message: { text: 'hello', from: { id: 1 }, chat: { id: 1, type: 'private' } } },
        { edited_message: { text: '/start 1a2b3c4d', from: { id: 1 }, chat: { id: 1, type: 'private' } } },
        { managed_bot: { bot: { id: 'x' } } },
      ]) {
        expect(await t.service.handleUpdate(update)).toBe('ignored');
      }
      expect(t.productEvents.log).not.toHaveBeenCalled();
      expect(t.callsTo('sendMessage')).toHaveLength(0);
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

  describe('the welcome message says one step is left', () => {
    it('sends the user back to the page and its Continue button, not to the chat', async () => {
      const t = setup();
      await t.service.register();
      const row = t.addConnector();
      const { code } = await t.begin(row);
      await t.service.handleUpdate(t.managedBot(`amcp_${code}_bot`));
      const text = t.callsTo('sendMessage')[0].body.text;
      expect(text).toBe(
        'Your bot is connected to AnythingMCP. One step left: go back to the page you came from and tap "Continue to Claude".',
      );
      // The AI client is not connected yet: asking it anything would fail.
      expect(text).not.toMatch(/ask/i);
    });

    it('names the client the page was shown for, or none', async () => {
      const t = setup();
      await t.service.register();
      const chatgpt = t.addConnector();
      const a = await t.begin(chatgpt, 'u1', { name: 'ChatGPT', claude: false });
      await t.service.handleUpdate(t.managedBot(`amcp_${a.code}_bot`));
      expect(t.callsTo('sendMessage')[0].body.text).toContain('tap "Continue to ChatGPT".');

      const unnamed = t.addConnector();
      const b = await t.begin(unnamed, 'u2', null);
      await t.service.handleUpdate(t.managedBot(`amcp_${b.code}_bot`, 8123456790, OTHER_ID, 5));
      expect(t.callsTo('sendMessage')[1].body.text).toBe(
        'Your bot is connected to AnythingMCP. One step left: go back to the page you came from and tap Continue.',
      );
    });
  });

  describe('the AI client\'s first request after a one-tap bot', () => {
    const ME = { organizationId: 'org-1', userId: 'u1' };
    const NOTICE = 'Claude is now connected to AnythingMCP. Ask it: "Send me a test message on Telegram."';
    const BUTTON = {
      inline_keyboard: [
        [{ text: 'Open a new chat in Claude', url: 'https://claude.ai/new?q=Send%20me%20a%20test%20message%20on%20Telegram.' }],
      ],
    };
    /** A one-tap bot whose creator pressed Start, so the welcome was delivered. */
    const connected = async (opts: { client?: { name: string; claude: boolean } | null; welcomed?: boolean } = {}) => {
      const t = setup();
      await t.service.register();
      const row = t.addConnector();
      const { code } = await t.begin(row, 'u1', opts.client === undefined ? CLAUDE : opts.client);
      if (opts.welcomed !== false) t.answers.sendMessage = () => ({ body: { ok: true, result: { message_id: 3 } } });
      await t.service.handleUpdate(t.managedBot(`amcp_${code}_bot`));
      t.clock.now += 3 * 60_000; // what real users took to tap Continue
      return { t, row };
    };
    /** What the user's bot sent apart from the welcome. */
    const notices = (t: ReturnType<typeof setup>) =>
      t.callsTo('sendMessage').filter((c) => c.token === BOT_TOKEN && !String(c.body.text).startsWith('Your bot is connected'));
    const flush = async () => {
      for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
    };

    it('tells the creator that Claude is connected, with a button that opens a new chat with the request', async () => {
      const { t, row } = await connected();
      expect(await t.service.announceClient('org-1', 'u1')).toBe('sent');

      expect(notices(t)).toEqual([
        { token: BOT_TOKEN, method: 'sendMessage', body: { chat_id: CREATOR_ID, text: NOTICE, reply_markup: BUTTON } },
      ]);
      expect(t.stateOf(row).clientNoticeAt).toBe(new Date(t.clock.now).toISOString());
      // Through the real event service: every field survives its allow-list.
      expect(t.stored.filter((e) => e.event === 'telegram_bot_client_notice')).toEqual([
        {
          event: 'telegram_bot_client_notice',
          organizationId: 'org-1',
          userId: 'u1',
          metadata: { adapterSlug: 'telegram-bot', connectorId: row.id, status: 'sent', client: 'Claude', kind: 'chat_link' },
        },
      ]);
    });

    it('says the same to another client\'s user, without a link', async () => {
      const { t, row } = await connected({ client: { name: 'ChatGPT', claude: false } });
      expect(await t.service.announceClient('org-1', 'u1')).toBe('sent');
      expect(notices(t)).toEqual([
        {
          token: BOT_TOKEN,
          method: 'sendMessage',
          body: { chat_id: CREATOR_ID, text: 'ChatGPT is now connected to AnythingMCP. Ask it: "Send me a test message on Telegram."' },
        },
      ]);
      expect(t.stored.filter((e) => e.event === 'telegram_bot_client_notice')[0].metadata).toEqual({
        adapterSlug: 'telegram-bot',
        connectorId: row.id,
        status: 'sent',
        client: 'ChatGPT',
      });
    });

    it('names no client it does not know', async () => {
      const { t } = await connected({ client: null });
      expect(await t.service.announceClient('org-1', 'u1')).toBe('sent');
      expect(notices(t)[0].body).toEqual({
        chat_id: CREATOR_ID,
        text: 'Your AI assistant is now connected to AnythingMCP. Ask it: "Send me a test message on Telegram."',
      });
    });

    it('writes once per connector, however many requests arrive, also at the same moment', async () => {
      const { t } = await connected();
      const both = await Promise.all([t.service.announceClient('org-1', 'u1'), t.service.announceClient('org-1', 'u1')]);
      expect(both.sort()).toEqual(['none', 'sent']);
      expect(await t.service.announceClient('org-1', 'u1')).toBe('none');
      expect(notices(t)).toHaveLength(1);
      expect(t.stored.filter((e) => e.event === 'telegram_bot_client_notice')).toHaveLength(1);
    });

    it('waits for the welcome: a bot whose creator has not pressed Start cannot write to them', async () => {
      const { t, row } = await connected({ welcomed: false });
      expect(t.stateOf(row).welcomedAt).toBeUndefined();
      expect(await t.service.announceClient('org-1', 'u1')).toBe('none');
      expect(notices(t)).toHaveLength(0);
      expect(t.stateOf(row).clientNoticeAt).toBeUndefined();

      // The creator presses Start; the page's next check delivers the welcome.
      t.answers.sendMessage = () => ({ body: { ok: true, result: { message_id: 3 } } });
      t.answers.getUpdates = () => ({
        body: {
          ok: true,
          result: [{ update_id: 7, message: { text: '/start', from: { id: CREATOR_ID }, chat: { id: CREATOR_ID, type: 'private' } } }],
        },
      });
      await t.service.status(ME);
      expect(t.stateOf(row).welcomedAt).toBeDefined();
      expect(await t.service.announceClient('org-1', 'u1')).toBe('sent');
      expect(notices(t).map((c) => c.body.text)).toEqual([NOTICE]);
    });

    it('is only for a bot created in one tap, in the last 30 minutes, by the user whose client it is', async () => {
      // A request of another member of the workspace, or for another workspace.
      const a = await connected();
      expect(await a.t.service.announceClient('org-1', 'u2')).toBe('none');
      expect(await a.t.service.announceClient('org-2', 'u1')).toBe('none');
      expect(notices(a.t)).toHaveLength(0);

      // One second after the 30 minutes; and still one second before.
      const b = await connected();
      b.t.clock.now = T0 + CLIENT_NOTICE_WINDOW_MS + 1_000;
      expect(await b.t.service.announceClient('org-1', 'u1')).toBe('none');
      b.t.clock.now = T0 + CLIENT_NOTICE_WINDOW_MS - 1_000;
      expect(await b.t.service.announceClient('org-1', 'u1')).toBe('sent');

      // A pasted token: no creator is known, and nothing was promised.
      const c = setup();
      await c.service.register();
      const row = c.addConnector();
      await c.begin(row);
      await c.service.saveToken({ ...ME, token: `${BOT_ID}:AAGpastedTokenForTestsOnly0123456789abc` });
      expect(c.stateOf(row).via).toBe('pasted');
      expect(await c.service.announceClient('org-1', 'u1')).toBe('none');
      expect(c.callsTo('sendMessage')).toHaveLength(0);
    });

    it('writes to the connector\'s default chat, and to nobody when the workspace removed it', async () => {
      const a = await connected();
      a.t.rows[0].envVars = { ...a.t.rows[0].envVars!, TELEGRAM_DEFAULT_CHAT_ID: '424242' };
      expect(await a.t.service.announceClient('org-1', 'u1')).toBe('sent');
      expect(notices(a.t)[0].body.chat_id).toBe(424242);

      const b = await connected();
      const { TELEGRAM_DEFAULT_CHAT_ID: _removed, ...rest } = b.t.rows[0].envVars!;
      b.t.rows[0].envVars = rest;
      expect(await b.t.service.announceClient('org-1', 'u1')).toBe('none');
      expect(notices(b.t)).toHaveLength(0);
      expect(b.t.stateOf(b.row).clientNoticeAt).toBeUndefined();
    });

    it('records a message Telegram refused, and does not try again', async () => {
      const { t, row } = await connected();
      t.answers.sendMessage = () => ({ status: 403, body: { ok: false, description: 'Forbidden: bot was blocked by the user' } });
      expect(await t.service.announceClient('org-1', 'u1')).toBe('failed');
      expect(t.stored.filter((e) => e.event === 'telegram_bot_client_notice')[0].metadata).toEqual({
        adapterSlug: 'telegram-bot',
        connectorId: row.id,
        status: 'failed',
        client: 'Claude',
        kind: 'chat_link',
      });
      expect(await t.service.announceClient('org-1', 'u1')).toBe('none');
      expect(notices(t)).toHaveLength(1);
    });

    describe('heard from the MCP endpoint', () => {
      it('is told by the registry the endpoint notifies, and answers at once', async () => {
        const { t } = await connected();
        let release: () => void = () => undefined;
        // Telegram takes its time: the request that triggered this is long gone.
        t.answers.sendMessage = () => ({ body: { ok: true, result: { message_id: 4 } } });
        const slow = new Promise<void>((resolve) => (release = resolve));
        const find = t.prisma.connector.findMany.getMockImplementation()!;
        t.prisma.connector.findMany.mockImplementationOnce(async (args: any) => {
          await slow;
          return find(args);
        });

        expect(t.clientSeen.notify(ME)).toBeUndefined();
        await flush();
        expect(notices(t)).toHaveLength(0); // still waiting for the database: nobody waited with it
        release();
        await flush();
        expect(notices(t).map((c) => c.body.text)).toEqual([NOTICE]);
      });

      it('never throws into the request, whatever fails', async () => {
        const { t } = await connected();
        t.prisma.connector.findMany.mockRejectedValueOnce(new Error('database is down'));
        expect(() => t.service.noteClientSeen(ME)).not.toThrow();
        await flush();
        expect(notices(t)).toHaveLength(0);

        // Telegram does not answer: nothing surfaces either, and the claim stands.
        t.clock.now += CLIENT_SEEN_EVERY_MS;
        t.answers.sendMessage = () => new Error('socket hang up');
        expect(() => t.service.noteClientSeen(ME)).not.toThrow();
        await flush();
        expect(t.stored.filter((e) => e.event === 'telegram_bot_client_notice').map((e) => (e.metadata as any).status)).toEqual(['failed']);

        // Nor does a call that makes no sense.
        for (const odd of [undefined, null, {}, { organizationId: 'org-1' }, { organizationId: '', userId: 'u1' }]) {
          expect(() => t.service.noteClientSeen(odd as any)).not.toThrow();
        }
      });

      it(`reads the database at most once per workspace every ${CLIENT_SEEN_EVERY_MS / 1000} seconds`, async () => {
        const { t } = await connected({ welcomed: false });
        const reads = () => t.prisma.connector.findMany.mock.calls.length;
        const before = reads();
        for (let i = 0; i < 20; i++) t.service.noteClientSeen(ME);
        await flush();
        expect(reads()).toBe(before + 1);
        // Another workspace has its own turn; this one again after the pause.
        t.service.noteClientSeen({ organizationId: 'org-2', userId: 'u9' });
        t.clock.now += CLIENT_SEEN_EVERY_MS;
        t.service.noteClientSeen(ME);
        await flush();
        expect(reads()).toBe(before + 3);
      });

      it('does nothing without a user, or while the feature is off', async () => {
        const { t } = await connected();
        const before = t.prisma.connector.findMany.mock.calls.length;
        t.service.noteClientSeen({ organizationId: 'org-1', userId: null });
        t.processEnv.TELEGRAM_MANAGER_BOT_TOKEN = undefined;
        t.service.noteClientSeen(ME);
        await flush();
        expect(t.prisma.connector.findMany.mock.calls).toHaveLength(before);
        expect(notices(t)).toHaveLength(0);
      });
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
  describe('a bot whose username the user changed', () => {
    const RENAMED = 'my_renamed_shop_bot';
    const BOT2 = 8123456790;
    const BOT3 = 8123456791;
    const tokenOf = (botId: number) => `${botId}:AAGnewBotTokenForTestsOnly0123456789ab`;
    const CREATOR_HASH = hashTelegramUserId(CREATOR_ID, SECRET);
    const OTHER_HASH = hashTelegramUserId(OTHER_ID, SECRET);
    const ME = { organizationId: 'org-1', userId: 'u1' };
    const ready = async () => {
      const t = setup();
      await t.service.register();
      const row = t.addConnector();
      const { started, code } = await t.begin(row);
      return { t, row, code, started };
    };
    /** The service message that announces a bot a second time. */
    const createdMessage = (username: string, id = BOT_ID, creatorId = CREATOR_ID, updateId = 2) => ({
      update_id: updateId,
      message: {
        message_id: 9,
        from: { id: creatorId, is_bot: false },
        chat: { id: creatorId, type: 'private' },
        managed_bot_created: { bot: { id, is_bot: true, username } },
      },
    });
    const storedEvents = (t: ReturnType<typeof setup>) => t.stored.map((e) => [e.event, e.metadata]);

    it('hands out the link that opens the manager bot with the setup code and its keyed check', async () => {
      const { code, started } = await ready();
      expect(started!.claimLink).toBe(`https://t.me/AnythingMCPBot?start=${claimParameter(code, SECRET)}`);
      expect(started!.claimLink).toMatch(/\?start=[0-9a-f]{24}$/);
    });

    describe('created first, then linked with Start in the manager bot\'s chat', () => {
      it('connects the bot its sender created, exactly like a bot found by its username', async () => {
        const { t, row, code } = await ready();
        expect(await t.service.handleUpdate(t.managedBot(RENAMED))).toBe('unmatched');
        expect(await t.service.handleUpdate(createdMessage(RENAMED))).toBe('unmatched');
        expect(t.rows[0].envVars).toBeNull();
        expect(t.callsTo('getManagedBotToken')).toHaveLength(0);
        // Kept under the creator's keyed hash: the bot's id and nothing else.
        expect([...t.site.keys()].sort()).toEqual([`telegram_unmatched_bot:${CREATOR_HASH}`, 'telegram_unmatched_bot_at']);
        expect(JSON.parse(t.site.get(`telegram_unmatched_bot:${CREATOR_HASH}`)!.value)).toEqual({ botId: BOT_ID, updateId: 2, at: T0 });

        t.clock.now = T0 + 20_000;
        expect(await t.service.handleUpdate(t.start(code))).toBe('connected');

        expect(t.callsTo('getManagedBotToken')).toEqual([
          { token: MANAGER_TOKEN, method: 'getManagedBotToken', body: { user_id: BOT_ID } },
        ]);
        // The same writer as every other token, on this connector only, with
        // the sender (who is the bot's creator) as the default chat.
        expect(t.connectors.update).toHaveBeenCalledTimes(1);
        expect(t.connectors.update.mock.calls[0][0]).toBe(row.id);
        expect(t.rows[0].envVars).toEqual({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_DEFAULT_CHAT_ID: String(CREATOR_ID) });
        expect(t.mcpServer.reloadConnectorTools).toHaveBeenCalledWith(row.id);

        expect(t.stateOf(row)).toEqual(
          expect.objectContaining({
            connectedAt: new Date(T0 + 20_000).toISOString(),
            via: 'managed_bot',
            matched: 'claim',
            // Only the bot's id was kept: its name is asked from Telegram.
            botUsername: 'my_own_bot',
            creatorHash: CREATOR_HASH,
            claimHash: CREATOR_HASH,
            claimedAt: new Date(T0 + 20_000).toISOString(),
          }),
        );
        // As stored by the real event service: nothing was dropped by its allow-list.
        expect(storedEvents(t)).toEqual([
          ['telegram_bot_unmatched', { adapterSlug: 'telegram-bot', kind: 'no_code' }],
          ['telegram_bot_connected', { adapterSlug: 'telegram-bot', connectorId: row.id, kind: 'claim' }],
          ['setup_completed', { adapterSlug: 'telegram-bot', via: 'telegram_one_tap', verified: true }],
          ['telegram_bot_claim', { adapterSlug: 'telegram-bot', connectorId: row.id, status: 'linked' }],
        ]);
        expect(t.stored.slice(1).every((e) => e.organizationId === 'org-1' && e.userId === 'u1')).toBe(true);

        // One line in the manager bot's chat, and the new bot's welcome is tried.
        expect(t.said(CREATOR_ID)).toEqual([CLAIM_LINKED_TEXT]);
        expect(t.calls.filter((c) => c.method === 'sendMessage' && c.token === BOT_TOKEN)).toEqual([
          { token: BOT_TOKEN, method: 'sendMessage', body: { chat_id: CREATOR_ID, text: WELCOME_TEXT } },
        ]);
        expect(await t.service.status(ME)).toEqual({ state: 'connected', bot: '@my_own_bot', startUrl: 'https://t.me/my_own_bot' });

        // The bot is marked as linked, the request is gone, and nothing kept
        // names the person, the code, the token or the bot.
        expect(JSON.parse(t.site.get(`telegram_unmatched_bot:${CREATOR_HASH}`)!.value).usedAt).toBe(T0 + 20_000);
        expect(t.site.has(`telegram_claim:${CREATOR_HASH}`)).toBe(false);
        const kept = JSON.stringify([...t.site]) + JSON.stringify(t.rows[0].config);
        for (const secret of [String(CREATOR_ID), code, BOT_TOKEN, RENAMED, 'ada_lovelace']) expect(kept).not.toContain(secret);
        for (const secret of [code, RENAMED, String(BOT_ID)]) expect(logged.join('\n')).not.toContain(secret);
      });

      it('greets the user after their first Start in the new bot, as on the usual path', async () => {
        const { t, row, code } = await ready();
        await t.service.handleUpdate(t.managedBot(RENAMED));
        await t.service.handleUpdate(t.start(code));
        t.answers.sendMessage = () => ({ body: { ok: true, result: { message_id: 3 } } });
        t.answers.getUpdates = () => ({
          body: { ok: true, result: [{ message: { text: '/start', from: { id: CREATOR_ID }, chat: { id: CREATOR_ID, type: 'private' } } }] },
        });
        t.clock.now += 3_000;
        expect(await t.service.status(ME)).toEqual({ state: 'connected', bot: '@my_own_bot' });
        expect(t.stateOf(row).welcomedAt).toBeDefined();
      });

      it('takes the newest of two bots, and an old update sent again does not bring the first one back', async () => {
        const { t, code } = await ready();
        await t.service.handleUpdate(t.managedBot('first_try_bot', BOT_ID, CREATOR_ID, 10));
        await t.service.handleUpdate(t.managedBot('second_try_bot', BOT2, CREATOR_ID, 20));
        // Telegram sends the first one again.
        expect(await t.service.handleUpdate(t.managedBot('first_try_bot', BOT_ID, CREATOR_ID, 10))).toBe('unmatched');

        expect(await t.service.handleUpdate(t.start(code))).toBe('connected');
        expect(t.callsTo('getManagedBotToken').map((c) => c.body)).toEqual([{ user_id: BOT2 }]);
        expect(t.rows[0].envVars!.TELEGRAM_BOT_TOKEN).toBe(tokenOf(BOT2));
        // One report per bot, however often it is announced.
        expect(t.events('telegram_bot_unmatched')).toHaveLength(2);
      });

      it('forgets a bot after the 30 minutes of a setup', async () => {
        const t = setup();
        await t.service.register();
        await t.service.handleUpdate(t.managedBot(RENAMED));
        t.clock.now = T0 + MANAGED_BOT_TTL_MS + 1;
        const { code } = await t.begin(t.addConnector());
        expect(await t.service.handleUpdate(t.start(code))).toBe('claimed');
        expect(t.callsTo('getManagedBotToken')).toHaveLength(0);
        expect(t.said(CREATOR_ID)).toEqual([CLAIM_WAITING_TEXT]);
      });

      it('asks Telegram to send the /start again when its API does not answer, and links it then', async () => {
        const { t, code } = await ready();
        await t.service.handleUpdate(t.managedBot(RENAMED));
        const update = t.start(code);
        t.answers.getManagedBotToken = () => new Error('timeout');
        expect(await t.service.handleUpdate(update)).toBe('retry');
        expect(t.said(CREATOR_ID)).toEqual([]);
        expect(t.events('telegram_bot_claim')).toHaveLength(0);

        t.answers.getManagedBotToken = () => ({ body: { ok: true, result: BOT_TOKEN } });
        expect(await t.service.handleUpdate(update)).toBe('connected');
        expect(t.said(CREATOR_ID)).toEqual([CLAIM_LINKED_TEXT]);
      });

      it('says so when Telegram hands out no token, and does not offer that bot again', async () => {
        const { t, row, code } = await ready();
        await t.service.handleUpdate(t.managedBot(RENAMED));
        t.answers.getManagedBotToken = () => ({ status: 400, body: { ok: false, description: 'Bad Request: bot is not managed' } });
        expect(await t.service.handleUpdate(t.start(code))).toBe('token_refused');
        expect(t.said(CREATOR_ID)).toEqual([CLAIM_FAILED_TEXT]);
        expect(t.rows[0].envVars).toBeNull();
        expect(t.stored[t.stored.length - 1]).toEqual({
          event: 'telegram_bot_claim',
          organizationId: 'org-1',
          userId: 'u1',
          metadata: { adapterSlug: 'telegram-bot', connectorId: row.id, status: 'refused', kind: 'token_refused' },
        });

        expect(await t.service.handleUpdate(t.start(code))).toBe('claimed');
        expect(t.callsTo('getManagedBotToken')).toHaveLength(1);
      });

      it('leaves a token that was pasted while the bot\'s token was being fetched', async () => {
        const { t, code } = await ready();
        await t.service.handleUpdate(t.managedBot(RENAMED));
        t.answers.getManagedBotToken = () => {
          t.rows[0].envVars = { TELEGRAM_BOT_TOKEN: '111:AAHpastedByTheUserInTheDashboard00000000' };
          t.rows[0].baseUrl = 'https://api.telegram.org/bot111:AAHpastedByTheUserInTheDashboard00000000';
          return { body: { ok: true, result: BOT_TOKEN } };
        };
        expect(await t.service.handleUpdate(t.start(code))).toBe('connector_has_token');
        expect(t.connectors.update).not.toHaveBeenCalled();
        expect(t.rows[0].envVars!.TELEGRAM_BOT_TOKEN).toContain('pastedByTheUser');
        expect(t.said(CREATOR_ID)).toEqual([CLAIM_ALREADY_TEXT]);
        expect(t.events('telegram_bot_connected')).toHaveLength(0);
      });
    });

    describe('Start pressed first, then the bot created', () => {
      it('remembers whose setup it is, and connects the bot that account creates, under any username', async () => {
        const { t, row, code } = await ready();
        expect(await t.service.handleUpdate(t.start(code))).toBe('claimed');
        expect(t.said(CREATOR_ID)).toEqual([CLAIM_WAITING_TEXT]);
        expect(t.callsTo('getManagedBotToken')).toHaveLength(0);
        expect(t.stateOf(row)).toEqual(expect.objectContaining({ claimHash: CREATOR_HASH, claimedAt: new Date(T0).toISOString() }));
        expect(JSON.parse(t.site.get(`telegram_claim:${CREATOR_HASH}`)!.value)).toEqual({
          connectorId: row.id,
          organizationId: 'org-1',
          expiresAt: T0 + MANAGED_BOT_TTL_MS,
        });
        // The page says so instead of "waiting".
        expect(await t.service.status(ME)).toEqual({ state: 'waiting', claimed: true });

        t.clock.now = T0 + 30_000;
        expect(await t.service.handleUpdate(t.managedBot(RENAMED))).toBe('connected');
        expect(t.rows[0].envVars).toEqual({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_DEFAULT_CHAT_ID: String(CREATOR_ID) });
        expect(t.stateOf(row)).toEqual(
          expect.objectContaining({
            connectedAt: new Date(T0 + 30_000).toISOString(),
            via: 'managed_bot',
            matched: 'claim',
            botUsername: RENAMED,
            creatorHash: CREATOR_HASH,
          }),
        );
        // Told in the chat where Start was pressed.
        expect(t.said(CREATOR_ID)).toEqual([CLAIM_WAITING_TEXT, CLAIM_LINKED_TEXT]);
        // Its second announcement finds the work done.
        expect(await t.service.handleUpdate(createdMessage(RENAMED))).toBe('already_connected');
        expect(t.connectors.update).toHaveBeenCalledTimes(1);
        expect(t.callsTo('getManagedBotToken')).toHaveLength(1);

        // Never reported as unmatched: it was connected the moment it existed.
        expect(storedEvents(t)).toEqual([
          ['telegram_bot_claim', { adapterSlug: 'telegram-bot', connectorId: row.id, status: 'waiting' }],
          ['telegram_bot_connected', { adapterSlug: 'telegram-bot', connectorId: row.id, kind: 'claim' }],
          ['setup_completed', { adapterSlug: 'telegram-bot', via: 'telegram_one_tap', verified: true }],
        ]);
        expect(t.site.has(`telegram_claim:${CREATOR_HASH}`)).toBe(false);
        expect(t.site.has('telegram_unmatched_bot_at')).toBe(false);
        expect(await t.service.status(ME)).toEqual({ state: 'connected', bot: `@${RENAMED}`, startUrl: `https://t.me/${RENAMED}` });
      });

      it('still connects a bot with the suggested username the usual way', async () => {
        const { t, row, code } = await ready();
        await t.service.handleUpdate(t.start(code));
        expect(await t.service.handleUpdate(t.managedBot(`amcp_${code}_bot`))).toBe('connected');
        expect(t.stateOf(row).matched).toBeUndefined();
        expect(t.events('telegram_bot_connected')[0].metadata).toEqual({ adapterSlug: 'telegram-bot', connectorId: row.id });
      });

      it('asks for the bot\'s update again when Telegram does not answer, and connects it then', async () => {
        const { t, code } = await ready();
        await t.service.handleUpdate(t.start(code));
        t.answers.getManagedBotToken = () => ({ status: 502, body: null });
        expect(await t.service.handleUpdate(t.managedBot(RENAMED))).toBe('retry');
        expect(t.events('telegram_bot_unmatched')).toHaveLength(0);
        t.answers.getManagedBotToken = () => ({ body: { ok: true, result: BOT_TOKEN } });
        expect(await t.service.handleUpdate(t.managedBot(RENAMED))).toBe('connected');
      });

      it('no longer waits once the setup has expired', async () => {
        const { t, code } = await ready();
        await t.service.handleUpdate(t.start(code));
        t.clock.now = T0 + MANAGED_BOT_TTL_MS + 1;
        expect(await t.service.handleUpdate(t.managedBot(RENAMED))).toBe('unmatched');
        expect(t.rows[0].envVars).toBeNull();
        expect(t.callsTo('getManagedBotToken')).toHaveLength(0);
      });

      it('leaves a connector that got a token in the meantime', async () => {
        const { t, code } = await ready();
        await t.service.handleUpdate(t.start(code));
        t.rows[0].envVars = { TELEGRAM_BOT_TOKEN: '111:AAHpastedByTheUserInTheDashboard00000000' };
        t.rows[0].baseUrl = 'https://api.telegram.org/bot111:AAHpastedByTheUserInTheDashboard00000000';
        expect(await t.service.handleUpdate(t.managedBot(RENAMED))).toBe('unmatched');
        expect(t.callsTo('getManagedBotToken')).toHaveLength(0);
        expect(t.connectors.update).not.toHaveBeenCalled();
        // The stale request is dropped.
        expect(t.site.has(`telegram_claim:${CREATOR_HASH}`)).toBe(false);
      });
    });

    describe('never a bot somebody else created', () => {
      it('does not connect another account\'s bot to the sender of the code', async () => {
        const { t, code } = await ready();
        // Somebody else created a bot through this manager; the user sends the code.
        await t.service.handleUpdate(t.managedBot('a_strangers_bot', BOT2, OTHER_ID, 5));
        expect(await t.service.handleUpdate(t.start(code))).toBe('claimed');
        expect(t.callsTo('getManagedBotToken')).toHaveLength(0);
        // A second bot of the stranger changes nothing either.
        expect(await t.service.handleUpdate(t.managedBot('another_strangers_bot', BOT3, OTHER_ID, 6))).toBe('unmatched');
        expect(t.rows[0].envVars).toBeNull();
        expect(t.callsTo('getManagedBotToken')).toHaveLength(0);

        // The user's own bot is the one that gets connected.
        expect(await t.service.handleUpdate(t.managedBot(RENAMED, BOT_ID, CREATOR_ID, 7))).toBe('connected');
        expect(t.rows[0].envVars).toEqual({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_DEFAULT_CHAT_ID: String(CREATOR_ID) });
      });

      it('gives a setup to the first account that sends its code: a second person is refused', async () => {
        const { t, row, code } = await ready();
        // The second person even has a bot waiting.
        await t.service.handleUpdate(t.managedBot('a_strangers_bot', BOT2, OTHER_ID, 5));
        expect(await t.service.handleUpdate(t.start(code))).toBe('claimed');

        expect(await t.service.handleUpdate(t.start(code, OTHER_ID))).toBe('refused');
        expect(t.said(OTHER_ID)).toEqual([CLAIM_INVALID_TEXT]);
        expect(t.stateOf(row).claimHash).toBe(CREATOR_HASH);
        expect(t.callsTo('getManagedBotToken')).toHaveLength(0);
        expect(t.rows[0].envVars).toBeNull();
        expect(t.stored[t.stored.length - 1]).toEqual({
          event: 'telegram_bot_claim',
          organizationId: 'org-1',
          userId: 'u1',
          metadata: { adapterSlug: 'telegram-bot', connectorId: row.id, status: 'refused', kind: 'other_user' },
        });
        // Nor does the stranger's request stay behind for a later bot of theirs.
        expect(t.site.has(`telegram_claim:${OTHER_HASH}`)).toBe(false);
        expect(await t.service.handleUpdate(t.managedBot('third_bot', BOT3, OTHER_ID, 8))).toBe('unmatched');
        expect(t.rows[0].envVars).toBeNull();
      });

      it('refuses the second of two accounts whose codes arrive at the same moment', async () => {
        const { t, row, code } = await ready();
        // The other account's /start is written between this one's read and write.
        const unclaimed = { ...t.rows[0], config: JSON.parse(JSON.stringify(t.rows[0].config)) };
        t.rows[0].config![MANAGED_BOT_CONFIG_KEY].claimHash = OTHER_HASH;
        t.rows[0].config![MANAGED_BOT_CONFIG_KEY].claimedAt = new Date(T0).toISOString();
        t.prisma.connector.findFirst.mockResolvedValueOnce(unclaimed);

        expect(await t.service.handleUpdate(t.start(code))).toBe('refused');
        expect(t.stateOf(row).claimHash).toBe(OTHER_HASH);
        expect(t.site.has(`telegram_claim:${CREATOR_HASH}`)).toBe(false);
      });

      it('does not trust a request row that the connector does not confirm', async () => {
        const { t, row } = await ready();
        // A row that names this connector for an account that never sent its code.
        await t.claims.rememberClaim(CREATOR_HASH, { connectorId: row.id, organizationId: 'org-1', expiresAt: T0 + MANAGED_BOT_TTL_MS }, T0);
        expect(await t.service.handleUpdate(t.managedBot(RENAMED))).toBe('unmatched');
        expect(t.rows[0].envVars).toBeNull();
        expect(t.callsTo('getManagedBotToken')).toHaveLength(0);
        // Nor one that names another workspace than the connector's.
        t.rows[0].config![MANAGED_BOT_CONFIG_KEY].claimHash = CREATOR_HASH;
        await t.claims.rememberClaim(CREATOR_HASH, { connectorId: row.id, organizationId: 'org-2', expiresAt: T0 + MANAGED_BOT_TTL_MS }, T0);
        expect(await t.service.handleUpdate(t.managedBot('one_more_bot', BOT2, CREATOR_ID, 9))).toBe('unmatched');
        expect(t.rows[0].envVars).toBeNull();
      });
    });

    describe('a code that cannot be used', () => {
      it('refuses a code nobody is waiting for, with one neutral line', async () => {
        const { t } = await ready();
        expect(await t.service.handleUpdate(t.start('0badc0de'))).toBe('refused');
        expect(t.said(CREATOR_ID)).toEqual([CLAIM_INVALID_TEXT]);
        expect(t.stored).toEqual([
          { event: 'telegram_bot_claim', organizationId: null, userId: null, metadata: { adapterSlug: 'telegram-bot', status: 'refused', kind: 'unknown_code' } },
        ]);
        expect(t.site.size).toBe(0);
        expect(t.executeRaw).toHaveBeenCalledTimes(1); // the setup's own start, nothing since
      });

      it('refuses a parameter that is not a setup code without looking anything up', async () => {
        const { t } = await ready();
        const lookups = t.prisma.connector.findFirst.mock.calls.length;
        for (const parameter of ['hello', '1a2b3c4', '1a2b3c4d5', "x' OR 1=1"]) {
          expect(await t.service.handleUpdate(t.start(parameter))).toBe(parameter.includes(' ') ? 'ignored' : 'refused');
        }
        expect(t.prisma.connector.findFirst.mock.calls).toHaveLength(lookups);
        expect(t.site.size).toBe(0);
      });

      it('refuses a code this server did not sign: a pending setup cannot be guessed', async () => {
        const { t, row, code } = await ready();
        const lookups = t.prisma.connector.findFirst.mock.calls.length;
        const send = (parameter: string, from: number) => {
          const update = t.start(undefined, from);
          update.message.text = `/start ${parameter}`;
          return t.service.handleUpdate(update);
        };
        const real = claimParameter(code, SECRET);
        // The bare code of a setup that is waiting, as it stands in the bot's suggested username.
        expect(await send(code, OTHER_ID)).toBe('refused');
        // The right code with a check that is wrong, or keyed with another secret.
        expect(await send(`${code}${'0'.repeat(16)}`, OTHER_ID)).toBe('refused');
        expect(await send(claimParameter(code, 'another-webhook-secret-9876543210'), OTHER_ID)).toBe('refused');
        expect(await send(`${real.slice(0, 23)}${real.endsWith('0') ? '1' : '0'}`, OTHER_ID)).toBe('refused');

        expect(t.said(OTHER_ID)).toEqual([CLAIM_INVALID_TEXT, CLAIM_INVALID_TEXT, CLAIM_INVALID_TEXT, CLAIM_INVALID_TEXT]);
        expect(t.stored.map((e) => e.metadata)).toEqual(
          Array(4).fill({ adapterSlug: 'telegram-bot', status: 'refused', kind: 'unknown_code' }),
        );
        // Nothing was looked up, and the setup is nobody's yet.
        expect(t.prisma.connector.findFirst.mock.calls).toHaveLength(lookups);
        expect(t.stateOf(row).claimHash).toBeUndefined();
        // The link the page really gave still works, in whatever case it arrives.
        expect(await send(real.toUpperCase(), CREATOR_ID)).toBe('claimed');
      });

      it('refuses a code after its 30 minutes, and accepts it one second before', async () => {
        const { t, row, code } = await ready();
        t.clock.now = T0 + MANAGED_BOT_TTL_MS + 1;
        expect(await t.service.handleUpdate(t.start(code))).toBe('refused');
        expect(t.said(CREATOR_ID)).toEqual([CLAIM_INVALID_TEXT]);
        expect(t.stored[0].metadata).toEqual({ adapterSlug: 'telegram-bot', connectorId: row.id, status: 'refused', kind: 'expired' });
        expect(t.stateOf(row).claimHash).toBeUndefined();

        t.clock.now = T0 + MANAGED_BOT_TTL_MS - 1_000;
        expect(await t.service.handleUpdate(t.start(code))).toBe('claimed');
      });

      it('tells only the account that connected a setup that it is connected', async () => {
        const { t, row, code } = await ready();
        await t.service.handleUpdate(t.managedBot(`amcp_${code}_bot`));
        const writes = t.connectors.update.mock.calls.length;

        expect(await t.service.handleUpdate(t.start(code))).toBe('refused');
        expect(t.said(CREATOR_ID)).toEqual([CLAIM_ALREADY_TEXT]);
        expect(await t.service.handleUpdate(t.start(code, OTHER_ID))).toBe('refused');
        expect(t.said(OTHER_ID)).toEqual([CLAIM_INVALID_TEXT]);

        expect(t.connectors.update.mock.calls).toHaveLength(writes);
        expect(t.callsTo('getManagedBotToken')).toHaveLength(1);
        expect(t.stored[t.stored.length - 1].metadata).toEqual({
          adapterSlug: 'telegram-bot',
          connectorId: row.id,
          status: 'refused',
          kind: 'already_connected',
        });
      });

      it('refuses a code whose connector got a token in the meantime, even with a bot waiting', async () => {
        const { t, row, code } = await ready();
        await t.service.handleUpdate(t.managedBot(RENAMED));
        t.rows[0].envVars = { TELEGRAM_BOT_TOKEN: '111:AAHpastedByTheUserInTheDashboard00000000' };
        t.rows[0].baseUrl = 'https://api.telegram.org/bot111:AAHpastedByTheUserInTheDashboard00000000';

        expect(await t.service.handleUpdate(t.start(code))).toBe('refused');
        expect(t.callsTo('getManagedBotToken')).toHaveLength(0);
        expect(t.connectors.update).not.toHaveBeenCalled();
        expect(t.rows[0].envVars!.TELEGRAM_BOT_TOKEN).toContain('pastedByTheUser');
        expect(t.stored[t.stored.length - 1].metadata).toEqual({
          adapterSlug: 'telegram-bot',
          connectorId: row.id,
          status: 'refused',
          kind: 'connector_has_token',
        });
      });
    });

    describe('updates Telegram sends again', () => {
      it('answers a /start once', async () => {
        const { t, code } = await ready();
        await t.service.handleUpdate(t.managedBot(RENAMED));
        const update = t.start(code);
        expect(await t.service.handleUpdate(update)).toBe('connected');
        expect(await t.service.handleUpdate(update)).toBe('ignored');
        expect(t.said(CREATOR_ID)).toEqual([CLAIM_LINKED_TEXT]);
        expect(t.events('telegram_bot_claim')).toHaveLength(1);
        expect(t.connectors.update).toHaveBeenCalledTimes(1);
      });

      it('says "already connected" to a second tap on the link, and writes nothing', async () => {
        const { t, code } = await ready();
        await t.service.handleUpdate(t.managedBot(RENAMED));
        await t.service.handleUpdate(t.start(code));
        expect(await t.service.handleUpdate(t.start(code))).toBe('refused');
        expect(t.said(CREATOR_ID)).toEqual([CLAIM_LINKED_TEXT, CLAIM_ALREADY_TEXT]);
        expect(t.connectors.update).toHaveBeenCalledTimes(1);
        expect(t.callsTo('getManagedBotToken')).toHaveLength(1);
      });

      it('does not take a linked bot for a new one, here or for another setup', async () => {
        const { t, code } = await ready();
        await t.service.handleUpdate(t.managedBot(RENAMED));
        await t.service.handleUpdate(t.start(code));
        const reported = t.events('telegram_bot_unmatched').length;

        // The bot's update again, and a later change of its token.
        expect(await t.service.handleUpdate(t.managedBot(RENAMED))).toBe('already_connected');
        expect(await t.service.handleUpdate(t.managedBot(RENAMED, BOT_ID, CREATOR_ID, 50))).toBe('already_connected');
        expect(t.events('telegram_bot_unmatched')).toHaveLength(reported);

        // The same person sets up another workspace: that bot is not offered again.
        const second = t.addConnector({ organizationId: 'org-2' });
        const next = await t.begin(second, 'u1');
        expect(await t.service.handleUpdate(t.start(next.code))).toBe('claimed');
        expect(t.rows[1].envVars).toBeNull();
        expect(t.callsTo('getManagedBotToken')).toHaveLength(1);
      });
    });

    describe('what anyone can send the manager bot', () => {
      it('answers a plain /start with one neutral line, and looks nothing up', async () => {
        const { t } = await ready();
        const lookups = t.prisma.connector.findFirst.mock.calls.length;
        expect(await t.service.handleUpdate(t.start(undefined, OTHER_ID))).toBe('greeted');
        expect(t.said(OTHER_ID)).toEqual([MANAGER_GREETING_TEXT]);
        expect(t.callsTo('sendMessage')).toHaveLength(1);
        expect(t.prisma.connector.findFirst.mock.calls).toHaveLength(lookups);
        expect(t.site.size).toBe(0);
        expect(t.stored).toEqual([]);
      });

      it('ignores a /start that is not a person in their own chat with the bot', async () => {
        const { t, code } = await ready();
        const inGroup = t.start(code);
        inGroup.message.chat = { ...inGroup.message.chat, id: -1001234, type: 'group' };
        const elsewhere = t.start(code);
        elsewhere.message.chat = { ...elsewhere.message.chat, id: OTHER_ID };
        const fromBot = t.start(code);
        fromBot.message.from = { ...fromBot.message.from, is_bot: true };
        const noSender = t.start(code) as { message: { from?: unknown } };
        delete noSender.message.from;
        for (const update of [inGroup, elsewhere, fromBot, noSender]) {
          expect(await t.service.handleUpdate(update)).toBe('ignored');
        }
        expect(t.callsTo('sendMessage')).toHaveLength(0);
        expect(t.stored).toEqual([]);
      });

      it(`acts on ${START_MAX_PER_SENDER} messages a minute from one account: the rest get no lookup and no answer`, async () => {
        const { t, row, code } = await ready();
        for (let i = 0; i < START_MAX_PER_SENDER; i++) {
          expect(await t.service.handleUpdate(t.start('0badc0de'))).toBe('refused');
        }
        const lookups = t.prisma.connector.findFirst.mock.calls.length;
        const lines = t.callsTo('sendMessage').length;
        const events = t.stored.length;

        expect(await t.service.handleUpdate(t.start(code))).toBe('limited');
        expect(await t.service.handleUpdate(t.start())).toBe('limited');
        expect(t.prisma.connector.findFirst.mock.calls).toHaveLength(lookups);
        expect(t.callsTo('sendMessage')).toHaveLength(lines);
        expect(t.stored).toHaveLength(events);
        expect(t.stateOf(row).claimHash).toBeUndefined();
        // Somebody else is not held back by it.
        expect(await t.service.handleUpdate(t.start(undefined, OTHER_ID))).toBe('greeted');

        t.clock.now += 60_000;
        expect(await t.service.handleUpdate(t.start(code))).toBe('claimed');
      });

      it(`acts on ${START_MAX_PER_MINUTE} messages a minute in all`, async () => {
        const { t, code } = await ready();
        for (let i = 0; i < START_MAX_PER_MINUTE; i++) {
          expect(await t.service.handleUpdate(t.start(undefined, 900_000 + i))).toBe('greeted');
        }
        expect(await t.service.handleUpdate(t.start(code))).toBe('limited');
        expect(await t.service.handleUpdate(t.start(undefined, 990_000))).toBe('limited');
        expect(t.callsTo('sendMessage')).toHaveLength(START_MAX_PER_MINUTE);
        expect(logged.filter((line) => line.includes('Too many /start'))).toHaveLength(1);
        // A new bot is still taken: only /start is limited here.
        expect(await t.service.handleUpdate(t.managedBot(`amcp_${code}_bot`))).toBe('connected');

        t.clock.now += 60_000;
        expect(await t.service.handleUpdate(t.start(undefined, 990_000))).toBe('greeted');
      });
    });

    describe('the webhook secret', () => {
      const ROTATED = 'another-webhook-secret-9876543210';

      it('keys everything that is remembered, so a new secret drops a pending request', async () => {
        const { t, code } = await ready();
        await t.service.handleUpdate(t.start(code));
        t.processEnv.TELEGRAM_MANAGER_WEBHOOK_SECRET = ROTATED;

        expect(await t.service.handleUpdate(t.managedBot(RENAMED))).toBe('unmatched');
        expect(t.rows[0].envVars).toBeNull();
        expect(t.callsTo('getManagedBotToken')).toHaveLength(0);
        expect([...t.site.keys()]).toContain(`telegram_unmatched_bot:${hashTelegramUserId(CREATOR_ID, ROTATED)}`);
      });

      it('and a remembered bot, and the code itself', async () => {
        const { t, code } = await ready();
        await t.service.handleUpdate(t.managedBot(RENAMED));
        t.processEnv.TELEGRAM_MANAGER_WEBHOOK_SECRET = ROTATED;

        expect(await t.service.handleUpdate(t.start(code))).toBe('refused');
        expect(t.rows[0].envVars).toBeNull();
        expect(t.callsTo('getManagedBotToken')).toHaveLength(0);
        // A setup started under the new secret does not find the old bot either.
        const next = await t.begin(t.addConnector(), 'u2');
        expect(await t.service.handleUpdate(t.start(next.code, CREATOR_ID, undefined, ROTATED))).toBe('claimed');
        expect(t.callsTo('getManagedBotToken')).toHaveLength(0);
      });
    });

    describe('what the page is told', () => {
      it('hints at a bot with another username created since the setup began, and only then', async () => {
        const t = setup();
        await t.service.register();
        // A bot created before this setup existed is not this user's.
        await t.service.handleUpdate(t.managedBot('an_earlier_bot', BOT2, OTHER_ID, 3));
        t.clock.now = T0 + 5_000;
        await t.begin(t.addConnector());
        expect(await t.service.status(ME)).toEqual({ state: 'waiting' });

        t.clock.now = T0 + 9_000;
        await t.service.handleUpdate(t.managedBot(RENAMED));
        expect(await t.service.status(ME)).toEqual({ state: 'waiting', unmatched: true });

        // Not for ever: the bot is forgotten after 30 minutes anyway.
        t.clock.now = T0 + 9_000 + MANAGED_BOT_TTL_MS;
        expect(await t.service.status(ME)).toEqual({ state: 'expired' });
      });

      it('counts from the click on the link when there was one', async () => {
        const { t } = await ready();
        t.clock.now = T0 + 10_000;
        await t.service.handleUpdate(t.managedBot('an_earlier_bot', BOT2, OTHER_ID, 3));
        t.clock.now = T0 + 20_000;
        expect(await t.service.status({ ...ME, opened: true })).toEqual({ state: 'waiting' });
      });

      it('gives no hint for a bot that was connected the moment it existed', async () => {
        const { t, code } = await ready();
        await t.begin(t.addConnector({ organizationId: 'org-2' }), 'u2');
        await t.service.handleUpdate(t.start(code));
        await t.service.handleUpdate(t.managedBot(RENAMED));
        expect(await t.service.status({ organizationId: 'org-2', userId: 'u2' })).toEqual({ state: 'waiting' });
      });

      it('records once that "Link your bot" was shown, and why', async () => {
        const { t } = await ready();
        await t.service.status({ ...ME, claimOffered: true, device: 'mobile' });
        await t.service.status({ ...ME, claimOffered: true, device: 'mobile' });
        expect(t.stored).toEqual([
          {
            event: 'telegram_bot_claim_offered',
            organizationId: 'org-1',
            userId: 'u1',
            metadata: { adapterSlug: 'telegram-bot', kind: 'timeout', device: 'mobile' },
          },
        ]);

        const second = t.addConnector({ organizationId: 'org-2' });
        await t.begin(second, 'u2');
        await t.service.handleUpdate(t.managedBot(RENAMED));
        await t.service.status({ organizationId: 'org-2', userId: 'u2', claimOffered: true, device: 'desktop' });
        expect(t.stored[t.stored.length - 1].metadata).toEqual({ adapterSlug: 'telegram-bot', kind: 'unmatched_bot', device: 'desktop' });
      });

      it('still answers when the hint cannot be read', async () => {
        const { t } = await ready();
        t.siteSettings.findUnique.mockRejectedValue(new Error('database down'));
        expect(await t.service.status(ME)).toEqual({ state: 'waiting' });
      });
    });

    describe('what is remembered in between (site_settings)', () => {
      it('loses nothing else when a row cannot be written: the bot is reported as before', async () => {
        const { t } = await ready();
        t.siteSettings.upsert.mockRejectedValue(new Error(`duplicate key ${CREATOR_HASH}`));
        expect(await t.service.handleUpdate(t.managedBot(RENAMED))).toBe('unmatched');
        expect(t.events('telegram_bot_unmatched')).toHaveLength(1);
        // A name only in the log: an error's message could quote a key.
        expect(logged.join('\n')).not.toContain(CREATOR_HASH);
        expect(logged.join('\n')).toContain('Could not remember a bot');
      });

      it('deletes rows past their time on a later write, and no other setting', async () => {
        const t = setup();
        await t.claims.rememberBot(CREATOR_HASH, { botId: BOT_ID, updateId: 1 }, T0);
        await t.claims.rememberClaim(CREATOR_HASH, { connectorId: 'c1', organizationId: 'org-1', expiresAt: T0 + MANAGED_BOT_TTL_MS }, T0);
        t.site.set('license_key', { value: 'AMCP-TEST', updatedAt: new Date(0) });

        t.clock.now = T0 + 2 * MANAGED_BOT_TTL_MS + 11 * 60_000;
        await t.claims.rememberBot(OTHER_HASH, { botId: BOT2, updateId: 2 }, t.clock.now);
        expect([...t.site.keys()].sort()).toEqual(['license_key', `telegram_unmatched_bot:${OTHER_HASH}`]);
      });

      it('reads a row that is not its own format, or a key that is no hash, as nothing', async () => {
        const t = setup();
        t.site.set(`telegram_unmatched_bot:${CREATOR_HASH}`, { value: 'not json', updatedAt: new Date(T0) });
        t.site.set(`telegram_claim:${CREATOR_HASH}`, { value: '{"connectorId":7}', updatedAt: new Date(T0) });
        expect(await t.claims.botOf(CREATOR_HASH, T0)).toBeNull();
        expect(await t.claims.claimOf(CREATOR_HASH, T0)).toBeNull();
        expect(await t.claims.rememberBot('555001', { botId: BOT_ID, updateId: 1 }, T0)).toBe('failed');
        expect(await t.claims.botOf('555001', T0)).toBeNull();
        expect(t.siteSettings.upsert).not.toHaveBeenCalled();
      });
    });
  });
});
