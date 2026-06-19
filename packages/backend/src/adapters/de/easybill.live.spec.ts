import * as adapter from './easybill.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Two layers of verification for the easybill adapter:
 *
 *   1. Static — always runs. Asserts the adapter targets the easybill REST API
 *      v1 (https://api.easybill.de/rest/v1), authenticates via Bearer token, and
 *      exposes the documented /customers, /documents and /positions paths.
 *
 *   2. Live — skipped in CI. Hits api.easybill.de with a bogus Bearer token to
 *      prove (a) the base URL resolves to easybill, (b) the endpoint exists
 *      (rejects with 401 "Wrong Authorization." rather than 404), and (c) the
 *      RestEngine injects the token as `Authorization: Bearer <key>`. easybill
 *      distinguishes "Wrong Authorization." (scheme recognised, credential bad)
 *      from "Wrong or missing Authorization header." (scheme not recognised),
 *      so a 401 with the former message proves the Bearer scheme is correct.
 *      A full data test needs a valid EASYBILL_API_KEY with API access enabled.
 *
 *   Run live with:  RUN_EASYBILL_LIVE=1 npx jest src/adapters/de/easybill.live.spec.ts
 */

describe('easybill adapter — static spec conformance', () => {
  const a = adapter as unknown as {
    connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
    tools: Array<{ name: string; endpointMapping: { method: string; path: string } }>;
  };

  it('targets the easybill REST API v1 base URL', () => {
    expect(a.connector.baseUrl).toBe('https://api.easybill.de/rest/v1');
  });

  it('authenticates via Bearer token (Authorization: Bearer <key>)', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{EASYBILL_API_KEY}}');
  });

  it('exposes the documented customers, documents and positions paths', () => {
    const paths = a.tools.map((t) => t.endpointMapping.path);
    expect(paths).toContain('/customers');
    expect(paths).toContain('/customers/{id}');
    expect(paths).toContain('/documents');
    expect(paths).toContain('/documents/{id}');
    expect(paths).toContain('/documents/{id}/pdf');
    expect(paths).toContain('/positions');
  });

  it('prefixes every tool name with easybill_', () => {
    for (const tool of a.tools) {
      expect(tool.name.startsWith('easybill_')).toBe(true);
    }
  });
});

const maybe = process.env.RUN_EASYBILL_LIVE ? describe : describe.skip;

maybe('easybill adapter — live edge reachability', () => {
  const oauth = {} as unknown as OAuth2TokenService;
  const login = {} as unknown as LoginTokenService;
  const engine = new RestEngine(oauth, login);

  const baseUrl = 'https://api.easybill.de/rest/v1';

  it('reaches easybill and rejects a bogus Bearer token with 401 (endpoint exists)', async () => {
    let err: any;
    try {
      await engine.execute(
        {
          baseUrl,
          authType: 'BEARER_TOKEN',
          authConfig: { token: 'bogus-token-for-test' },
        },
        { method: 'GET', path: '/customers', queryParams: { limit: '$limit' } },
        { limit: 1 },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    // 401 (not 404) proves the path exists and auth is enforced. The
    // "Wrong Authorization." message proves the Bearer scheme is recognised.
    expect(err.response?.status).toBe(401);
    expect(JSON.stringify(err.response?.data || '')).toContain('Wrong Authorization');
  }, 30000);

  it('RestEngine injects the token as Authorization: Bearer', async () => {
    let err: any;
    try {
      await engine.execute(
        {
          baseUrl,
          authType: 'BEARER_TOKEN',
          authConfig: { token: 'sentinel-token-12345' },
        },
        { method: 'GET', path: '/customers' },
        {},
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const sentHeaders = err.config?.headers || {};
    expect(sentHeaders.Authorization).toBe('Bearer sentinel-token-12345');
  }, 30000);
});
