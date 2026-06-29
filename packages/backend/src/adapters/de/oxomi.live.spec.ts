import * as adapter from './oxomi.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Two layers of verification for the Oxomi adapter:
 *
 *   1. Static — always runs. Guards the rewrite to the OFFICIAL Public API
 *      (`/portals/api/...`). Catches regressions to the deprecated
 *      `/service/json` frontend API (sunset 2026-12-31) and to the previous
 *      adapter's hallucinated paths (`/catalog/search`, `/product/search`,
 *      `/document/search`, `/product/cross-selling`) and wrong auth param name
 *      (`portalId` instead of the API's `portal`). Auth is QUERY_AUTH —
 *      portal/user/accessToken go in the query string (verified live).
 *
 *   2. Live — skipped unless RUN_OXOMI_LIVE is set AND OXOMI_PORTAL_ID /
 *      OXOMI_ACCESS_TOKEN are provided. Hits the real Public API to prove the
 *      base URL + query-string auth resolve and the endpoints return success.
 *      (For a public portal the read endpoints return 200 even with a weak
 *      token; permission-gated blocks like product-search may return 403.)
 *
 *   Run live with:
 *     RUN_OXOMI_LIVE=1 OXOMI_PORTAL_ID=3001049 OXOMI_USER= OXOMI_ACCESS_TOKEN=xxx \
 *       npx jest src/adapters/de/oxomi.live.spec.ts
 */

describe('oxomi adapter — static spec conformance', () => {
  const a = adapter as unknown as {
    connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
    tools: Array<{
      name: string;
      endpointMapping: { method: string; path: string };
    }>;
  };

  it('targets the official Oxomi Public API host', () => {
    expect(a.connector.baseUrl).toBe('https://oxomi.com');
  });

  it('authenticates via QUERY_AUTH using portal/user/accessToken (NOT portalId)', () => {
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig.portal).toBe('{{OXOMI_PORTAL_ID}}');
    expect(a.connector.authConfig.user).toBe('{{OXOMI_USER}}');
    expect(a.connector.authConfig.accessToken).toBe('{{OXOMI_ACCESS_TOKEN}}');
    // regression: the old adapter sent the portal id under the wrong key.
    expect(a.connector.authConfig.portalId).toBeUndefined();
  });

  it('only uses /portals/api/ paths — never the deprecated /service/json API', () => {
    for (const tool of a.tools) {
      expect(tool.endpointMapping.path.startsWith('/portals/api/')).toBe(true);
      expect(tool.endpointMapping.path).not.toContain('/service/json');
    }
  });

  it('does not reference the previous adapter hallucinated paths', () => {
    const paths = a.tools.map((t) => t.endpointMapping.path);
    for (const bad of [
      '/catalog/search',
      '/catalog/pages',
      '/catalog/attachments',
      '/product/search',
      '/product/attachments',
      '/product/cross-selling',
      '/document/search',
    ]) {
      expect(paths).not.toContain(bad);
    }
  });

  it('maps the verified Public API endpoints with correct methods', () => {
    const byName = Object.fromEntries(
      a.tools.map((t) => [t.name, t.endpointMapping]),
    );
    expect(byName['oxomi_get_product_data']).toMatchObject({
      method: 'POST',
      path: '/portals/api/v2/product/data',
    });
    expect(byName['oxomi_search_products']).toMatchObject({
      method: 'POST',
      path: '/portals/api/v2/products/search',
    });
    expect(byName['oxomi_resolve_gtin']).toMatchObject({
      method: 'GET',
      path: '/portals/api/v1/products/resolve-gtin',
    });
    expect(byName['oxomi_get_brand_info']).toMatchObject({
      method: 'GET',
      path: '/portals/api/v1/brand/info',
    });
    expect(byName['oxomi_list_documents']).toMatchObject({
      method: 'GET',
      path: '/portals/api/v1/documents',
    });
  });

  it('injects OXOMI_API_TOKEN only on the product-sync tools', () => {
    const syncTools = a.tools.filter((t) =>
      t.endpointMapping.path.includes('/products/changed') ||
      t.endpointMapping.path.includes('/products/spx') ||
      t.endpointMapping.path.includes('/core/update-sync-date'),
    );
    expect(syncTools.length).toBe(3);
    for (const t of syncTools) {
      const qp = (t.endpointMapping as { queryParams?: Record<string, string> }).queryParams || {};
      expect(qp.apiToken).toBe('$OXOMI_API_TOKEN');
    }
  });

  it('prefixes every tool name with oxomi_', () => {
    for (const tool of a.tools) {
      expect(tool.name.startsWith('oxomi_')).toBe(true);
    }
  });
});

const live =
  process.env.RUN_OXOMI_LIVE && process.env.OXOMI_PORTAL_ID
    ? describe
    : describe.skip;

live('oxomi adapter — live Public API reachability', () => {
  const oauth = {} as unknown as OAuth2TokenService;
  const login = {} as unknown as LoginTokenService;
  const engine = new RestEngine(oauth, login);

  const config = {
    baseUrl: 'https://oxomi.com',
    authType: 'QUERY_AUTH',
    authConfig: {
      portal: process.env.OXOMI_PORTAL_ID as string,
      user: process.env.OXOMI_USER || '',
      accessToken: process.env.OXOMI_ACCESS_TOKEN || '',
    },
  };

  it('resolve-gtin reaches the Public API and accepts query-string auth', async () => {
    const res = (await engine.execute(
      config,
      {
        method: 'GET',
        path: '/portals/api/v1/products/resolve-gtin',
        queryParams: { gtin: '$gtin' },
      },
      { gtin: '4007123456789' },
    )) as { success?: boolean };
    expect(res).toBeDefined();
    expect(res.success).toBe(true);
  }, 30000);

  it('product/data resolves a request and returns a products array', async () => {
    const res = (await engine.execute(
      config,
      { method: 'POST', path: '/portals/api/v2/product/data', bodyMapping: { outputMode: 'BY_PRODUCT', queries: '$queries', products: [{ itemNumber: '$itemNumber', supplierNumber: '$supplierNumber' }] } },
      { itemNumber: '0/8509/000//525//01', supplierNumber: '700399', queries: ['base-info'] },
    )) as { success?: boolean; products?: unknown[] };
    expect(res).toBeDefined();
    expect(res.success).toBe(true);
    expect(Array.isArray(res.products)).toBe(true);
  }, 30000);
});
