import * as adapter from './getmyinvoices.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Two layers of verification for the GetMyInvoices adapter:
 *
 *   1. Static — always runs. Asserts the adapter targets the v3 Accounts API
 *      (https://api.getmyinvoices.com/accounts/v3), authenticates via the
 *      X-API-KEY header, exposes the documented /documents and /companies paths,
 *      and keeps the date-format note on updatedOrNewSinceFilter (a regression
 *      guard for a real bug: the API rejects a plain date with HTTP 422 and
 *      requires 'Y-m-d H:i:s', confirmed live against a real account).
 *
 *   2. Live — skipped in CI. This API was verified end-to-end with a real key:
 *      GET /documents returns the {records,totalCount,maxPages,maxAmount,offset}
 *      envelope and GET /companies returns a bare array. The unauthenticated
 *      probe here uses a bogus key to prove the base URL + X-API-KEY scheme are
 *      correct without needing a secret in CI: a bogus key yields 403
 *      "API Key does not exist" (not 404), proving the endpoint + auth wiring.
 *
 *   Run live with:  RUN_GETMYINVOICES_LIVE=1 npx jest src/adapters/de/getmyinvoices.live.spec.ts
 */

describe('getmyinvoices adapter — static spec conformance', () => {
  const a = adapter as unknown as {
    connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
    tools: Array<{
      name: string;
      endpointMapping: { method: string; path: string };
      parameters?: { properties?: Record<string, { description?: string }> };
    }>;
  };

  it('targets the GetMyInvoices Accounts API v3 base URL', () => {
    expect(a.connector.baseUrl).toBe('https://api.getmyinvoices.com/accounts/v3');
  });

  it('authenticates via the X-API-KEY header (not query, not Bearer)', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('X-API-KEY');
    expect(a.connector.authConfig.apiKey).toBe('{{GETMYINVOICES_API_KEY}}');
  });

  it('exposes the documented documents and companies paths', () => {
    const paths = a.tools.map((t) => t.endpointMapping.path);
    expect(paths).toContain('/documents');
    expect(paths).toContain('/documents/{documentUid}');
    expect(paths).toContain('/documents/{documentUid}/attachments');
    expect(paths).toContain('/companies');
    expect(paths).toContain('/companies/{companyUid}');
  });

  it('keeps the Y-m-d H:i:s note on updatedOrNewSinceFilter (HTTP 422 regression guard)', () => {
    const list = a.tools.find((t) => t.name === 'getmyinvoices_list_documents');
    const desc =
      list?.parameters?.properties?.updatedOrNewSinceFilter?.description || '';
    // The API rejects a plain YYYY-MM-DD with 422; the description must steer
    // the agent to the full date-time format.
    expect(desc).toMatch(/YYYY-MM-DD HH:MM:SS/);
  });
});

const maybe = process.env.RUN_GETMYINVOICES_LIVE ? describe : describe.skip;

maybe('getmyinvoices adapter — live edge reachability', () => {
  const oauth = {} as unknown as OAuth2TokenService;
  const login = {} as unknown as LoginTokenService;
  const engine = new RestEngine(oauth, login);

  const baseUrl = 'https://api.getmyinvoices.com/accounts/v3';

  it('reaches GetMyInvoices and rejects a bogus key with 403 (endpoint exists)', async () => {
    let err: any;
    try {
      await engine.execute(
        {
          baseUrl,
          authType: 'API_KEY',
          authConfig: { headerName: 'X-API-KEY', apiKey: 'bogus-key-for-test' },
        },
        { method: 'GET', path: '/documents', queryParams: { perPage: '$perPage' } },
        { perPage: 1 },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    // 403 "API Key does not exist" (not 404) proves the path + X-API-KEY scheme.
    expect(err.response?.status).toBe(403);
    expect(JSON.stringify(err.response?.data || '')).toMatch(/API Key/i);
  }, 30000);

  it('RestEngine injects the key into the X-API-KEY header', async () => {
    let err: any;
    try {
      await engine.execute(
        {
          baseUrl,
          authType: 'API_KEY',
          authConfig: { headerName: 'X-API-KEY', apiKey: 'sentinel-key-12345' },
        },
        { method: 'GET', path: '/documents' },
        {},
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const sentHeaders = err.config?.headers || {};
    expect(sentHeaders['X-API-KEY']).toBe('sentinel-key-12345');
    expect(sentHeaders.Authorization).toBeUndefined();
  }, 30000);
});
