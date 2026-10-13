import axios from 'axios';
import * as adapter from './telegram-bot.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

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

  it('all tools are POST except getMe (which is GET)', () => {
    for (const t of a.tools) {
      if (t.name === 'telegram_bot_get_me') {
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

  it('sends the album as a JSON array, the shape that works in hand-built tools', async () => {
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

  it('keeps the bot token out of every tool path', () => {
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/[A-Za-z]+$/);
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
