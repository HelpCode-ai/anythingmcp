import * as adapter from './weclapp.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Two layers of verification for the weclapp adapter:
 *
 *   1. Static — always runs. Asserts the adapter is on API v2 and that the
 *      paths/auth match the official OpenAPI v2 spec at
 *      https://www.weclapp.com/api/openapi_v2.yaml. Catches the most common
 *      failure mode: someone pinning back to v1 (legacy) or re-introducing the
 *      `/customer` endpoint that v2 replaced with `/party`.
 *
 *   2. Live — skipped in CI. Hits weclapp's edge against a non-existent tenant
 *      to prove the URL pattern resolves to weclapp infrastructure (DNS +
 *      Akamai + ALB + `server: weclapp`). A real end-to-end test needs a tenant
 *      with a valid token; weclapp does not offer a public sandbox.
 *
 *   Run live with:  RUN_WECLAPP_LIVE=1 npx jest src/adapters/de/weclapp.live.spec.ts
 */

describe('weclapp adapter — static spec conformance', () => {
  const a = adapter as unknown as {
    connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
    tools: Array<{ name: string; endpointMapping: { method: string; path: string } }>;
  };

  it('uses API v2 (v1 is legacy and being deprecated)', () => {
    expect(a.connector.baseUrl).toContain('/webapp/api/v2');
    expect(a.connector.baseUrl).not.toContain('/webapp/api/v1');
  });

  it('authenticates via the AuthenticationToken header (weclapp-specific, not Authorization)', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('AuthenticationToken');
  });

  it('does not reference /customer (renamed to /party in v2)', () => {
    for (const tool of a.tools) {
      expect(tool.endpointMapping.path).not.toMatch(/^\/customer(\/|$)/);
    }
  });

  it('uses the /party, /salesOrder, /salesInvoice, /article paths from the v2 spec', () => {
    const paths = a.tools.map((t) => t.endpointMapping.path);
    expect(paths).toContain('/party');
    expect(paths).toContain('/party/id/{partyId}');
    expect(paths).toContain('/salesOrder');
    expect(paths).toContain('/salesInvoice');
    expect(paths).toContain('/article');
    expect(paths).toContain('/article/id/{articleId}');
  });
});

const maybe = process.env.RUN_WECLAPP_LIVE ? describe : describe.skip;

maybe('weclapp adapter — live edge reachability', () => {
  const oauth = {} as unknown as OAuth2TokenService;
  const login = {} as unknown as LoginTokenService;
  const engine = new RestEngine(oauth, login);

  // Bogus tenant: weclapp uses wildcard DNS (*.weclapp.com → Akamai → ALB),
  // so the request reaches weclapp's edge but the ALB returns 404 because
  // no tenant matches. That 404 with `server: weclapp` proves the baseUrl
  // resolves to weclapp infrastructure.
  const baseUrl = 'https://anythingmcp-smoke-test-tenant.weclapp.com/webapp/api/v2';

  it('reaches weclapp edge (404 from server: weclapp) when calling /party with a bogus tenant', async () => {
    let err: any;
    try {
      await engine.execute(
        {
          baseUrl,
          authType: 'API_KEY',
          authConfig: { headerName: 'AuthenticationToken', apiKey: 'bogus-token-for-test' },
        },
        { method: 'GET', path: '/party', queryParams: { pageSize: '$pageSize' } },
        { pageSize: 1 },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.response?.status).toBe(404);
    // The `server` response header proves we hit weclapp's edge, not a generic
    // CDN/error. If this ever fails, the baseUrl pattern probably changed.
    expect(String(err.response?.headers?.server || '').toLowerCase()).toContain('weclapp');
  }, 30000);

  it('AuthenticationToken header is actually injected by RestEngine', async () => {
    // Round-trip the engine and inspect the outgoing request via the AxiosError.
    // The error config carries the headers we sent — proves the API_KEY branch
    // wrote to `AuthenticationToken`, not `X-API-Key` or `Authorization`.
    let err: any;
    try {
      await engine.execute(
        {
          baseUrl,
          authType: 'API_KEY',
          authConfig: { headerName: 'AuthenticationToken', apiKey: 'sentinel-token-12345' },
        },
        { method: 'GET', path: '/party' },
        {},
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const sentHeaders = err.config?.headers || {};
    expect(sentHeaders.AuthenticationToken).toBe('sentinel-token-12345');
    expect(sentHeaders.Authorization).toBeUndefined();
  }, 30000);
});
