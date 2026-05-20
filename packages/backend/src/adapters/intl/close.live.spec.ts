import * as adapter from './close.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/** Live: RUN_CLOSE_LIVE=1 npx jest src/adapters/intl/close.live.spec.ts */

const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Array<{ name: string; endpointMapping: { method: string; path: string } }>;
};

describe('close adapter — static spec conformance', () => {
  it('api.close.com/api/v1', () => expect(a.connector.baseUrl).toBe('https://api.close.com/api/v1'));
  it('BASIC_AUTH with api key as username, empty password (Stripe-style)', () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig.username).toBe('{{CLOSE_API_KEY}}');
    expect(a.connector.authConfig.password).toBe('');
  });
  it('all lead endpoints have trailing slash (Close convention)', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.path.endsWith('/')).toBe(true);
    }
  });
});

const maybe = process.env.RUN_CLOSE_LIVE ? describe : describe.skip;
maybe('close adapter — live', () => {
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  it('GET /me/ reaches Close (401 with bogus key)', async () => {
    let err: any;
    try {
      await engine.execute(
        { baseUrl: a.connector.baseUrl, authType: 'BASIC_AUTH', authConfig: { username: 'api_bogus', password: '' } },
        { method: 'GET', path: '/me/' },
        {},
      );
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.response?.status).toBe(401);
  }, 30000);
});
