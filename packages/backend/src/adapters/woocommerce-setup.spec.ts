import {
  discoverWooCommerce,
  egressWording,
  normalizeWooCommerceUrl,
  WOOCOMMERCE_CANNOT_VIEW_HINT,
  WOOCOMMERCE_UNKNOWN_KEY_HINT,
  wooCommerceAuthHint,
  wooCommerceCheckAdvice,
  wooCommerceSiteOf,
} from './woocommerce-setup';
import { outboundRequest } from '../common/outbound-http';
import { SsrfBlockedError } from '../common/ssrf.util';

jest.mock('../common/outbound-http', () => ({ outboundRequest: jest.fn() }));
const request = outboundRequest as jest.MockedFunction<typeof outboundRequest>;

const CLOUD = { cloud: true, egressIps: ['104.248.242.235'] };
const SELF = { cloud: false, egressIps: [] };

/** An HTTP answer as axios gives it with responseType text. */
const answer = (status: number, body: unknown, contentType = 'application/json') =>
  ({
    status,
    data: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': contentType },
  }) as any;

/** Answers by URL; anything else is a 404 page. */
function site(routes: Record<string, any>) {
  request.mockImplementation(async (config: any) => {
    for (const [prefix, value] of Object.entries(routes)) {
      if (String(config.url).startsWith(prefix)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    return answer(404, '<!DOCTYPE html><html><head><title>Page not found</title></head></html>', 'text/html');
  });
}

/** What wpbeginner.com answered on 11 Nov 2026 (shortened): home with www. */
const INDEX_WOO = { home: 'https://www.shop.example', namespaces: ['wp/v2', 'wc/v3', 'wc/v2', 'wc/v1'] };

describe('normalizeWooCommerceUrl', () => {
  it.each([
    ['shop.example.com', 'https://shop.example.com'],
    ['  https://shop.example.com/  ', 'https://shop.example.com'],
    ['http://shop.example.com', 'https://shop.example.com'],
    ['https://shop.example.com/wp-admin/admin.php?page=wc-settings&tab=advanced', 'https://shop.example.com'],
    ['https://shop.example.com/wp-json/wc/v3', 'https://shop.example.com'],
    ['https://shop.example.com/wp-json', 'https://shop.example.com'],
    ['https://shop.example.com/wp-login.php?redirect_to=x', 'https://shop.example.com'],
    ['https://Shop.Example.com/#top', 'https://shop.example.com'],
    ['https://example.com/shop/', 'https://example.com/shop'],
    ['https://example.com/shop/wp-admin/', 'https://example.com/shop'],
    ['https://example.com/index.php', 'https://example.com'],
    ['https://example.com/index.php/wp-json/wc/v3', 'https://example.com'],
    ['https://shop.example.com:8443/', 'https://shop.example.com:8443'],
  ])('%s → %s', (typed, expected) => {
    expect(normalizeWooCommerceUrl(typed)).toBe(expected);
  });

  it('leaves what is not an address alone', () => {
    expect(normalizeWooCommerceUrl('{{WOOCOMMERCE_URL}}')).toBe('{{WOOCOMMERCE_URL}}');
    expect(normalizeWooCommerceUrl('my shop')).toBe('my shop');
    expect(normalizeWooCommerceUrl('ftp://shop.example.com')).toBe('ftp://shop.example.com');
    expect(normalizeWooCommerceUrl('erp')).toBe('erp');
    expect(normalizeWooCommerceUrl('')).toBe('');
  });
});

describe('discoverWooCommerce', () => {
  beforeEach(() => request.mockReset());

  it('finds WooCommerce and corrects the address to WordPress\'s own (www)', async () => {
    site({ 'https://shop.example/wp-json/': answer(200, INDEX_WOO) });
    const found = await discoverWooCommerce('shop.example', CLOUD);
    expect(found).toMatchObject({
      woocommerce: true,
      home: 'https://www.shop.example',
      corrected: 'https://www.shop.example',
      message: 'WooCommerce answers at https://www.shop.example: that address is used.',
    });
    expect(found?.problem).toBeUndefined();
    // One unauthenticated GET for two fields, with a deadline, never a key.
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'https://shop.example/wp-json/?_fields=home,namespaces',
        timeout: 8000,
      }),
    );
    expect(JSON.stringify(request.mock.calls[0][0])).not.toMatch(/consumer_/);
  });

  it('says nothing to correct when the address is already WordPress\'s own', async () => {
    site({ 'https://www.shop.example/wp-json/': answer(200, INDEX_WOO) });
    const found = await discoverWooCommerce('https://www.shop.example/', CLOUD);
    expect(found).toEqual({ url: 'https://www.shop.example', home: 'https://www.shop.example', woocommerce: true });
  });

  it('names a WordPress without WooCommerce, and a WooCommerce older than 3.5', async () => {
    site({ 'https://blog.example/wp-json/': answer(200, { home: 'https://blog.example', namespaces: ['wp/v2', 'oembed/1.0'] }) });
    expect(await discoverWooCommerce('https://blog.example', SELF)).toMatchObject({
      woocommerce: false,
      problem: 'no_woocommerce',
      message: expect.stringContaining('WooCommerce is not active there'),
    });

    site({ 'https://old.example/wp-json/': answer(200, { home: 'https://old.example', namespaces: ['wp/v2', 'wc/v2', 'wc/v1'] }) });
    expect(await discoverWooCommerce('https://old.example', SELF)).toMatchObject({
      problem: 'woocommerce_too_old',
      message: expect.stringContaining('WooCommerce 3.5'),
    });
  });

  it('detects Plain permalinks, with the link to the setting, and stops before the key', async () => {
    site({ 'https://plain.example/?rest_route=/': answer(200, { home: 'https://plain.example', namespaces: ['wc/v3'] }) });
    const found = await discoverWooCommerce('https://plain.example', SELF);
    expect(found).toMatchObject({
      problem: 'plain_permalinks',
      final: true,
      fixUrl: 'https://plain.example/wp-admin/options-permalink.php',
    });
    expect(found?.message).toContain('Settings → Permalinks');
    expect(found?.message).toContain('"Post name"');
  });

  it('finds the site behind a page address (a product page, /shop) at the host\'s root', async () => {
    site({ 'https://shop.example/wp-json/': answer(200, { home: 'https://shop.example', namespaces: ['wc/v3'] }) });
    const found = await discoverWooCommerce('https://shop.example/shop/product/blue-shirt', SELF);
    expect(found).toMatchObject({ woocommerce: true, corrected: 'https://shop.example' });
    // Not mistaken for Plain permalinks (WordPress answers ?rest_route= on any page).
    expect(request.mock.calls.map((c: any) => c[0].url)).not.toContain(
      'https://shop.example/shop/product/blue-shirt/?rest_route=/&_fields=home,namespaces',
    );
  });

  it('keeps a real subfolder install', async () => {
    site({ 'https://example.com/shop/wp-json/': answer(200, { home: 'https://example.com/shop', namespaces: ['wc/v3'] }) });
    expect(await discoverWooCommerce('https://example.com/shop/wp-admin', SELF)).toEqual({
      url: 'https://example.com/shop',
      home: 'https://example.com/shop',
      woocommerce: true,
    });
  });

  it('names a Cloudflare challenge (as porterandyork.com answered), with the Cloud address', async () => {
    site({
      'https://cf.example/wp-json/': answer(
        403,
        '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/x"></script></body></html>',
        'text/html',
      ),
    });
    const found = await discoverWooCommerce('https://cf.example', CLOUD);
    expect(found?.problem).toBe('blocked');
    expect(found?.message).toContain('Cloudflare');
    expect(found?.message).toContain("AnythingMCP Cloud's address 104.248.242.235");
    expect(found?.final).toBeUndefined();
  });

  it('names Wordfence and, on self-hosted, the address of the AnythingMCP server', async () => {
    site({
      'https://wf.example/wp-json/': answer(
        403,
        '<html><head><title>Your access to this site has been limited</title></head><body>Generated by Wordfence</body></html>',
        'text/html',
      ),
    });
    const found = await discoverWooCommerce('https://wf.example', SELF);
    expect(found?.message).toContain('Wordfence on wf.example refused the request');
    expect(found?.message).toContain('the address of your AnythingMCP server');
    expect(found?.message).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it('tells a REST API limited to signed-in users apart from a firewall', async () => {
    site({
      'https://locked.example/wp-json/': answer(401, {
        code: 'rest_login_required',
        message: 'REST API restricted to authenticated users.',
        data: { status: 401 },
      }),
    });
    expect(await discoverWooCommerce('https://locked.example', SELF)).toMatchObject({
      problem: 'rest_restricted',
      message: expect.stringContaining('rest_login_required'),
    });
  });

  it('says a host name does not exist (the SSRF guard\'s lookup), and stops', async () => {
    site({
      'https://typo.example/': new SsrfBlockedError(
        "Host not found: 'typo.example' could not be resolved (ENOTFOUND). Check the address in the connector settings.",
      ),
    });
    expect(await discoverWooCommerce('https://typo.example', SELF)).toMatchObject({
      problem: 'dns',
      final: true,
      message: "No site answers at typo.example: that name does not exist. Check the spelling of the shop's address.",
    });
  });

  it('says nothing about an address the SSRF policy refuses (a private IP)', async () => {
    site({ 'https://10.0.0.5/': new SsrfBlockedError("SSRF guard: address '10.0.0.5' is not a public IP") });
    expect(await discoverWooCommerce('https://10.0.0.5', SELF)).toBeUndefined();
  });

  it('explains a shop that answers only over http', async () => {
    const tls = Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), {
      code: 'ECONNREFUSED',
    });
    site({
      'https://plainhttp.example/': tls,
      'http://plainhttp.example/wp-json/': answer(200, { home: 'http://plainhttp.example', namespaces: ['wc/v3'] }),
    });
    const found = await discoverWooCommerce('http://plainhttp.example', SELF);
    expect(found).toMatchObject({ problem: 'http_only', final: true });
    expect(found?.message).toContain('only over http://');
    expect(found?.message).toContain("Let's Encrypt");
  });

  it('explains an invalid certificate', async () => {
    site({
      'https://': Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }),
      'http://': Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    expect(await discoverWooCommerce('https://expired.example', SELF)).toMatchObject({
      problem: 'tls',
      final: true,
      message: expect.stringContaining('The certificate of expired.example is not valid (CERT_HAS_EXPIRED)'),
    });
  });

  it('reports a slow site without stopping the check', async () => {
    site({ 'https://slow.example/': Object.assign(new Error('timeout of 8000ms exceeded'), { code: 'ECONNABORTED' }) });
    const found = await discoverWooCommerce('https://slow.example', SELF);
    expect(found).toMatchObject({ problem: 'timeout' });
    expect(found?.final).toBeUndefined();
  });

  it('names an address where no WordPress answers (example.com answered a 404 page)', async () => {
    site({});
    expect(await discoverWooCommerce('https://example.org', SELF)).toMatchObject({
      problem: 'not_wordpress',
      message: expect.stringContaining('No WordPress REST API answered at https://example.org/wp-json/'),
    });
  });

  it('asks nothing for a value that is not an address', async () => {
    expect(await discoverWooCommerce('{{WOOCOMMERCE_URL}}', SELF)).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('egressWording', () => {
  it('names the fixed addresses when known, the server otherwise', () => {
    expect(egressWording(CLOUD)).toBe("AnythingMCP Cloud's address 104.248.242.235");
    expect(egressWording({ cloud: false, egressIps: ['1.2.3.4', '5.6.7.8'] })).toBe(
      "this AnythingMCP server's addresses 1.2.3.4 and 5.6.7.8",
    );
    expect(egressWording(SELF)).toBe('the address of your AnythingMCP server');
    expect(egressWording({ cloud: true, egressIps: [] })).toBe('AnythingMCP Cloud');
  });
});

describe('wooCommerceAuthHint', () => {
  it('tells WooCommerce\'s two 401s apart (woocommerce.com answered the first to a call without a key)', () => {
    expect(
      wooCommerceAuthHint(401, '{"code":"woocommerce_rest_cannot_view","message":"Sorry, you cannot list resources.","data":{"status":401}}'),
    ).toBe(WOOCOMMERCE_CANNOT_VIEW_HINT);
    expect(wooCommerceAuthHint(401, '{"code":"woocommerce_rest_authentication_error","message":"Consumer key is invalid."}')).toBe(
      WOOCOMMERCE_UNKNOWN_KEY_HINT,
    );
    expect(wooCommerceAuthHint(403, 'woocommerce_rest_cannot_view')).toBeUndefined();
    expect(wooCommerceAuthHint(401, 'Unauthorized')).toBeUndefined();
  });
});

describe('wooCommerceCheckAdvice', () => {
  beforeEach(() => request.mockReset());

  it('uses the refused key\'s own code before asking the site', async () => {
    const advice = await wooCommerceCheckAdvice({
      adapterSlug: 'woocommerce',
      status: 401,
      text: 'Request failed with status code 401: {"code":"woocommerce_rest_cannot_view"}',
      siteUrl: 'https://shop.example',
      ctx: SELF,
    });
    expect(advice).toBe(WOOCOMMERCE_CANNOT_VIEW_HINT);
    expect(request).not.toHaveBeenCalled();
  });

  it('asks the site about a 404, and keeps quiet when WooCommerce is there', async () => {
    site({ 'https://blog.example/wp-json/': answer(200, { home: 'https://blog.example', namespaces: ['wp/v2'] }) });
    expect(
      await wooCommerceCheckAdvice({ adapterSlug: 'woocommerce', status: 404, text: 'rest_no_route', siteUrl: 'https://blog.example', ctx: SELF }),
    ).toContain('WooCommerce is not active');

    site({ 'https://shop.example/wp-json/': answer(200, { home: 'https://shop.example', namespaces: ['wc/v3'] }) });
    expect(
      await wooCommerceCheckAdvice({ adapterSlug: 'woocommerce', status: 500, text: 'error', siteUrl: 'https://shop.example', ctx: SELF }),
    ).toBeUndefined();
  });

  it('is only for WooCommerce, and reuses a discovery it is given', async () => {
    expect(
      await wooCommerceCheckAdvice({ adapterSlug: 'wordpress', status: 404, text: '', siteUrl: 'https://x.example', ctx: SELF }),
    ).toBeUndefined();
    expect(
      await wooCommerceCheckAdvice({
        adapterSlug: 'woocommerce',
        status: 404,
        text: '',
        siteUrl: 'https://x.example',
        ctx: SELF,
        discovery: { url: 'https://x.example', problem: 'not_wordpress', message: 'No WordPress.' },
      }),
    ).toBe('No WordPress.');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('wooCommerceSiteOf', () => {
  it('reads the stored variable, else the base URL', () => {
    expect(wooCommerceSiteOf({ WOOCOMMERCE_URL: 'https://a.example' }, 'https://b.example/wp-json/wc/v3')).toBe('https://a.example');
    expect(wooCommerceSiteOf({}, 'https://b.example/wp-json/wc/v3')).toBe('https://b.example');
    expect(wooCommerceSiteOf({}, '{{WOOCOMMERCE_URL}}/wp-json/wc/v3')).toBeUndefined();
  });
});
