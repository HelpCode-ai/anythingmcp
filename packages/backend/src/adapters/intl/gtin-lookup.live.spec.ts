import * as adapter from './gtin-lookup.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Two layers of verification for the GTIN / Barcode Lookup adapter:
 *
 *   1. Static — always runs. Asserts the adapter is auth-free, that EVERY tool
 *      opts into the proxy/web-unblocker (useProxy:true) — these public barcode
 *      databases rate-limit per IP, so proxy routing is the whole point — and
 *      that the multi-host tools (UPCitemdb, Open Beauty Facts, Google Books)
 *      use absolute per-tool URLs while the Open Food Facts tools stay on the
 *      connector baseUrl.
 *
 *   2. Live — skipped unless RUN_GTIN_LIVE is set. Hits the real public APIs
 *      (no key needed) and asserts a known barcode resolves. May be flaky under
 *      the shared per-IP rate limits — that's exactly why the tools proxy.
 *
 *   Run live with:  RUN_GTIN_LIVE=1 npx jest src/adapters/intl/gtin-lookup.live.spec.ts
 */

describe('gtin-lookup adapter — static spec conformance', () => {
  const a = adapter as unknown as {
    connector: { baseUrl: string; authType: string };
    tools: Array<{
      name: string;
      useProxy?: boolean;
      endpointMapping: { method: string; path: string };
    }>;
  };

  it('requires no authentication (all sources are public)', () => {
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.baseUrl).toBe('https://world.openfoodfacts.org');
  });

  it('routes EVERY tool through the proxy / web-unblocker', () => {
    expect(a.tools.length).toBeGreaterThanOrEqual(6);
    for (const tool of a.tools) {
      expect(tool.useProxy).toBe(true);
    }
  });

  it('uses absolute per-tool URLs for the non-Open-Food-Facts sources', () => {
    const byName = Object.fromEntries(a.tools.map((t) => [t.name, t.endpointMapping.path]));
    expect(byName['gtin_lookup_retail']).toBe('https://api.upcitemdb.com/prod/trial/lookup');
    expect(byName['gtin_lookup_search_retail']).toBe('https://api.upcitemdb.com/prod/trial/search');
    expect(byName['gtin_lookup_beauty']).toContain('https://world.openbeautyfacts.org/');
    expect(byName['gtin_lookup_book']).toBe('https://www.googleapis.com/books/v1/volumes');
    // Open Food Facts tools stay on the connector baseUrl (relative paths).
    expect(byName['gtin_lookup_food']).toBe('/api/v2/product/{barcode}.json');
    expect(byName['gtin_lookup_search_food']).toBe('/cgi/search.pl');
  });

  it('prefixes every tool name with gtin_lookup_', () => {
    for (const tool of a.tools) {
      expect(tool.name.startsWith('gtin_lookup_')).toBe(true);
    }
  });
});

const live = process.env.RUN_GTIN_LIVE ? describe : describe.skip;

live('gtin-lookup adapter — live public API resolution', () => {
  const oauth = {} as unknown as OAuth2TokenService;
  const login = {} as unknown as LoginTokenService;
  const engine = new RestEngine(oauth, login);
  const config = { baseUrl: 'https://world.openfoodfacts.org', authType: 'NONE' };

  it('resolves a known food barcode via Open Food Facts (Nutella)', async () => {
    const res = (await engine.execute(
      config,
      {
        method: 'GET',
        path: '/api/v2/product/{barcode}.json',
        queryParams: { fields: 'code,product_name,brands' },
      },
      { barcode: '3017620422003' },
    )) as { status?: number; product?: { product_name?: string } };
    expect(res).toBeDefined();
    expect(res.status).toBe(1);
    expect(String(res.product?.product_name || '')).toMatch(/nutella/i);
  }, 30000);

  it('resolves a general retail barcode via UPCitemdb', async () => {
    const res = (await engine.execute(
      { baseUrl: 'https://api.upcitemdb.com', authType: 'NONE' },
      { method: 'GET', path: 'https://api.upcitemdb.com/prod/trial/lookup', queryParams: { upc: '$upc' } },
      { upc: '0049000028911' },
    )) as { code?: string; items?: unknown[] };
    expect(res).toBeDefined();
    expect(res.code).toBe('OK');
    expect(Array.isArray(res.items)).toBe(true);
    expect((res.items || []).length).toBeGreaterThan(0);
  }, 30000);
});
