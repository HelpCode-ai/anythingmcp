import * as adapter from './klaviyo.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/** Live: RUN_KLAVIYO_LIVE=1 npx jest src/adapters/intl/klaviyo.live.spec.ts */

interface Tool { name: string; endpointMapping: { method: string; path: string; headers?: Record<string,string> } }
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};

describe('klaviyo adapter — static spec conformance', () => {
  it('uses a.klaviyo.com/api', () => {
    expect(a.connector.baseUrl).toBe('https://a.klaviyo.com/api');
  });
  it('uses Klaviyo-API-Key prefix (NOT Bearer)', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('Authorization');
    expect(a.connector.authConfig.apiKey).toBe('Klaviyo-API-Key {{KLAVIYO_PRIVATE_API_KEY}}');
  });
  it('every tool pins the revision header to 2024-10-15', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.headers?.revision).toBe('2024-10-15');
    }
  });
});

const maybe = process.env.RUN_KLAVIYO_LIVE ? describe : describe.skip;
maybe('klaviyo adapter — live edge reachability', () => {
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);

  it('GET /accounts reaches Klaviyo edge (401)', async () => {
    let err: any;
    try {
      await engine.execute(
        {
          baseUrl: a.connector.baseUrl,
          authType: 'API_KEY',
          authConfig: { headerName: 'Authorization', apiKey: 'Klaviyo-API-Key pk_bogus' },
        },
        {
          method: 'GET',
          path: '/accounts',
          headers: { revision: '2024-10-15', Accept: 'application/vnd.api+json' },
        },
        {},
      );
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect([401, 403]).toContain(err.response?.status);
  }, 30000);
});
