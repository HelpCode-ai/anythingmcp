import * as adapter from './telegram-bot.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/** Live: RUN_TELEGRAM_BOT_LIVE=1 npx jest src/adapters/intl/telegram-bot.live.spec.ts */

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

const maybe = process.env.RUN_TELEGRAM_BOT_LIVE ? describe : describe.skip;
maybe('telegram-bot adapter — live edge reachability', () => {
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);

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
