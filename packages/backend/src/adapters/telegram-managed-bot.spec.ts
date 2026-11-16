import {
  MANAGER_WEBHOOK_PATH,
  TELEGRAM_CONNECTED_REQUEST,
  claimLink,
  claimWebLink,
  creationWebLink,
  qrPath,
  telegramWebLink,
  claimParameter,
  cleanClientName,
  clientConnectedMessage,
  codeFromClaimParameter,
  codeFromUsername,
  creationLink,
  hashSetupCode,
  hashTelegramUserId,
  isEmptyTelegramConnector,
  isOrganizationAllowed,
  managerWebhookUrl,
  newSetupCode,
  parseStartCommand,
  readManagedBotSettings,
  readManagedBotState,
  suggestedUsername,
  welcomeText,
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

  it('reads who asked to link the setup, and that a bot was found that way', () => {
    const hash = 'b'.repeat(64);
    expect(
      readManagedBotState({
        telegramManagedBot: {
          claimHash: hash,
          claimedAt: '2026-11-15T10:05:00.000Z',
          claimOfferedAt: '2026-11-15T10:04:00.000Z',
          matched: 'claim',
        },
      }),
    ).toEqual({ claimHash: hash, claimedAt: '2026-11-15T10:05:00.000Z', claimOfferedAt: '2026-11-15T10:04:00.000Z', matched: 'claim' });
    // A Telegram id is never a valid value: only its keyed hash.
    expect(readManagedBotState({ telegramManagedBot: { claimHash: '555001', claimedAt: 'soon', matched: 'guess' } })).toEqual({});
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

describe('one-tap Telegram bot: linking a bot whose username was changed', () => {
  it('builds the link that opens the manager bot with the setup code and its keyed check', () => {
    const link = claimLink('AnythingMCP_Setup_Bot', '1a2b3c4d', SECRET);
    expect(link).toBe(`https://t.me/AnythingMCP_Setup_Bot?start=${claimParameter('1a2b3c4d', SECRET)}`);
    // Within what Telegram allows in a start parameter: 64 of A-Z, a-z, 0-9, _ and -.
    expect(link.split('?start=')[1]).toMatch(/^1a2b3c4d[0-9a-f]{16}$/);
  });

  it('takes back only a parameter signed with this webhook secret', () => {
    const parameter = claimParameter('1a2b3c4d', SECRET);
    expect(codeFromClaimParameter(parameter, SECRET)).toBe('1a2b3c4d');
    expect(codeFromClaimParameter(parameter.toUpperCase(), SECRET)).toBe('1a2b3c4d');
    expect(claimParameter('1A2B3C4D', SECRET)).toBe(parameter);
    // Another secret, another code with this check, a changed check, the bare code.
    expect(codeFromClaimParameter(parameter, `${SECRET}x`)).toBeNull();
    expect(codeFromClaimParameter(`1a2b3c4e${parameter.slice(8)}`, SECRET)).toBeNull();
    expect(codeFromClaimParameter(`1a2b3c4d${'0'.repeat(16)}`, SECRET)).toBeNull();
    expect(codeFromClaimParameter('1a2b3c4d', SECRET)).toBeNull();
    for (const other of [undefined, null, 42, '', 'hello', `${parameter}0`, parameter.slice(1), `${parameter.slice(0, 23)}g`]) {
      expect(codeFromClaimParameter(other, SECRET)).toBeNull();
    }
    // The check says nothing about the stored hash of the code.
    expect(hashSetupCode('1a2b3c4d', SECRET).startsWith(parameter.slice(8))).toBe(false);
  });

  it('reads the parameter of a /start, in the forms Telegram sends it', () => {
    expect(parseStartCommand('/start 1a2b3c4d')).toEqual({ parameter: '1a2b3c4d' });
    expect(parseStartCommand('/start@AnythingMCP_Setup_Bot 1A2B3C4D ')).toEqual({ parameter: '1A2B3C4D' });
    expect(parseStartCommand('/start hello')).toEqual({ parameter: 'hello' });
    expect(parseStartCommand('/start')).toEqual({ parameter: '' });
    expect(parseStartCommand(' /start  ')).toEqual({ parameter: '' });
  });

  it.each([undefined, null, 42, '', 'hello', 'start 1a2b3c4d', '/started 1a2b3c4d', '/start 1a2b3c4d and more', '/help', `/start ${'a'.repeat(200)}`])(
    'is not a /start: %p',
    (text) => {
      expect(parseStartCommand(text)).toBeNull();
    },
  );

  it('keys a Telegram account with the webhook secret, apart from a setup code', () => {
    const hash = hashTelegramUserId(555001, SECRET);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(hashTelegramUserId(555002, SECRET));
    expect(hash).not.toBe(hashTelegramUserId(555001, `${SECRET}x`));
    expect(hash).not.toBe(hashSetupCode('555001', SECRET));
  });
});

describe('one-tap Telegram bot: what the bot tells its creator', () => {
  it('sends them back to the page for the last step, by the name of the button', () => {
    expect(welcomeText('Claude')).toBe(
      'Your bot is connected to AnythingMCP. One step left: go back to the page you came from and tap "Continue to Claude".',
    );
    expect(welcomeText('ChatGPT')).toContain('tap "Continue to ChatGPT".');
    expect(welcomeText()).toBe(
      'Your bot is connected to AnythingMCP. One step left: go back to the page you came from and tap Continue.',
    );
    // The AI client is not connected yet: nothing sends the user to the chat.
    for (const text of [welcomeText('Claude'), welcomeText(null)]) {
      expect(text).not.toMatch(/ask/i);
      expect(text).not.toContain('test message');
    }
  });

  it('says the assistant is connected, with a link to a new chat for Claude only', () => {
    expect(clientConnectedMessage('Claude', true)).toEqual({
      text: 'Claude is now connected to AnythingMCP. Ask it: "Send me a test message on Telegram."',
      link: {
        label: 'Open a new chat in Claude',
        url: 'https://claude.ai/new?q=Send%20me%20a%20test%20message%20on%20Telegram.',
      },
    });
    expect(decodeURIComponent(clientConnectedMessage('Claude', true).link!.url.split('?q=')[1])).toBe(TELEGRAM_CONNECTED_REQUEST);
    // The same sentence for any other client, without a link.
    expect(clientConnectedMessage('ChatGPT', false)).toEqual({
      text: 'ChatGPT is now connected to AnythingMCP. Ask it: "Send me a test message on Telegram."',
    });
    expect(clientConnectedMessage(null, false).text).toBe(
      'Your AI assistant is now connected to AnythingMCP. Ask it: "Send me a test message on Telegram."',
    );
  });

  it('quotes a client only by a short plain name', () => {
    expect(cleanClientName('Claude')).toBe('Claude');
    expect(cleanClientName('  Claude   Code ')).toBe('Claude Code');
    expect(cleanClientName('Le Chat (Mistral)')).toBe('Le Chat (Mistral)');
    for (const name of [undefined, null, 42, '', '   ', 'x'.repeat(41), 'Claude\u0000', 'see https://evil.example', 'a<b>', '"Claude"', '@Claude', 'Claude: free money']) {
      expect(cleanClientName(name)).toBeNull();
    }
    // Two lines become one name or none: never a second line in a message.
    expect(cleanClientName('Claude\nfree')).toBe('Claude free');
  });

  it('keeps the client and the announcement in the state, and nothing that is no name', () => {
    expect(
      readManagedBotState({
        telegramManagedBot: { client: 'Claude', claude: true, clientNoticeAt: '2026-11-15T10:09:00.000Z' },
      }),
    ).toEqual({ client: 'Claude', claude: true, clientNoticeAt: '2026-11-15T10:09:00.000Z' });
    expect(readManagedBotState({ telegramManagedBot: { client: 'see https://evil.example', claude: 'yes', clientNoticeAt: 'soon' } })).toEqual({});
  });
});

describe('Telegram in the browser, and the QR code', () => {
  const SECRET = 'a-webhook-secret-of-32-characters';

  it('wraps a tg:// link the way Telegram\'s own pages hand it to the web client', () => {
    expect(telegramWebLink('tg://resolve?domain=x&start=y')).toBe(
      'https://web.telegram.org/a/#?tgaddr=tg%3A%2F%2Fresolve%3Fdomain%3Dx%26start%3Dy',
    );
  });

  it('carries the same manager, username and name as the creation link', () => {
    const web = creationWebLink('AnythingMCP_Setup_Bot', '1a2b3c4d');
    expect(web.startsWith('https://web.telegram.org/a/#?tgaddr=')).toBe(true);
    const tg = new URL(decodeURIComponent(web.split('tgaddr=')[1]));
    expect(tg.protocol).toBe('tg:');
    expect(tg.host).toBe('newbot');
    expect(Object.fromEntries(tg.searchParams)).toEqual({
      manager: 'AnythingMCP_Setup_Bot',
      username: 'amcp_1a2b3c4d_bot',
      name: 'My AnythingMCP bot',
    });
  });

  it('carries the same signed start parameter as the claim link', () => {
    const start = new URL(claimLink('AnythingMCP_Setup_Bot', '1a2b3c4d', SECRET)).searchParams.get('start');
    const tg = new URL(decodeURIComponent(claimWebLink('AnythingMCP_Setup_Bot', '1a2b3c4d', SECRET).split('tgaddr=')[1]));
    expect(tg.host).toBe('resolve');
    expect(Object.fromEntries(tg.searchParams)).toEqual({ domain: 'AnythingMCP_Setup_Bot', start });
  });

  it('gives the QR code a path on this server that holds only the code', () => {
    expect(qrPath('1a2b3c4d')).toBe('/auth/first-app/telegram/qr/1a2b3c4d');
  });
});
