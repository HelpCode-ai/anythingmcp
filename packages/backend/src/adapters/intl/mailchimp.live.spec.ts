import * as adapter from './mailchimp.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Static + live verification for the Mailchimp adapter.
 *
 * Live test points at us1 (a real, generic Mailchimp datacenter) with a bogus
 * key — expects 401 from Mailchimp's edge, proving the path is recognized.
 *
 * Run live with:  RUN_MAILCHIMP_LIVE=1 npx jest src/adapters/intl/mailchimp.live.spec.ts
 */

interface Tool {
  name: string;
  endpointMapping: { method: string; path: string };
}

const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};

describe('mailchimp adapter — static spec conformance', () => {
  it('embeds the datacenter as a {{MAILCHIMP_DC}} placeholder in baseUrl', () => {
    expect(a.connector.baseUrl).toContain('{{MAILCHIMP_DC}}');
    expect(a.connector.baseUrl).toContain('api.mailchimp.com/3.0');
  });

  it('authenticates via Bearer token from MAILCHIMP_API_KEY', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{MAILCHIMP_API_KEY}}');
  });

  it('upsert-member tool uses PUT (the idempotent upsert verb)', () => {
    const upsert = a.tools.find((t) => t.name === 'mailchimp_upsert_member')!;
    expect(upsert.endpointMapping.method).toBe('PUT');
    expect(upsert.endpointMapping.path).toBe('/lists/{listId}/members/{subscriberHash}');
  });

  it('delete-member-permanently uses the actions/delete-permanent path (not DELETE /members)', () => {
    const del = a.tools.find((t) => t.name === 'mailchimp_delete_member_permanently')!;
    expect(del.endpointMapping.method).toBe('POST');
    expect(del.endpointMapping.path).toBe(
      '/lists/{listId}/members/{subscriberHash}/actions/delete-permanent',
    );
  });

  it('send-campaign hits actions/send (not just POST /campaigns/{id})', () => {
    const send = a.tools.find((t) => t.name === 'mailchimp_send_campaign')!;
    expect(send.endpointMapping.method).toBe('POST');
    expect(send.endpointMapping.path).toBe('/campaigns/{campaignId}/actions/send');
  });
});

const maybe = process.env.RUN_MAILCHIMP_LIVE ? describe : describe.skip;

maybe('mailchimp adapter — live edge reachability', () => {
  const oauth = {} as unknown as OAuth2TokenService;
  const login = {} as unknown as LoginTokenService;
  const engine = new RestEngine(oauth, login);
  const baseUrl = 'https://us1.api.mailchimp.com/3.0';

  it('GET /ping reaches Mailchimp edge (401 with bogus token)', async () => {
    let err: any;
    try {
      await engine.execute(
        { baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: 'bogus-key-us1' } },
        { method: 'GET', path: '/ping' },
        {},
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.response?.status).toBe(401);
  }, 30000);

  it('GET / reaches Mailchimp edge', async () => {
    let err: any;
    try {
      await engine.execute(
        { baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: 'bogus-key-us1' } },
        { method: 'GET', path: '/' },
        {},
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.response?.status).toBe(401);
  }, 30000);
});
