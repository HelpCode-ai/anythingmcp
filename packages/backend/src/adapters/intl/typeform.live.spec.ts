import * as adapter from './typeform.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/** Live: RUN_TYPEFORM_LIVE=1 npx jest src/adapters/intl/typeform.live.spec.ts */

interface Tool { name: string; endpointMapping: { method: string; path: string } }
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};

describe('typeform adapter — static spec conformance', () => {
  it('uses api.typeform.com', () => {
    expect(a.connector.baseUrl).toBe('https://api.typeform.com');
  });
  it('Bearer auth', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{TYPEFORM_PERSONAL_TOKEN}}');
  });
  it('list-responses correctly nested under /forms/{formId}/responses', () => {
    const t = a.tools.find((x) => x.name === 'typeform_list_responses')!;
    expect(t.endpointMapping.path).toBe('/forms/{formId}/responses');
  });
});

const maybe = process.env.RUN_TYPEFORM_LIVE ? describe : describe.skip;
maybe('typeform adapter — live edge reachability', () => {
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);

  it('GET /me reaches Typeform edge (401)', async () => {
    let err: any;
    try {
      await engine.execute(
        { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: 'bogus' } },
        { method: 'GET', path: '/me' },
        {},
      );
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.response?.status).toBe(401);
  }, 30000);
});
