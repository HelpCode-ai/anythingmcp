import * as adapter from './calendly.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/** Live: RUN_CALENDLY_LIVE=1 npx jest src/adapters/intl/calendly.live.spec.ts */

interface Tool { name: string; endpointMapping: { method: string; path: string } }
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};

describe('calendly adapter — static spec conformance', () => {
  it('uses api.calendly.com base URL', () => {
    expect(a.connector.baseUrl).toBe('https://api.calendly.com');
  });
  it('Bearer auth', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{CALENDLY_PERSONAL_ACCESS_TOKEN}}');
  });
  it('cancel uses POST (not DELETE)', () => {
    const t = a.tools.find((x) => x.name === 'calendly_cancel_scheduled_event')!;
    expect(t.endpointMapping.method).toBe('POST');
    expect(t.endpointMapping.path).toBe('/scheduled_events/{eventUuid}/cancellation');
  });
  it('single-use link uses POST /scheduling_links', () => {
    const t = a.tools.find((x) => x.name === 'calendly_create_single_use_scheduling_link')!;
    expect(t.endpointMapping.method).toBe('POST');
    expect(t.endpointMapping.path).toBe('/scheduling_links');
  });
});

const maybe = process.env.RUN_CALENDLY_LIVE ? describe : describe.skip;
maybe('calendly adapter — live edge reachability', () => {
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  it('GET /users/me reaches Calendly edge (401)', async () => {
    let err: any;
    try {
      await engine.execute(
        { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: 'bogus' } },
        { method: 'GET', path: '/users/me' },
        {},
      );
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.response?.status).toBe(401);
  }, 30000);
});
