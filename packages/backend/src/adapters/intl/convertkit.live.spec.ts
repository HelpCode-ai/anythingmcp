import * as adapter from './convertkit.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Array<{ name: string; endpointMapping: { method: string; path: string } }>;
};

describe('convertkit adapter — static spec conformance', () => {
  it('uses Kit v4 base', () => expect(a.connector.baseUrl).toBe('https://api.convertkit.com/v4'));
  it('Bearer auth', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{CONVERTKIT_API_KEY}}');
  });
});

const maybe = process.env.RUN_CONVERTKIT_LIVE ? describe : describe.skip;
maybe('convertkit adapter — live', () => {
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  it('GET /account 401 with bogus', async () => {
    let err: any;
    try {
      await engine.execute(
        { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: 'bogus' } },
        { method: 'GET', path: '/account' },
        {},
      );
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect([401, 403]).toContain(err.response?.status);
  }, 30000);
});
