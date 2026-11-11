import {
  AUTO_SETUP_TAG,
  DeskMessage,
  SupportTelegramSetupService,
  findTelegramTokenNearMisses,
  findTelegramTokens,
} from './support-telegram-setup.service';

// Built at run time, so the source holds nothing a secret scanner reads as a
// Telegram token. Not a real bot: the secret part is a fixed filler.
const fakeToken = (botId: string, filler: string) => `${botId}:${'AA' + filler.repeat(33)}`;
const TOKEN = fakeToken('7712345678', 'x');
const OTHER_TOKEN = fakeToken('1234567', 'y');
const HOST = 'cloud.anythingmcp.com';
const USER_ID = 'user-1';
const TEMPLATE_URL = 'https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}';
const emptyConnector = (id: string) => ({ id, baseUrl: TEMPLATE_URL, envVars: null });
const setConnector = (id: string) => ({ id, baseUrl: TEMPLATE_URL, envVars: { TELEGRAM_BOT_TOKEN: OTHER_TOKEN } });
const ORG_ID = 'org-1';

class TestService extends SupportTelegramSetupService {
  desk: any;
  telegram: jest.Mock;
  constructor(deps: any, desk: any, telegram: jest.Mock) {
    super(
      deps.prisma,
      deps.adapters,
      deps.licenseGuard,
      deps.mcpServers,
      deps.email,
      deps.securityEvents,
      deps.productEvents,
      deps.connectors,
      deps.mcpServer,
    );
    this.desk = desk;
    this.telegram = telegram;
  }
  protected client() {
    return this.desk;
  }
  protected host() {
    return HOST;
  }
  protected dashboardBase() {
    return 'https://cloud.anythingmcp.com';
  }
  protected fetchImpl() {
    return this.telegram as unknown as typeof fetch;
  }
}

function message(over: Partial<DeskMessage> = {}): DeskMessage {
  return {
    uuid: `m-${Math.random()}`,
    type: 'incoming',
    private: false,
    sender_id: 42,
    sender_type: 'contact',
    conversation_uuid: 'conv-1',
    text_content: `Here is my bot token: ${TOKEN}`,
    ...over,
  };
}

function setup(opts: {
  conversation?: any;
  user?: any;
  /** The workspace's Telegram connectors; a list per call when it changes between reads. */
  existing?: any[];
  existingLater?: any[];
  telegramStatus?: number;
  telegramBody?: any;
  licenceError?: Error;
} = {}) {
  const conversation =
    opts.conversation === undefined
      ? {
          uuid: 'conv-1',
          inbox_channel: 'livechat',
          tags: [],
          contact: { id: 42, type: 'contact', external_user_id: `${HOST}:${USER_ID}` },
        }
      : opts.conversation;
  const user =
    opts.user === undefined
      ? {
          id: USER_ID,
          email: 'ana@example.com',
          name: 'Ana',
          emailVerified: true,
          memberships: [{ organizationId: ORG_ID, role: 'EDITOR', organization: { name: 'Acme' } }],
        }
      : opts.user;
  const desk = {
    conversation: jest.fn().mockResolvedValue(conversation),
    reply: jest.fn().mockResolvedValue({}),
    addTags: jest.fn().mockResolvedValue({}),
  };
  const deps = {
    prisma: {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      connector: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(opts.existing ?? [])
          .mockResolvedValue(opts.existingLater ?? opts.existing ?? []),
      },
      organizationMember: {
        findMany: jest.fn().mockResolvedValue([
          { user: { email: 'boss@example.com', name: 'Boss' } },
          { user: { email: 'ANA@example.com', name: 'Ana' } },
        ]),
      },
    },
    adapters: {
      getBySlug: jest.fn().mockReturnValue({
        name: 'Telegram Bot',
        verifyHints: { '401': 'Telegram refused the bot token.', '404': 'Bad token format.' },
      }),
      importAdapter: jest.fn().mockResolvedValue({ connectorId: 'conn-1', toolsCreated: 30, probe: null }),
    },
    licenseGuard: {
      checkCanCreateConnector: opts.licenceError
        ? jest.fn().mockRejectedValue(opts.licenceError)
        : jest.fn().mockResolvedValue(undefined),
    },
    mcpServers: { attachToDefaultServer: jest.fn().mockResolvedValue({ id: 's1', name: 'Default' }) },
    email: { sendConnectorAddedFromSupportEmail: jest.fn().mockResolvedValue(true) },
    securityEvents: { log: jest.fn().mockResolvedValue(undefined) },
    productEvents: { log: jest.fn().mockResolvedValue(undefined) },
    connectors: { update: jest.fn().mockResolvedValue({}) },
    mcpServer: { reloadConnectorTools: jest.fn().mockResolvedValue(undefined) },
  };
  const status = opts.telegramStatus ?? 200;
  const body = opts.telegramBody ?? { ok: true, result: { id: 7712345678, is_bot: true, username: 'acme_bot' } };
  const telegram = jest.fn().mockResolvedValue({ status, ok: status < 400, json: async () => body });
  const service = new TestService(deps, desk, telegram);
  return { service, desk, deps, telegram };
}

const replies = (desk: any) => desk.reply.mock.calls.map((c: any[]) => String(c[1])).join('\n');

describe('findTelegramTokens', () => {
  it('finds a bot token in text and ignores look-alikes', () => {
    expect(findTelegramTokens(`token ${TOKEN}.`)).toEqual([TOKEN]);
    expect(findTelegramTokens(`${TOKEN} and again ${TOKEN}`)).toEqual([TOKEN]);
    expect(findTelegramTokens('at 10:30 we met')).toEqual([]);
    expect(findTelegramTokens(`x${TOKEN}`)).toEqual([]);
    expect(findTelegramTokens(`${TOKEN}EXTRA_CHARS_THAT_MAKE_IT_TOO_LONG_FOR_A_TOKEN_1234567890`)).toEqual([]);
    expect(findTelegramTokens(`<p>${TOKEN}</p>`)).toEqual([TOKEN]);
    expect(findTelegramTokens(null)).toEqual([]);
  });
});

// Telegram's guide example (26 characters after the colon), and a real
// token cut short. Neither matches the token pattern.
const EXAMPLE = ['123456789', 'ABCDefGhIJklmNoPQRstUVwxyZ'].join(':');
const CUT_SHORT = TOKEN.slice(0, -10);

describe('findTelegramTokenNearMisses', () => {
  it('finds token-shaped strings that are not tokens and leaves real tokens and ordinary text alone', () => {
    expect(findTelegramTokenNearMisses(`my token ${EXAMPLE}`)).toEqual([EXAMPLE]);
    expect(findTelegramTokenNearMisses(CUT_SHORT)).toEqual([CUT_SHORT]);
    expect(findTelegramTokenNearMisses(`${TOKEN}EXTRA_CHARS_THAT_MAKE_IT_TOO_LONG_FOR_A_TOKEN_1234567890`)).toHaveLength(1);
    expect(findTelegramTokenNearMisses(TOKEN)).toEqual([]);
    expect(findTelegramTokenNearMisses('order 1234567:shipped_to_customer_today')).toEqual([]);
    expect(findTelegramTokenNearMisses('ref 1234567:12345678901234567890123')).toEqual([]);
    expect(findTelegramTokenNearMisses('at 10:30 we met')).toEqual([]);
    expect(findTelegramTokenNearMisses('<'.repeat(50_000))).toEqual([]);
    expect(findTelegramTokenNearMisses(null)).toEqual([]);
  });
});

describe('SupportTelegramSetupService', () => {
  it("says once that Telegram's example token is not a bot, and how to get one", async () => {
    const { service, desk, deps, telegram } = setup();
    await expect(service.handleMessage(message({ text_content: EXAMPLE }))).resolves.toBe('not_a_token');
    expect(telegram).not.toHaveBeenCalled();
    expect(deps.adapters.importAdapter).not.toHaveBeenCalled();
    const text = replies(desk);
    expect(text).toContain("example token from Telegram's guides");
    expect(text).toContain('@BotFather');
    expect(text).toContain('/newbot');
    expect(text).toContain('https://cloud.anythingmcp.com/connectors/setup/telegram-bot');
    expect(text).not.toContain(EXAMPLE);

    // Once per conversation: a second paste stays quiet.
    await expect(service.handleMessage(message({ text_content: EXAMPLE }))).resolves.toBe('ignored');
    expect(desk.reply).toHaveBeenCalledTimes(1);
  });

  it('says that a token cut short is not valid', async () => {
    const { service, desk, telegram } = setup();
    await expect(service.handleMessage(message({ text_content: `token: ${CUT_SHORT}` }))).resolves.toBe('not_a_token');
    expect(telegram).not.toHaveBeenCalled();
    expect(replies(desk)).toContain('not a valid Telegram bot token');
    expect(replies(desk)).not.toContain(CUT_SHORT);
  });

  it.each([
    ['a visitor', { inbox_channel: 'livechat', contact: { id: 42, type: 'visitor', external_user_id: null } }],
    ['another contact than the sender', { inbox_channel: 'livechat', contact: { id: 99, type: 'contact', external_user_id: `${HOST}:${USER_ID}` } }],
    ['another channel', { inbox_channel: 'email', contact: { id: 42, type: 'contact', external_user_id: `${HOST}:${USER_ID}` } }],
  ])('keeps quiet about a near-miss token from %s', async (_label, conversation) => {
    const { service, desk } = setup({ conversation });
    await expect(service.handleMessage(message({ text_content: EXAMPLE }))).resolves.toBe('ignored');
    expect(desk.reply).not.toHaveBeenCalled();
  });

  it('keeps quiet about a near-miss token from an unknown user', async () => {
    const { service, desk } = setup({ user: null });
    await expect(service.handleMessage(message({ text_content: EXAMPLE }))).resolves.toBe('ignored');
    expect(desk.reply).not.toHaveBeenCalled();
  });

  it('still installs a real token after a near-miss in the same conversation', async () => {
    const { service, deps } = setup();
    await expect(service.handleMessage(message({ text_content: EXAMPLE }))).resolves.toBe('not_a_token');
    await expect(service.handleMessage(message())).resolves.toBe('installed');
    expect(deps.adapters.importAdapter).toHaveBeenCalledTimes(1);
  });

  it('installs the connector for the verified single-workspace editor and tells everyone', async () => {
    const { service, desk, deps, telegram } = setup();
    await expect(service.handleMessage(message())).resolves.toBe('installed');

    expect(telegram).toHaveBeenCalledWith(`https://api.telegram.org/bot${TOKEN}/getMe`, expect.anything());
    expect(deps.licenseGuard.checkCanCreateConnector).toHaveBeenCalledWith(USER_ID, ORG_ID);
    expect(deps.adapters.importAdapter).toHaveBeenCalledWith('telegram-bot', USER_ID, ORG_ID, {
      TELEGRAM_BOT_TOKEN: TOKEN,
    });
    expect(deps.mcpServers.attachToDefaultServer).toHaveBeenCalledWith(USER_ID, ORG_ID, 'conn-1');
    expect(deps.securityEvents.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'CONNECTOR_INSTALLED_VIA_SUPPORT_CHAT',
        actorUserId: USER_ID,
        organizationId: ORG_ID,
        metadata: expect.objectContaining({ connectorId: 'conn-1', bot: '@acme_bot', conversation: 'conv-1' }),
      }),
    );
    expect(desk.addTags).toHaveBeenCalledWith('conv-1', [AUTO_SETUP_TAG]);
    expect(replies(desk)).toContain('@acme_bot');
    expect(replies(desk)).toContain('/connectors/conn-1');
    // The token never goes back into the chat or into the event.
    expect(replies(desk)).not.toContain(TOKEN);
    expect(JSON.stringify(deps.securityEvents.log.mock.calls)).not.toContain(TOKEN);

    // The poster once (case-insensitive dedupe) and the admin.
    const to = deps.email.sendConnectorAddedFromSupportEmail.mock.calls.map((c: any[]) => c[0]).sort();
    expect(to).toEqual(['ana@example.com', 'boss@example.com']);
  });

  it.each([
    ['an agent message', { sender_type: 'agent' }],
    ['a private note', { private: true }],
    ['an outgoing message', { type: 'outgoing' }],
    ['a message without a token', { text_content: 'hello' }],
    ['many angle brackets and no token', { text_content: '', content: '<'.repeat(50_000) }],
    ['two different tokens', { text_content: `${TOKEN} ${OTHER_TOKEN}` }],
  ])('ignores %s without calling the desk', async (_label, over) => {
    const { service, desk, deps } = setup();
    await expect(service.handleMessage(message(over as any))).resolves.toBe('ignored');
    expect(desk.conversation).not.toHaveBeenCalled();
    expect(deps.adapters.importAdapter).not.toHaveBeenCalled();
  });

  it.each([
    ['a visitor', { inbox_channel: 'livechat', contact: { id: 42, type: 'visitor', external_user_id: null } }],
    ['another contact than the sender', { inbox_channel: 'livechat', contact: { id: 99, type: 'contact', external_user_id: `${HOST}:${USER_ID}` } }],
    ['an identity of another instance', { inbox_channel: 'livechat', contact: { id: 42, type: 'contact', external_user_id: `evil.example:${USER_ID}` } }],
    ['a contact without identity', { inbox_channel: 'livechat', contact: { id: 42, type: 'contact', external_user_id: null } }],
    ['another channel', { inbox_channel: 'email', contact: { id: 42, type: 'contact', external_user_id: `${HOST}:${USER_ID}` } }],
    ['a conversation that already installed one', { inbox_channel: 'livechat', tags: [AUTO_SETUP_TAG], contact: { id: 42, type: 'contact', external_user_id: `${HOST}:${USER_ID}` } }],
  ])('does nothing and says nothing for %s', async (_label, conversation) => {
    const { service, desk, deps, telegram } = setup({ conversation });
    await expect(service.handleMessage(message())).resolves.toBe('ignored');
    expect(deps.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(telegram).not.toHaveBeenCalled();
    expect(desk.reply).not.toHaveBeenCalled();
    expect(deps.adapters.importAdapter).not.toHaveBeenCalled();
  });

  it('does nothing for a user id that does not exist', async () => {
    const { service, desk, deps } = setup({ user: null });
    await expect(service.handleMessage(message())).resolves.toBe('ignored');
    expect(desk.reply).not.toHaveBeenCalled();
    expect(deps.adapters.importAdapter).not.toHaveBeenCalled();
  });

  it('asks an unverified user to confirm the email first', async () => {
    const { service, desk, deps, telegram } = setup({
      user: { id: USER_ID, email: 'a@x.io', name: null, emailVerified: false, memberships: [] },
    });
    await expect(service.handleMessage(message())).resolves.toBe('email_unverified');
    expect(telegram).not.toHaveBeenCalled();
    expect(deps.adapters.importAdapter).not.toHaveBeenCalled();
    expect(replies(desk)).toContain('confirm your email');
  });

  it('sends the setup link instead when the user is in several workspaces', async () => {
    const { service, desk, deps } = setup({
      user: {
        id: USER_ID,
        email: 'a@x.io',
        name: null,
        emailVerified: true,
        memberships: [
          { organizationId: 'o1', role: 'ADMIN', organization: { name: 'One' } },
          { organizationId: 'o2', role: 'ADMIN', organization: { name: 'Two' } },
        ],
      },
    });
    await expect(service.handleMessage(message())).resolves.toBe('several_workspaces');
    expect(deps.adapters.importAdapter).not.toHaveBeenCalled();
    expect(replies(desk)).toContain('/connectors/setup/telegram-bot');
  });

  it('refuses a viewer', async () => {
    const { service, deps } = setup({
      user: {
        id: USER_ID,
        email: 'a@x.io',
        name: null,
        emailVerified: true,
        memberships: [{ organizationId: ORG_ID, role: 'VIEWER', organization: { name: 'Acme' } }],
      },
    });
    await expect(service.handleMessage(message())).resolves.toBe('viewer');
    expect(deps.adapters.importAdapter).not.toHaveBeenCalled();
  });

  it('never replaces or duplicates an existing Telegram connector', async () => {
    const { service, desk, deps, telegram } = setup({ existing: [emptyConnector('empty-1'), setConnector('old-1')] });
    await expect(service.handleMessage(message())).resolves.toBe('already_has_telegram');
    expect(telegram).not.toHaveBeenCalled();
    expect(deps.adapters.importAdapter).not.toHaveBeenCalled();
    expect(deps.connectors.update).not.toHaveBeenCalled();
    expect(replies(desk)).toContain('connector=old-1');
  });

  it('counts a connector whose address holds the token as set up', async () => {
    const resolved = { id: 'old-2', baseUrl: `https://api.telegram.org/bot${OTHER_TOKEN}`, envVars: null };
    const { service, deps } = setup({ existing: [resolved] });
    await expect(service.handleMessage(message())).resolves.toBe('already_has_telegram');
    expect(deps.connectors.update).not.toHaveBeenCalled();
  });

  it('fills the oldest Telegram connector when all of them are still empty', async () => {
    const { service, desk, deps } = setup({ existing: [emptyConnector('empty-1'), emptyConnector('empty-2')] });
    await expect(service.handleMessage(message())).resolves.toBe('filled');

    expect(deps.adapters.importAdapter).not.toHaveBeenCalled();
    expect(deps.licenseGuard.checkCanCreateConnector).not.toHaveBeenCalled();
    expect(deps.connectors.update).toHaveBeenCalledTimes(1);
    expect(deps.connectors.update).toHaveBeenCalledWith('empty-1', { envVars: { TELEGRAM_BOT_TOKEN: TOKEN } });
    expect(deps.mcpServer.reloadConnectorTools).toHaveBeenCalledWith('empty-1');
    expect(deps.mcpServers.attachToDefaultServer).toHaveBeenCalledWith(USER_ID, ORG_ID, 'empty-1');
    expect(deps.securityEvents.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ connectorId: 'empty-1', filledEmptyConnector: true }),
      }),
    );
    expect(desk.addTags).toHaveBeenCalledWith('conv-1', [AUTO_SETUP_TAG]);
    expect(replies(desk)).toContain('/connectors/empty-1');
    expect(replies(desk)).not.toContain(TOKEN);
    expect(deps.email.sendConnectorAddedFromSupportEmail).toHaveBeenCalled();
  });

  it('keeps other variables of the empty connector', async () => {
    const empty = { id: 'empty-1', baseUrl: TEMPLATE_URL, envVars: { TELEGRAM_BOT_TOKEN: '  ', OTHER: 'kept' } };
    const { service, deps } = setup({ existing: [empty] });
    await expect(service.handleMessage(message())).resolves.toBe('filled');
    expect(deps.connectors.update).toHaveBeenCalledWith('empty-1', {
      envVars: { TELEGRAM_BOT_TOKEN: TOKEN, OTHER: 'kept' },
    });
  });

  it('leaves the connector alone when a token reached it while checking', async () => {
    const { service, desk, deps } = setup({
      existing: [emptyConnector('empty-1')],
      existingLater: [setConnector('empty-1')],
    });
    await expect(service.handleMessage(message())).resolves.toBe('already_has_telegram');
    expect(deps.connectors.update).not.toHaveBeenCalled();
    expect(replies(desk)).toContain('connector=empty-1');
  });

  it('does not fill an empty connector with a token Telegram refuses', async () => {
    const { service, deps } = setup({
      existing: [emptyConnector('empty-1')],
      telegramStatus: 401,
      telegramBody: { ok: false },
    });
    await expect(service.handleMessage(message())).resolves.toBe('invalid_token');
    expect(deps.connectors.update).not.toHaveBeenCalled();
  });

  it('answers with the catalog hint when Telegram refuses the token', async () => {
    const { service, desk, deps } = setup({ telegramStatus: 401, telegramBody: { ok: false } });
    await expect(service.handleMessage(message())).resolves.toBe('invalid_token');
    expect(deps.adapters.importAdapter).not.toHaveBeenCalled();
    expect(replies(desk)).toContain('Telegram refused the bot token.');
  });

  it('stops at the plan limit', async () => {
    const { service, desk, deps } = setup({ licenceError: new Error('Your plan allows 3 connectors.') });
    await expect(service.handleMessage(message())).resolves.toBe('plan_limit');
    expect(deps.adapters.importAdapter).not.toHaveBeenCalled();
    expect(replies(desk)).toContain('Your plan allows 3 connectors.');
  });

  it('handles each message once and at most three installs a day per workspace', async () => {
    const { service, deps } = setup();
    const first = message();
    await expect(service.handleMessage(first)).resolves.toBe('installed');
    await expect(service.handleMessage(first)).resolves.toBe('ignored');

    await service.handleMessage(message({ conversation_uuid: 'conv-2' }));
    await service.handleMessage(message({ conversation_uuid: 'conv-3' }));
    await expect(service.handleMessage(message({ conversation_uuid: 'conv-4' }))).resolves.toBe('rate_limited');
    expect(deps.adapters.importAdapter).toHaveBeenCalledTimes(3);
  });
});
