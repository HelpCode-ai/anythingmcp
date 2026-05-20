import * as adapter from './lemonsqueezy.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/** Live: RUN_LEMONSQUEEZY_LIVE=1 npx jest src/adapters/intl/lemonsqueezy.live.spec.ts */

interface Tool { name: string; endpointMapping: { method: string; path: string; headers?: Record<string,string> } }
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};

describe('lemonsqueezy adapter — static spec conformance', () => {
  it('uses api.lemonsqueezy.com/v1', () => {
    expect(a.connector.baseUrl).toBe('https://api.lemonsqueezy.com/v1');
  });
  it('Bearer auth', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{LEMONSQUEEZY_API_KEY}}');
  });
  it('every tool sets Accept: application/vnd.api+json (JSON:API requirement)', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.headers?.Accept).toBe('application/vnd.api+json');
    }
  });
});

const maybe = process.env.RUN_LEMONSQUEEZY_LIVE ? describe : describe.skip;
maybe('lemonsqueezy adapter — live edge reachability', () => {
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);

  it('GET /users/me reaches Lemon Squeezy edge (401)', async () => {
    let err: any;
    try {
      await engine.execute(
        { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: 'bogus' } },
        { method: 'GET', path: '/users/me', headers: { Accept: 'application/vnd.api+json' } },
        {},
      );
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect([401, 403]).toContain(err.response?.status);
  }, 30000);
});
