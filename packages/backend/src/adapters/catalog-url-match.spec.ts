import { hostPattern, matchCatalogUrl, UrlMatchCandidate, URL_MATCH_MAX } from './catalog-url-match';
import { getAdapter, listAdapters } from './catalog';

const candidate = (slug: string, baseUrl: string, toolCount = 5): UrlMatchCandidate => ({
  slug,
  name: slug,
  icon: slug,
  description: '',
  toolCount,
  baseUrl,
});

describe('hostPattern', () => {
  it('keeps a fixed host as it is, without www', () => {
    expect(hostPattern('https://www.example.com/api/v1')).toMatchObject({
      exact: 'example.com',
      path: '/api/v1',
    });
  });

  it('turns a variable label into a wildcard while a domain is left', () => {
    const p = hostPattern('https://{{SHOP}}.myshopify.com/admin/api/2025-01');
    expect(p?.exact).toBeNull();
    expect(p?.regex?.test('acme.myshopify.com')).toBe(true);
    expect(p?.regex?.test('myshopify.com.evil.io')).toBe(false);
  });

  it('matches nothing when the host is only a variable', () => {
    expect(hostPattern('{{ODOO_URL}}')).toBeNull();
    expect(hostPattern('https://{{HOST}}/api')).toBeNull();
  });

  it('cuts the base path at its first variable', () => {
    expect(hostPattern('https://api.example.com/v1/{{ACCOUNT}}/items')?.path).toBe('/v1');
  });
});

describe('matchCatalogUrl', () => {
  const list = [
    candidate('graph-a', 'https://graph.example.com/v1/ads', 18),
    candidate('graph-b', 'https://graph.example.com/v1', 20),
    candidate('shop', 'https://{{SHOP}}.shop.example.com', 12),
    candidate('other', 'https://api.other.com', 3),
  ];

  it('accepts a URL typed without a scheme', () => {
    expect(matchCatalogUrl('api.other.com/v2', list).map((m) => m.slug)).toEqual(['other']);
  });

  it('keeps only the adapters whose base path the URL starts with, when any', () => {
    expect(matchCatalogUrl('https://graph.example.com/v1/ads/123', list).map((m) => m.slug)).toEqual([
      'graph-a',
      'graph-b',
    ]);
  });

  it('lists every adapter on the host when no base path fits, most tools first', () => {
    expect(matchCatalogUrl('https://graph.example.com/v9', list).map((m) => m.slug)).toEqual([
      'graph-b',
      'graph-a',
    ]);
  });

  it('matches a tenant host against a variable label', () => {
    expect(matchCatalogUrl('https://acme.shop.example.com/x', list).map((m) => m.slug)).toEqual(['shop']);
  });

  it('returns nothing for junk, local hosts and unknown APIs', () => {
    expect(matchCatalogUrl('', list)).toEqual([]);
    expect(matchCatalogUrl('not a url', list)).toEqual([]);
    expect(matchCatalogUrl('http://localhost:8080', list)).toEqual([]);
    expect(matchCatalogUrl('ftp://api.other.com', list)).toEqual([]);
    expect(matchCatalogUrl('https://api.unknown.dev', list)).toEqual([]);
  });

  it('never returns more than the cap', () => {
    const many = Array.from({ length: 12 }, (_, i) => candidate(`a${i}`, 'https://same.example.com'));
    expect(matchCatalogUrl('https://same.example.com', many)).toHaveLength(URL_MATCH_MAX);
  });
});

describe('matchCatalogUrl on the real catalog', () => {
  const catalog: UrlMatchCandidate[] = listAdapters()
    .filter((a) => !getAdapter(a.slug)?.unlisted)
    .map((a) => ({
      slug: a.slug,
      name: a.name,
      icon: a.icon,
      description: a.description,
      toolCount: a.toolCount,
      baseUrl: getAdapter(a.slug)!.connector.baseUrl,
    }));
  const slugsFor = (url: string) => matchCatalogUrl(url, catalog).map((m) => m.slug);

  // Base URLs of custom connectors users built by hand on the Cloud in
  // October 2026, for APIs the catalog already covered.
  it.each([
    ['https://api-v2.fattureincloud.it', 'fatture-in-cloud'],
    ['https://api.printify.com/v1', 'printify'],
    ['https://api.printful.com', 'printful'],
    ['https://api.pinterest.com/v5', 'pinterest'],
    ['https://cloud-api.yandex.net/v1/disk', 'yandex-disk'],
    ['https://openapi.etsy.com/v3', 'etsy'],
    ['https://api.telegram.org/file/bot{{TELEGRAM_BOT_TOKEN}}', 'telegram-bot'],
  ])('offers the catalog connector for %s', (url, slug) => {
    expect(slugsFor(url)).toContain(slug);
  });
});
