import * as adapter from './amazon-seller.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { validateDownloadConfig } from '../../connectors/engines/download-follow.util';

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
  enabled?: boolean;
  parameters: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
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
      /^\/(sellers\/v1|orders\/v0|catalog\/2022-04-01|fba\/inventory\/v1|products\/(pricing|fees)\/v0|finances\/(v0|2024-06-19)|listings\/2021-08-01|reports\/2021-06-30|solicitations\/v1|definitions\/2020-09-01)\//;
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

  it('keeps the original tool names and prefixes new ones with amazon_seller_', () => {
    const names = a.tools.map((t) => t.name);
    for (const name of [
      'amazon_marketplace_ids',
      'amazon_marketplace_participations',
      'amazon_list_orders',
      'amazon_get_order',
      'amazon_get_order_items',
      'amazon_search_catalog',
      'amazon_get_catalog_item',
      'amazon_fba_inventory',
      'amazon_get_item_offers',
      'amazon_get_fees_estimate',
      'amazon_list_financial_events',
      'amazon_get_listings_item',
      'amazon_create_report',
      'amazon_get_report',
      'amazon_get_report_document',
    ]) {
      expect(names).toContain(name);
    }
    expect(new Set(names).size).toBe(names.length);
    const added = names.slice(15);
    expect(added.length).toBeGreaterThan(0);
    for (const name of added) expect(name.startsWith('amazon_seller_')).toBe(true);
  });

  it('listings writes target the env seller id and encode the SKU', () => {
    for (const [name, method] of [
      ['amazon_seller_put_listings_item', 'PUT'],
      ['amazon_seller_patch_listings_item', 'PATCH'],
      ['amazon_seller_delete_listings_item', 'DELETE'],
    ] as const) {
      const t = a.tools.find((x) => x.name === name)!;
      expect(t.endpointMapping.method).toBe(method);
      expect(t.endpointMapping.path).toBe('/listings/2021-08-01/items/{{SPAPI_SELLER_ID}}/{sku}');
      expect(t.endpointMapping.encodePathParams).toBe(true);
      expect(t.endpointMapping.queryParams?.marketplaceIds).toBe('{{SPAPI_MARKETPLACE_ID}}');
    }
    const patch = a.tools.find((x) => x.name === 'amazon_seller_patch_listings_item')!;
    expect(patch.endpointMapping.bodyMapping).toEqual({ productType: '$productType', patches: '$patches' });
    const search = a.tools.find((x) => x.name === 'amazon_seller_search_listings_items')!;
    expect(search.endpointMapping.path).toBe('/listings/2021-08-01/items/{{SPAPI_SELLER_ID}}');
  });

  it('restrictions and product type definitions carry the env seller id', () => {
    const restrictions = a.tools.find((x) => x.name === 'amazon_seller_get_listing_restrictions')!;
    expect(restrictions.endpointMapping.path).toBe('/listings/2021-08-01/restrictions');
    expect(restrictions.endpointMapping.queryParams?.sellerId).toBe('{{SPAPI_SELLER_ID}}');
    const definition = a.tools.find((x) => x.name === 'amazon_seller_get_product_type_definition')!;
    expect(definition.endpointMapping.path).toBe('/definitions/2020-09-01/productTypes/{productType}');
  });

  it('review requests use the Solicitations API and install switched off', () => {
    const actions = a.tools.find((x) => x.name === 'amazon_seller_get_solicitation_actions')!;
    expect(actions.endpointMapping.path).toBe('/solicitations/v1/orders/{amazonOrderId}');
    const request = a.tools.find((x) => x.name === 'amazon_seller_request_product_review')!;
    expect(request.endpointMapping.method).toBe('POST');
    expect(request.endpointMapping.path).toBe(
      '/solicitations/v1/orders/{amazonOrderId}/solicitations/productReviewAndSellerFeedback',
    );
    expect(request.enabled).toBe(false);
    expect(a.tools.find((x) => x.name === 'amazon_seller_delete_listings_item')!.enabled).toBe(false);
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

  it('downloads report documents on the server, only from Amazon hosts', () => {
    const t = a.tools.find((x) => x.name === 'amazon_seller_download_report_document')!;
    const em = t.endpointMapping as Tool['endpointMapping'] & {
      download?: { urlField: string; compressionField?: string; allowedHosts: string[] };
    };
    expect(em.path).toBe('/reports/2021-06-30/documents/{reportDocumentId}');
    expect(validateDownloadConfig(em.download)).toBeNull();
    expect(em.download?.urlField).toBe('url');
    expect(em.download?.compressionField).toBe('compressionAlgorithm');
    expect(em.download?.allowedHosts).toEqual(['amazonaws.com']);
    for (const ref of ['offset', 'limit', 'columns', 'filterColumn', 'filterValue']) {
      expect(Object.keys(t.parameters.properties ?? {})).toContain(ref);
    }
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

describe('amazon_get_item_offers ItemCondition', () => {
  it('defaults itemCondition to New, since Amazon requires one', () => {
    const tool = (adapter as unknown as {
      tools: { name: string; parameters: { properties: Record<string, { default?: string }> } }[];
    }).tools.find((t) => t.name === 'amazon_get_item_offers')!;
    expect(tool.parameters.properties.itemCondition.default).toBe('New');
  });
});
