import * as adapter from './discord-bot.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/** Live: RUN_DISCORD_BOT_LIVE=1 npx jest src/adapters/intl/discord-bot.live.spec.ts */

interface Tool { name: string; endpointMapping: { method: string; path: string } }
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};

describe('discord-bot adapter — static spec conformance', () => {
  it('uses discord.com/api/v10', () => {
    expect(a.connector.baseUrl).toBe('https://discord.com/api/v10');
  });

  it('authenticates with Bot prefix (NOT Bearer) — Discord-specific', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('Authorization');
    expect(a.connector.authConfig.apiKey).toBe('Bot {{DISCORD_BOT_TOKEN}}');
  });

  it('send-message uses POST /channels/{channelId}/messages', () => {
    const t = a.tools.find((x) => x.name === 'discord_bot_send_message')!;
    expect(t.endpointMapping.method).toBe('POST');
    expect(t.endpointMapping.path).toBe('/channels/{channelId}/messages');
  });

  it('add-reaction uses PUT (idempotent — reacting twice with same emoji is a no-op)', () => {
    const t = a.tools.find((x) => x.name === 'discord_bot_add_reaction')!;
    expect(t.endpointMapping.method).toBe('PUT');
    expect(t.endpointMapping.path).toContain('/reactions/{emoji}/@me');
  });
});

const maybe = process.env.RUN_DISCORD_BOT_LIVE ? describe : describe.skip;
maybe('discord-bot adapter — live edge reachability', () => {
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);

  it('GET /users/@me reaches Discord edge (401 with bogus token)', async () => {
    let err: any;
    try {
      await engine.execute(
        {
          baseUrl: a.connector.baseUrl,
          authType: 'API_KEY',
          authConfig: { headerName: 'Authorization', apiKey: 'Bot bogus-token-for-validation' },
        },
        { method: 'GET', path: '/users/@me' },
        {},
      );
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.response?.status).toBe(401);
  }, 30000);
});
