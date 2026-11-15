import axios from 'axios';
import * as adapter from './telegram-bot.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applyEnvDefaults } from '../../common/schema-defaults.util';

/** Live: RUN_TELEGRAM_BOT_LIVE=1 npx jest src/adapters/intl/telegram-bot.live.spec.ts */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

interface Tool { name: string; endpointMapping: { method: string; path: string } }
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string };
  tools: Tool[];
};

describe('telegram-bot adapter — static spec conformance', () => {
  it('bot token lives in the URL path (Telegram-specific)', () => {
    expect(a.connector.baseUrl).toBe('https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}');
  });

  it('uses authType NONE since token is path-based, not header-based', () => {
    expect(a.connector.authType).toBe('NONE');
  });

  it('caps the getUpdates long poll below the 30 s request timeout', () => {
    const t = a.tools.find((x) => x.name === 'telegram_bot_get_updates')! as unknown as {
      parameters: { properties: { timeout: { maximum: number } } };
    };
    expect(t.parameters.properties.timeout.maximum).toBe(25);
  });

  it('downloads a file from the /file/bot<token>/ host path, not the method path', () => {
    const download = a.tools.find((t) => t.name === 'telegram_bot_download_file')!;
    expect(download.endpointMapping).toEqual({
      method: 'GET',
      path: 'https://api.telegram.org/file/bot{{TELEGRAM_BOT_TOKEN}}/{file_path}',
    });
    const pattern = new RegExp(
      (download as unknown as { parameters: { properties: { file_path: { pattern: string } } } }).parameters.properties
        .file_path.pattern,
    );
    expect(pattern.test('photos/file_12.jpg')).toBe(true);
    expect(pattern.test('documents/file_3.pdf')).toBe(true);
    expect(pattern.test('../../bot123/sendMessage')).toBe(false);
    expect(a.tools.find((t) => t.name === 'telegram_bot_get_file')!.endpointMapping.path).toBe('/getFile');
  });

  it('all tools are POST except getMe and the file download (GET)', () => {
    for (const t of a.tools) {
      if (t.name === 'telegram_bot_get_me' || t.name === 'telegram_bot_download_file') {
        expect(t.endpointMapping.method).toBe('GET');
      } else {
        expect(t.endpointMapping.method).toBe('POST');
      }
    }
  });

  it('voice notes go to sendVoice (audio bubble), audio files to sendAudio (music player)', () => {
    const v = a.tools.find((x) => x.name === 'telegram_bot_send_voice')!;
    expect(v.endpointMapping.path).toBe('/sendVoice');
    const au = a.tools.find((x) => x.name === 'telegram_bot_send_audio')!;
    expect(au.endpointMapping.path).toBe('/sendAudio');
  });
});

/**
 * Albums and the other media sends, checked against the Bot API reference
 * (method names, parameters, the InputMedia fields) and against workspaces'
 * own sendMediaGroup tools, which succeed with a JSON body carrying `media`
 * as an array of {type, media, caption, parse_mode}. Telegram checks the bot
 * token before the method, so a probe with a bogus token answers 401 for any
 * method name.
 */
describe('telegram-bot adapter: the default chat', () => {
  type SendTool = {
    name: string;
    parameters: { required?: string[]; properties: Record<string, { description?: string }> };
    endpointMapping: { envDefaults?: Record<string, string> };
  };
  const tools = (adapter as unknown as { tools: SendTool[] }).tools;
  const sends = tools.filter((t) => /^telegram_bot_send_/.test(t.name));

  // "Send me a test message" names no chat: a bot created in one tap knows
  // who made it, and every send tool then writes there by itself.
  it('lets every send tool leave chat_id out and fills it from TELEGRAM_DEFAULT_CHAT_ID', () => {
    expect(sends.map((t) => t.name)).toEqual(expect.arrayContaining(['telegram_bot_send_message', 'telegram_bot_send_photo']));
    expect(sends.length).toBeGreaterThanOrEqual(13);
    for (const tool of sends) {
      expect([tool.name, tool.endpointMapping.envDefaults]).toEqual([tool.name, { chat_id: 'TELEGRAM_DEFAULT_CHAT_ID' }]);
      expect(tool.parameters.required ?? []).not.toContain('chat_id');
      expect(tool.parameters.properties.chat_id.description).toMatch(/Leave it out/);
    }
    const send = sends.find((t) => t.name === 'telegram_bot_send_message')!;
    const env = { TELEGRAM_BOT_TOKEN: '1:x', TELEGRAM_DEFAULT_CHAT_ID: '555001' };
    expect(applyEnvDefaults(send.endpointMapping, { text: 'hi' }, env)).toEqual({ text: 'hi', chat_id: '555001' });
    expect(applyEnvDefaults(send.endpointMapping, { text: 'hi', chat_id: '-100200' }, env).chat_id).toBe('-100200');
  });

  it('keeps chat_id required where a wrong chat would change or delete something', () => {
    const others = tools.filter((t) => 'chat_id' in t.parameters.properties && !sends.includes(t));
    expect(others.length).toBeGreaterThan(5);
    for (const tool of others) {
      expect([tool.name, tool.parameters.required]).toEqual([tool.name, expect.arrayContaining(['chat_id'])]);
      expect(tool.endpointMapping.envDefaults).toBeUndefined();
    }
  });

  it('declares the default chat as an optional, non-secret setting and tells the model about it', () => {
    const meta = adapter as unknown as {
      optionalEnvVars: string[];
      envVarMeta: Record<string, { kind: string; secret?: boolean; pattern: string }>;
      instructionFacts: string[];
    };
    expect(meta.optionalEnvVars).toEqual(['TELEGRAM_DEFAULT_CHAT_ID']);
    expect(meta.envVarMeta.TELEGRAM_DEFAULT_CHAT_ID.kind).toBe('setting');
    expect(meta.envVarMeta.TELEGRAM_DEFAULT_CHAT_ID.secret).toBeUndefined();
    const pattern = new RegExp(meta.envVarMeta.TELEGRAM_DEFAULT_CHAT_ID.pattern);
    for (const ok of ['555001', '-1001234567890', '@my_channel']) expect(pattern.test(ok)).toBe(true);
    for (const bad of ['', 'me', '12 34', 'https://t.me/x']) expect(pattern.test(bad)).toBe(false);
    expect(meta.instructionFacts.join(' ')).toContain('{{TELEGRAM_DEFAULT_CHAT_ID}}');
  });
});

describe('telegram-bot adapter: albums and media sends', () => {
  const BASE = 'https://api.telegram.org/bot123:abc';
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  const tool = (name: string) => {
    const t = a.tools.find((x) => x.name === name);
    if (!t) throw new Error(`missing tool ${name}`);
    return t as Tool & { parameters: { required: string[] }; enabled?: boolean; description: string };
  };
  const call = (name: string, params: Record<string, unknown>) =>
    engine.execute({ baseUrl: BASE, authType: 'NONE' }, tool(name).endpointMapping as never, params);
  const sent = () => mockedAxios.mock.calls[0][0];
  beforeEach(() => mockedAxios.mockReset());

  const table: Array<[string, Record<string, unknown>, string]> = [
    ['telegram_bot_send_album', { chat_id: '1', media: [] }, '/sendMediaGroup'],
    ['telegram_bot_send_animation', { chat_id: '1', animation: 'https://example.com/a.gif' }, '/sendAnimation'],
    ['telegram_bot_send_sticker', { chat_id: '1', sticker: 'CAACAgI' }, '/sendSticker'],
    ['telegram_bot_send_contact', { chat_id: '1', phone_number: '+49151', first_name: 'Ana' }, '/sendContact'],
    ['telegram_bot_send_venue', { chat_id: '1', latitude: 1, longitude: 2, title: 'Shop', address: 'Main St 1' }, '/sendVenue'],
  ];

  it.each(table)('%s posts to %s under the bot token', async (name, params, path) => {
    mockedAxios.mockResolvedValue({ data: { ok: true } });
    await call(name, params);
    expect(sent()).toEqual(expect.objectContaining({ method: 'POST', url: `${BASE}${path}` }));
  });

  it('sends the album as a JSON array, the shape Telegram accepts', async () => {
    mockedAxios.mockResolvedValue({ data: { ok: true } });
    const media = [
      { type: 'photo', media: 'https://example.com/1.jpg', caption: '<b>New</b>', parse_mode: 'HTML' },
      { type: 'photo', media: 'https://example.com/2.jpg' },
    ];
    await call('telegram_bot_send_album', { chat_id: '-100123', media, disable_notification: true });
    expect(sent().data).toEqual({ chat_id: '-100123', media, disable_notification: true });
    const schema = tool('telegram_bot_send_album').parameters as unknown as {
      properties: { media: { minItems: number; maxItems: number; items: { properties: { type: { enum: string[] } } } } };
    };
    expect(schema.properties.media.minItems).toBe(2);
    expect(schema.properties.media.maxItems).toBe(10);
    expect(schema.properties.media.items.properties.type.enum).toEqual(['photo', 'video', 'document', 'audio']);
  });

  it('never reuses a name workspaces gave their own tools on this connector', () => {
    // A catalog re-sync matches tools by name: a catalog tool called
    // telegram_bot_send_media_group would overwrite three workspaces' own.
    const names = new Set(a.tools.map((t) => t.name));
    for (const own of [
      'telegram_bot_send_media_group',
      'telegram_bot_send_rich_message',
      'telegram_bot_get_sticker_set',
      'telegram_bot_add_sticker_to_set',
      'telegram_bot_create_new_sticker_set',
      'telegram_bot_delete_sticker_from_set',
      'send_media_group',
      'get_file',
    ]) {
      expect(names.has(own)).toBe(false);
    }
  });

  it('reads a sticker set by name through getStickerSet, marked read-only', async () => {
    mockedAxios.mockResolvedValue({ data: { ok: true, result: { name: 'Animals', stickers: [] } } });
    await call('telegram_bot_fetch_sticker_set', { name: 'Animals' });
    expect(sent()).toEqual(expect.objectContaining({ method: 'POST', url: `${BASE}/getStickerSet` }));
    expect(sent().data).toEqual({ name: 'Animals' });
    const t = tool('telegram_bot_fetch_sticker_set');
    expect(t.parameters.required).toEqual(['name']);
    expect((t as unknown as { annotations: { readOnlyHint: boolean } }).annotations.readOnlyHint).toBe(true);
    expect((tool('telegram_bot_get_chat') as unknown as { annotations: { readOnlyHint: boolean } }).annotations.readOnlyHint).toBe(true);
  });

  // Bot API: every send method and editMessageText take business_connection_id
  // (https://core.telegram.org/bots/api#sendmessage); deleteMessage does not.
  it('sends business_connection_id on every send tool and on edits', async () => {
    const sends = a.tools.filter((t) => /^telegram_bot_(send_|edit_message_text$)/.test(t.name));
    expect(sends.length).toBe(14);
    for (const t of sends) {
      const m = t.endpointMapping as unknown as { bodyMapping: Record<string, string> };
      const props = (t as unknown as { parameters: { properties: Record<string, unknown> } }).parameters.properties;
      expect(`${t.name}:${m.bodyMapping.business_connection_id}`).toBe(`${t.name}:$business_connection_id`);
      expect(`${t.name}:${'business_connection_id' in props}`).toBe(`${t.name}:true`);
    }
    mockedAxios.mockResolvedValue({ data: { ok: true } });
    await call('telegram_bot_send_message', { chat_id: '42', text: 'Hi', business_connection_id: 'bc-1' });
    expect(sent().data).toEqual({ chat_id: '42', text: 'Hi', business_connection_id: 'bc-1' });
  });

  it('names every tool in the instructions and writes no em dash', () => {
    const instructions = (adapter as unknown as { instructions: string }).instructions;
    for (const t of a.tools) expect(`${t.name}:${instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(adapter)).not.toMatch(/—/);
  });

  it('keeps the bot token out of every tool path', () => {
    // The file download lives on another path (/file/bot<token>/…), so it
    // names the variable; every other tool is a bare method under the base URL.
    for (const t of a.tools) {
      if (t.name === 'telegram_bot_download_file') {
        expect(t.endpointMapping.path).toContain('{{TELEGRAM_BOT_TOKEN}}');
        expect(t.endpointMapping.path).not.toMatch(/bot\d+:/);
      } else {
        expect(t.endpointMapping.path).toMatch(/^\/[A-Za-z]+$/);
      }
    }
  });
});

describe('telegram-bot adapter: reactions, chat management, stickers and webhook state', () => {
  const find = (name: string) => {
    const t = (a.tools as Array<Tool & { enabled?: boolean; annotations?: { readOnlyHint?: boolean } }>).find((x) => x.name === name);
    if (!t) throw new Error(`missing tool ${name}`);
    return t;
  };

  it('maps each tool to its Bot API method', () => {
    const methods: Record<string, string> = {
      telegram_bot_react_to_message: '/setMessageReaction',
      telegram_bot_pin_message: '/pinChatMessage',
      telegram_bot_unpin_chat_message: '/unpinChatMessage',
      telegram_bot_rename_chat: '/setChatTitle',
      telegram_bot_update_chat_description: '/setChatDescription',
      telegram_bot_add_forum_topic: '/createForumTopic',
      telegram_bot_edit_message_caption: '/editMessageCaption',
      telegram_bot_create_chat_invite_link: '/createChatInviteLink',
      telegram_bot_create_sticker_set: '/createNewStickerSet',
      telegram_bot_extend_sticker_set: '/addStickerToSet',
      telegram_bot_get_webhook_info: '/getWebhookInfo',
      telegram_bot_remove_webhook: '/deleteWebhook',
    };
    for (const [name, path] of Object.entries(methods)) {
      expect(find(name).endpointMapping).toMatchObject({ method: 'POST', path });
    }
  });

  it('reads the webhook state read-only and installs the webhook removal switched off', () => {
    expect(find('telegram_bot_get_webhook_info').annotations?.readOnlyHint).toBe(true);
    expect(find('telegram_bot_remove_webhook').enabled).toBe(false);
  });
});

const maybe = process.env.RUN_TELEGRAM_BOT_LIVE ? describe : describe.skip;
maybe('telegram-bot adapter — live edge reachability', () => {
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  beforeEach(() => mockedAxios.mockImplementation((cfg) => mockedAxios.__actual.request(cfg)));

  it('GET /bot{bogus}/getMe reaches Telegram edge (401 Unauthorized)', async () => {
    let err: any;
    try {
      await engine.execute(
        { baseUrl: 'https://api.telegram.org/bot123:bogus', authType: 'NONE' },
        { method: 'GET', path: '/getMe' },
        {},
      );
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.response?.status).toBe(401);
    expect(err.response?.data?.description).toMatch(/Unauthorized/i);
  }, 30000);
});
