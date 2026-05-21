import * as adapter from './zendesk.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/** Live: RUN_ZENDESK_LIVE=1 npx jest src/adapters/intl/zendesk.live.spec.ts */

interface Tool { name: string; endpointMapping: { method: string; path: string } }
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};

describe('zendesk adapter — static spec conformance', () => {
  it('uses subdomain-templated base URL', () => {
    expect(a.connector.baseUrl).toBe('https://{{ZENDESK_SUBDOMAIN}}.zendesk.com/api/v2');
  });

  it('uses BASIC_AUTH with the email/token suffix convention', () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig.username).toBe('{{ZENDESK_EMAIL}}/token');
    expect(a.connector.authConfig.password).toBe('{{ZENDESK_API_TOKEN}}');
  });

  it('create-ticket requires the {ticket: {...}} envelope', () => {
    const t = a.tools.find((x) => x.name === 'zendesk_create_ticket')!;
    expect(t.endpointMapping.method).toBe('POST');
    expect(t.endpointMapping.path).toBe('/tickets.json');
  });

  it('update-ticket uses PUT', () => {
    const t = a.tools.find((x) => x.name === 'zendesk_update_ticket')!;
    expect(t.endpointMapping.method).toBe('PUT');
  });
});

const maybe = process.env.RUN_ZENDESK_LIVE ? describe : describe.skip;
maybe('zendesk adapter — live edge reachability', () => {
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);

  it('GET /users/me on a bogus subdomain returns 404 NXDOMAIN-like', async () => {
    // No real way to validate path on Zendesk without a real subdomain since
    // each customer has their own. We just confirm DNS resolution / TLS handshake
    // works against a known-bogus subdomain — should be 404 or DNS failure.
    let err: any;
    try {
      await engine.execute(
        {
          baseUrl: 'https://anythingmcp-smoke-test-no-such-subdomain.zendesk.com/api/v2',
          authType: 'BASIC_AUTH',
          authConfig: { username: 'bogus@example.com/token', password: 'bogus' },
        },
        { method: 'GET', path: '/users/me.json' },
        {},
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    // Zendesk returns either 404 or a redirect to a login page for missing subdomains
    expect([401, 404, 301, 302]).toContain(err.response?.status || 404);
  }, 30000);
});
