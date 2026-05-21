import * as adapter from './brevo.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/** Live: RUN_BREVO_LIVE=1 npx jest src/adapters/intl/brevo.live.spec.ts */

const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Array<{ name: string; endpointMapping: { method: string; path: string } }>;
};

describe('brevo adapter — static spec conformance', () => {
  it('api.brevo.com/v3', () => expect(a.connector.baseUrl).toBe('https://api.brevo.com/v3'));
  it('lowercase api-key header (Brevo-specific)', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('api-key');
  });
  it('transactional email goes to /smtp/email', () => {
    const t = a.tools.find((x) => x.name === 'brevo_send_transactional_email')!;
    expect(t.endpointMapping.path).toBe('/smtp/email');
  });
});

const maybe = process.env.RUN_BREVO_LIVE ? describe : describe.skip;
maybe('brevo adapter — live', () => {
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  it('GET /account 401', async () => {
    let err: any;
    try {
      await engine.execute(
        { baseUrl: a.connector.baseUrl, authType: 'API_KEY', authConfig: { headerName: 'api-key', apiKey: 'bogus' } },
        { method: 'GET', path: '/account' },
        {},
      );
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.response?.status).toBe(401);
  }, 30000);
});
