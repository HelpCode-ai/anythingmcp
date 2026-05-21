import * as adapter from './sendgrid.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Live: RUN_SENDGRID_LIVE=1 npx jest src/adapters/intl/sendgrid.live.spec.ts
 */

interface Tool { name: string; endpointMapping: { method: string; path: string } }
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};

describe('sendgrid adapter — static spec conformance', () => {
  it('uses the global SendGrid base URL by default', () => {
    expect(a.connector.baseUrl).toBe('https://api.sendgrid.com');
  });

  it('Bearer auth with SENDGRID_API_KEY', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{SENDGRID_API_KEY}}');
  });

  it('mail send uses POST /v3/mail/send', () => {
    const t = a.tools.find((x) => x.name === 'sendgrid_send_mail')!;
    expect(t.endpointMapping.method).toBe('POST');
    expect(t.endpointMapping.path).toBe('/v3/mail/send');
  });

  it('marketing contacts upsert uses PUT (idempotent)', () => {
    const t = a.tools.find((x) => x.name === 'sendgrid_upsert_marketing_contacts')!;
    expect(t.endpointMapping.method).toBe('PUT');
    expect(t.endpointMapping.path).toBe('/v3/marketing/contacts');
  });
});

const maybe = process.env.RUN_SENDGRID_LIVE ? describe : describe.skip;

maybe('sendgrid adapter — live edge reachability', () => {
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);

  it('GET /v3/templates reaches SendGrid edge (401 with bogus key)', async () => {
    let err: any;
    try {
      await engine.execute(
        { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: 'SG.bogus' } },
        { method: 'GET', path: '/v3/templates' },
        {},
      );
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.response?.status).toBe(401);
  }, 30000);
});
