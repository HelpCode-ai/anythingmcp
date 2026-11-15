import {
  MANAGER_WEBHOOK_PATH,
  codeFromUsername,
  creationLink,
  hashSetupCode,
  hashTelegramUserId,
  isEmptyTelegramConnector,
  isOrganizationAllowed,
  managerWebhookUrl,
  newSetupCode,
  readManagedBotSettings,
  readManagedBotState,
  suggestedUsername,
} from './telegram-managed-bot';

const TOKEN = '7000000001:AAF4kq0ManagerBotTokenForTestsOnly00';
const SECRET = 'webhook-secret-for-tests-0123456789';

describe('one-tap Telegram bot: settings', () => {
  it('is off without a manager token, and that is not a problem', () => {
    expect(readManagedBotSettings({})).toEqual({ settings: null });
    expect(readManagedBotSettings({ TELEGRAM_MANAGER_BOT_TOKEN: '  ', TELEGRAM_MANAGER_WEBHOOK_SECRET: SECRET })).toEqual({
      settings: null,
    });
  });

  it('is off, with the reason, when the token or the webhook secret cannot be used', () => {
    expect(readManagedBotSettings({ TELEGRAM_MANAGER_BOT_TOKEN: 'not-a-token', TELEGRAM_MANAGER_WEBHOOK_SECRET: SECRET })).toEqual({
      settings: null,
      problem: 'bad_token',
    });
    expect(readManagedBotSettings({ TELEGRAM_MANAGER_BOT_TOKEN: TOKEN })).toEqual({ settings: null, problem: 'no_webhook_secret' });
    // Telegram only takes A-Z, a-z, 0-9, _ and -; a short one is refused here.
    for (const secret of ['short', 'with spaces in the secret 123', 'x'.repeat(257)]) {
      expect(readManagedBotSettings({ TELEGRAM_MANAGER_BOT_TOKEN: TOKEN, TELEGRAM_MANAGER_WEBHOOK_SECRET: secret })).toEqual({
        settings: null,
        problem: 'bad_webhook_secret',
      });
    }
  });

  it('offers every workspace unless an allowlist is set', () => {
    const open = readManagedBotSettings({ TELEGRAM_MANAGER_BOT_TOKEN: TOKEN, TELEGRAM_MANAGER_WEBHOOK_SECRET: SECRET }).settings!;
    expect(open.organizationIds).toBeNull();
    expect(isOrganizationAllowed(open, 'org-1')).toBe(true);

    const listed = readManagedBotSettings({
      TELEGRAM_MANAGER_BOT_TOKEN: TOKEN,
      TELEGRAM_MANAGER_WEBHOOK_SECRET: SECRET,
      TELEGRAM_MANAGED_BOT_ORG_IDS: ' org-1 , org-2,, ',
    }).settings!;
    expect([...listed.organizationIds!]).toEqual(['org-1', 'org-2']);
    expect(isOrganizationAllowed(listed, 'org-2')).toBe(true);
    expect(isOrganizationAllowed(listed, 'org-3')).toBe(false);
  });
});

describe('one-tap Telegram bot: code, username and link', () => {
  it('makes a username Telegram accepts and reads the code back from it', () => {
    const code = newSetupCode();
    expect(code).toMatch(/^[0-9a-f]{8}$/);
    const username = suggestedUsername(code);
    // 5 to 32 characters of letters, digits and underscores, ending in "bot".
    expect(username).toMatch(/^[A-Za-z0-9_]{5,32}$/);
    expect(username.endsWith('bot')).toBe(true);
    expect(codeFromUsername(username)).toBe(code);
    // Telegram usernames are not case sensitive.
    expect(codeFromUsername(username.toUpperCase())).toBe(code);
  });

  it('finds no code in a username the user changed, or in anything else', () => {
    for (const other of ['my_shop_bot', 'amcp_1234_bot', 'amcp_zzzzzzzz_bot', 'xamcp_1a2b3c4d_bot', 'amcp_1a2b3c4d_bot2', '', null, 42]) {
      expect(codeFromUsername(other)).toBeNull();
    }
  });

  it('never stores the code itself: the hash is keyed with the webhook secret', () => {
    const hash = hashSetupCode('1a2b3c4d', SECRET);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('1a2b3c4d');
    expect(hashSetupCode('1A2B3C4D', SECRET)).toBe(hash);
    expect(hashSetupCode('1a2b3c4d', `${SECRET}x`)).not.toBe(hash);
    expect(hashTelegramUserId(4242, SECRET)).not.toBe(hashSetupCode('4242', SECRET));
  });

  it('builds the link that opens Telegram on the new bot', () => {
    expect(creationLink('AnythingMCPBot', '1a2b3c4d')).toBe(
      'https://t.me/newbot/AnythingMCPBot/amcp_1a2b3c4d_bot?name=My%20AnythingMCP%20bot',
    );
  });
});

describe('one-tap Telegram bot: the webhook address', () => {
  it('is on the public https server', () => {
    expect(managerWebhookUrl('https://cloud.example.com/')).toBe(`https://cloud.example.com${MANAGER_WEBHOOK_PATH}`);
    expect(managerWebhookUrl('https://mcp.example.com:8443')).toBe(`https://mcp.example.com:8443${MANAGER_WEBHOOK_PATH}`);
  });

  it.each([undefined, '', 'not a url', 'http://cloud.example.com', 'https://localhost:4000', 'https://10.0.0.5', 'https://backend', 'https://server.local', 'https://[::1]:4000'])(
    'is nowhere for %s: Telegram could not reach it',
    (serverUrl) => {
      expect(managerWebhookUrl(serverUrl)).toBeNull();
    },
  );
});

describe('one-tap Telegram bot: the state on the connector', () => {
  it('reads only well-formed values', () => {
    const hash = 'a'.repeat(64);
    expect(
      readManagedBotState({
        adapterSlug: 'telegram-bot',
        telegramManagedBot: {
          codeHash: hash,
          expiresAt: '2026-11-15T10:30:00.000Z',
          startedAt: 'yesterday',
          userId: 'u1',
          via: 'someone',
          botUsername: '<script>',
          connectedAt: 12,
        },
      }),
    ).toEqual({ codeHash: hash, expiresAt: '2026-11-15T10:30:00.000Z', userId: 'u1' });
    expect(readManagedBotState({ adapterSlug: 'telegram-bot' })).toBeNull();
    expect(readManagedBotState({ telegramManagedBot: ['x'] })).toBeNull();
    expect(readManagedBotState(null)).toBeNull();
  });

  it('knows a Telegram connector without a token', () => {
    const placeholder = 'https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}';
    expect(isEmptyTelegramConnector({ baseUrl: placeholder, envVars: null })).toBe(true);
    expect(isEmptyTelegramConnector({ baseUrl: placeholder, envVars: { TELEGRAM_BOT_TOKEN: ' ' } })).toBe(true);
    expect(isEmptyTelegramConnector({ baseUrl: placeholder, envVars: { TELEGRAM_BOT_TOKEN: '1:x' } })).toBe(false);
    // An address someone edited counts as set up: it is never written to.
    expect(isEmptyTelegramConnector({ baseUrl: 'https://api.telegram.org/bot1:x', envVars: {} })).toBe(false);
  });
});
