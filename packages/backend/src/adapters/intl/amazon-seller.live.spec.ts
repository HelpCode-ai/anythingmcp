import * as adapter from './amazon-seller.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Two layers of verification for the amazon-seller (SP-API) adapter:
 *
 *   1. Static — always runs. Asserts the LWA OAuth2 wiring (token endpoint,
 *      refresh_token grant, x-amz-access-token header), that every tool
 *      targets a current SP-API version path, that the marketplace id is
 *      env-injected (never a model-supplied parameter), and that the
 *      three-step Reports flow is complete.
 *
 *   2. Live — skipped in CI. With real credentials (a private, self-authorized
 *      Seller Central app) it performs the LWA refresh_token exchange and
 *      calls getMarketplaceParticipations against the STATIC SANDBOX,
 *      proving the whole chain: token exchange → x-amz-access-token header →
 *      SP-API 200.
 *
 *   Run live with:
 *     RUN_SPAPI_LIVE=1 SPAPI_CLIENT_ID=… SPAPI_CLIENT_SECRET=… \
 *     SPAPI_REFRESH_TOKEN=… \
 *     npx jest src/adapters/intl/amazon-seller.live.spec.ts
 */

interface Tool {
  name: string;
  parameters: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    staticResponse?: string;
  };
}

const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
  };
  tools: Tool[];
};

const httpTools = () =>
  a.tools.filter((t) => t.endpointMapping.method !== 'static');

describe('amazon-seller adapter — static spec conformance', () => {
  it('authenticates via LWA OAuth2 refresh_token into x-amz-access-token', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig.grant).toBe('refresh_token');
    expect(a.connector.authConfig.tokenUrl).toBe(
      'https://api.amazon.com/auth/o2/token',
    );
    // SP-API does NOT read Authorization: Bearer — the access token must go
    // into the x-amz-access-token header.
    expect(a.connector.authConfig.headerName).toBe('x-amz-access-token');
    expect(a.connector.authConfig.clientId).toBe('{{SPAPI_CLIENT_ID}}');
    expect(a.connector.authConfig.clientSecret).toBe('{{SPAPI_CLIENT_SECRET}}');
    expect(a.connector.authConfig.refreshToken).toBe('{{SPAPI_REFRESH_TOKEN}}');
  });

  it('base URL is the env-selected regional endpoint', () => {
    expect(a.connector.baseUrl).toBe('{{SPAPI_ENDPOINT}}');
    expect(a.requiredEnvVars).toEqual(
      expect.arrayContaining([
        'SPAPI_CLIENT_ID',
        'SPAPI_CLIENT_SECRET',
        'SPAPI_REFRESH_TOKEN',
        'SPAPI_ENDPOINT',
        'SPAPI_MARKETPLACE_ID',
      ]),
    );
  });

  it('every HTTP tool targets a current SP-API versioned path', () => {
    const versioned =
      /^\/(sellers\/v1|orders\/v0|catalog\/2022-04-01|fba\/inventory\/v1|products\/(pricing|fees)\/v0|finances\/v0|listings\/2021-08-01|reports\/2021-06-30)\//;
    for (const t of httpTools()) {
      if (!versioned.test(t.endpointMapping.path)) {
        throw new Error(
          `${t.name} targets an unexpected path: ${t.endpointMapping.path}`,
        );
      }
    }
  });

  it('marketplace id is env-injected, never a model-supplied parameter', () => {
    for (const t of a.tools) {
      const props = Object.keys(t.parameters.properties ?? {});
      // No tool may ask the model for a marketplace id — it comes from
      // SPAPI_MARKETPLACE_ID via {{…}} interpolation.
      expect(props.join(',')).not.toMatch(/marketplace/i);
      const mapping = JSON.stringify(t.endpointMapping);
      if (/[Mm]arketplaceIds?"/.test(mapping)) {
        expect(mapping).toContain('{{SPAPI_MARKETPLACE_ID}}');
      }
    }
  });

  it('seller id for listings is env-injected in the path', () => {
    const listings = a.tools.find((t) => t.name === 'amazon_get_listings_item')!;
    expect(listings.endpointMapping.path).toBe(
      '/listings/2021-08-01/items/{{SPAPI_SELLER_ID}}/{sku}',
    );
    expect(Object.keys(listings.parameters.properties ?? {})).not.toContain(
      'sellerId',
    );
  });

  it('reports flow is complete: create → status → document', () => {
    const names = a.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'amazon_create_report',
        'amazon_get_report',
        'amazon_get_report_document',
      ]),
    );
    const create = a.tools.find((t) => t.name === 'amazon_create_report')!;
    expect(create.endpointMapping.method).toBe('POST');
    expect(JSON.stringify(create.endpointMapping.bodyMapping)).toContain(
      '{{SPAPI_MARKETPLACE_ID}}',
    );
  });

  it('ships a no-parameter smoke-test tool (marketplaceParticipations)', () => {
    const smoke = a.tools.find(
      (t) => t.name === 'amazon_marketplace_participations',
    )!;
    expect(smoke.endpointMapping.method).toBe('GET');
    expect(smoke.endpointMapping.path).toBe('/sellers/v1/marketplaceParticipations');
    expect(Object.keys(smoke.parameters.properties ?? {})).toHaveLength(0);
  });

  it('static marketplace-ids reference covers the three regions', () => {
    const ref = a.tools.find((t) => t.name === 'amazon_marketplace_ids')!;
    expect(ref.endpointMapping.method).toBe('static');
    const text = ref.endpointMapping.staticResponse ?? '';
    expect(text).toContain('sellingpartnerapi-eu.amazon.com');
    expect(text).toContain('sellingpartnerapi-na.amazon.com');
    expect(text).toContain('sellingpartnerapi-fe.amazon.com');
    expect(text).toContain('ATVPDKIKX0DER'); // US
    expect(text).toContain('A1PA6795UKMFR9'); // DE
  });
});

const maybe = process.env.RUN_SPAPI_LIVE ? describe : describe.skip;

maybe('amazon-seller adapter — live sandbox reachability', () => {
  const SANDBOX = 'https://sandbox.sellingpartnerapi-eu.amazon.com';

  async function lwaExchange(): Promise<string> {
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: process.env.SPAPI_REFRESH_TOKEN!,
        client_id: process.env.SPAPI_CLIENT_ID!,
        client_secret: process.env.SPAPI_CLIENT_SECRET!,
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { access_token: string };
    expect(data.access_token).toBeTruthy();
    return data.access_token;
  }

  it('LWA exchange succeeds and the sandbox accepts x-amz-access-token', async () => {
    const accessToken = await lwaExchange();

    // Stub the token service so the engine injects OUR token — this exercises
    // the real header-injection path (headerName: x-amz-access-token).
    const oauth = {
      getAccessToken: async () => accessToken,
      refreshToken: async () => accessToken,
    } as unknown as OAuth2TokenService;
    const login = {} as unknown as LoginTokenService;
    const engine = new RestEngine(oauth, login);

    const smoke = a.tools.find(
      (t) => t.name === 'amazon_marketplace_participations',
    )!;
    const result = (await engine.execute(
      {
        baseUrl: SANDBOX,
        authType: 'OAUTH2',
        authConfig: { ...a.connector.authConfig },
      },
      smoke.endpointMapping,
      {},
    )) as { payload: unknown[] };

    expect(Array.isArray(result.payload)).toBe(true);
    expect(result.payload.length).toBeGreaterThan(0);
  }, 30000);

  it('rejects a bogus token with 403 (endpoint recognised, auth enforced)', async () => {
    const oauth = {
      getAccessToken: async () => 'bogus-token-for-endpoint-validation',
    } as unknown as OAuth2TokenService;
    const login = {} as unknown as LoginTokenService;
    const engine = new RestEngine(oauth, login);

    let err: any;
    try {
      await engine.execute(
        {
          baseUrl: SANDBOX,
          authType: 'OAUTH2',
          // No refreshToken here: a 401/403 must surface, not trigger refresh.
          authConfig: { headerName: 'x-amz-access-token' },
        },
        { method: 'GET', path: '/sellers/v1/marketplaceParticipations' },
        {},
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect([401, 403]).toContain(err.response?.status);
    // Prove the token went into the SP-API header, not Authorization.
    expect(err.config?.headers['x-amz-access-token']).toBe(
      'bogus-token-for-endpoint-validation',
    );
    expect(err.config?.headers.Authorization).toBeUndefined();
  }, 30000);
});
