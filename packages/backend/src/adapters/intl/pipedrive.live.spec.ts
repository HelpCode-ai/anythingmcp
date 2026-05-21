import * as adapter from './pipedrive.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Two-tier verification (pattern: weclapp, whatsapp-business).
 *
 *  1. Static — always runs in CI. Asserts the adapter shape matches the
 *     Pipedrive REST conventions: mixed v1 + v2 base, QUERY_AUTH with
 *     api_token, expected paths for the discover-first tools.
 *
 *  2. Live — opt-in via RUN_PIPEDRIVE_LIVE=1. Hits api.pipedrive.com with a
 *     bogus api_token, asserts a 401 from Pipedrive's edge — proves the
 *     endpoint path is recognized.
 *
 * Run live with:
 *   RUN_PIPEDRIVE_LIVE=1 npx jest src/adapters/intl/pipedrive.live.spec.ts
 */

interface Tool {
  name: string;
  endpointMapping: { method: string; path: string };
}

const a = adapter as unknown as {
  slug: string;
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};

describe('pipedrive adapter — static spec conformance', () => {
  it('uses api.pipedrive.com as the base URL', () => {
    expect(a.connector.baseUrl).toBe('https://api.pipedrive.com');
  });

  it('authenticates via api_token in the query string (QUERY_AUTH)', () => {
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig.api_token).toBe('{{PIPEDRIVE_API_TOKEN}}');
  });

  it('uses v2 paths for deals/persons/organizations/activities/pipelines/stages', () => {
    const v2Tools = [
      'pipedrive_list_deals',
      'pipedrive_get_deal',
      'pipedrive_create_deal',
      'pipedrive_update_deal',
      'pipedrive_delete_deal',
      'pipedrive_search_deals',
      'pipedrive_list_persons',
      'pipedrive_get_person',
      'pipedrive_create_person',
      'pipedrive_update_person',
      'pipedrive_list_organizations',
      'pipedrive_create_organization',
      'pipedrive_list_activities',
      'pipedrive_create_activity',
      'pipedrive_list_pipelines',
      'pipedrive_list_stages',
    ];
    for (const name of v2Tools) {
      const tool = a.tools.find((t) => t.name === name);
      expect(tool).toBeDefined();
      expect(tool!.endpointMapping.path.startsWith('/api/v2/')).toBe(true);
    }
  });

  it('still uses v1 for itemSearch, users and field-discovery tools', () => {
    const v1Tools = [
      ['pipedrive_search', '/v1/itemSearch'],
      ['pipedrive_list_users', '/v1/users'],
      ['pipedrive_get_current_user', '/v1/users/me'],
      ['pipedrive_list_deal_fields', '/v1/dealFields'],
      ['pipedrive_list_person_fields', '/v1/personFields'],
      ['pipedrive_list_organization_fields', '/v1/organizationFields'],
    ];
    for (const [name, path] of v1Tools) {
      const tool = a.tools.find((t) => t.name === name);
      expect(tool).toBeDefined();
      expect(tool!.endpointMapping.path).toBe(path);
    }
  });

  it('uses PATCH (not PUT) for updates per Pipedrive v2 convention', () => {
    const update = a.tools.find((t) => t.name === 'pipedrive_update_deal')!;
    expect(update.endpointMapping.method).toBe('PATCH');
    const updatePerson = a.tools.find((t) => t.name === 'pipedrive_update_person')!;
    expect(updatePerson.endpointMapping.method).toBe('PATCH');
  });
});

const maybe = process.env.RUN_PIPEDRIVE_LIVE ? describe : describe.skip;

maybe('pipedrive adapter — live edge reachability', () => {
  const oauth = {} as unknown as OAuth2TokenService;
  const login = {} as unknown as LoginTokenService;
  const engine = new RestEngine(oauth, login);

  it('GET /v1/users/me reaches Pipedrive edge (401 with bogus token)', async () => {
    let err: any;
    try {
      await engine.execute(
        {
          baseUrl: a.connector.baseUrl,
          authType: 'QUERY_AUTH',
          authConfig: { api_token: 'bogus-token-for-endpoint-validation' },
        },
        { method: 'GET', path: '/v1/users/me' },
        {},
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.response?.status).toBe(401);
  }, 30000);

  it('GET /api/v2/deals reaches Pipedrive edge (401 with bogus token)', async () => {
    let err: any;
    try {
      await engine.execute(
        {
          baseUrl: a.connector.baseUrl,
          authType: 'QUERY_AUTH',
          authConfig: { api_token: 'bogus-token' },
        },
        { method: 'GET', path: '/api/v2/deals', queryParams: { limit: '$limit' } },
        { limit: 1 },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.response?.status).toBe(401);
  }, 30000);

  it('api_token is actually injected as a query string parameter', async () => {
    let err: any;
    try {
      await engine.execute(
        {
          baseUrl: a.connector.baseUrl,
          authType: 'QUERY_AUTH',
          authConfig: { api_token: 'sentinel-token-12345' },
        },
        { method: 'GET', path: '/v1/users/me' },
        {},
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.config?.params?.api_token).toBe('sentinel-token-12345');
  }, 30000);
});
