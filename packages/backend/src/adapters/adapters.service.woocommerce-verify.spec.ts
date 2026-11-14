import { AdaptersService } from './adapters.service';
import { outboundRequest } from '../common/outbound-http';

// The keyless discovery (/wp-json/) goes out through this; no test may reach a shop.
jest.mock('../common/outbound-http', () => ({
  ...jest.requireActual('../common/outbound-http'),
  outboundRequest: jest.fn(),
}));
const outbound = outboundRequest as jest.MockedFunction<typeof outboundRequest>;

/**
 * The WooCommerce setup check: the site is asked what it is before the key is
 * tried (woocommerce-setup.ts), and a failure says which of the usual causes
 * it is instead of "No WooCommerce REST API at this address".
 */
describe('AdaptersService.verifyCredentials: WooCommerce', () => {
  const KEYS = {
    WOOCOMMERCE_CONSUMER_KEY: `ck_${'a1'.repeat(20)}`,
    WOOCOMMERCE_CONSUMER_SECRET: `cs_${'b2'.repeat(20)}`,
  };

  function build(execute: jest.Mock, cloud = false) {
    const service = new AdaptersService(
      { connector: { findFirst: jest.fn() } } as any,
      { reloadConnectorTools: jest.fn() } as any,
      {
        get: (k: string) =>
          k === 'ENCRYPTION_KEY' ? 'a'.repeat(48) : k === 'DEPLOYMENT_MODE' && cloud ? 'cloud' : undefined,
      } as any,
      { executeConnectorCall: execute } as any,
    );
    return service;
  }

  const index = (home: string, namespaces = ['wp/v2', 'wc/v3']) =>
    ({ status: 200, data: JSON.stringify({ home, namespaces }), headers: { 'content-type': 'application/json' } }) as any;

  /** What the REST engine throws for a refused call (axios shape). */
  const refused = (status: number, data: unknown) =>
    Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

  beforeEach(() => outbound.mockReset());

  it('uses the address WordPress names itself for the call, and hands it back to be saved', async () => {
    outbound.mockResolvedValue(index('https://www.shop.example'));
    const execute = jest.fn().mockResolvedValue([{ id: 42 }]);
    const out: any = await build(execute).verifyCredentials('woocommerce', 'org1', {
      ...KEYS,
      WOOCOMMERCE_URL: 'http://shop.example/wp-admin/',
    });
    expect(outbound).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://shop.example/wp-json/?_fields=home,namespaces' }));
    expect(execute.mock.calls[0][0].baseUrl).toBe('https://www.shop.example/wp-json/wc/v3');
    expect(out).toMatchObject({
      ok: true,
      toolName: 'woocommerce_list_orders',
      corrected: { WOOCOMMERCE_URL: 'https://www.shop.example' },
      note: 'WooCommerce answers at https://www.shop.example: that address is used.',
    });
  });

  it('does not send the key to a host that does not exist', async () => {
    const { SsrfBlockedError } = jest.requireActual('../common/ssrf.util');
    outbound.mockRejectedValue(new SsrfBlockedError("Host not found: 'shpo.example' could not be resolved (ENOTFOUND)."));
    const execute = jest.fn();
    const out: any = await build(execute).verifyCredentials('woocommerce', 'org1', { ...KEYS, WOOCOMMERCE_URL: 'https://shpo.example' });
    expect(execute).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: false, kind: 'unreachable' });
    expect(out.fields.WOOCOMMERCE_URL).toMatch(/that name does not exist/);
  });

  it('tells woocommerce_rest_cannot_view apart from a wrong key', async () => {
    outbound.mockResolvedValue(index('https://shop.example'));
    const execute = jest.fn().mockRejectedValue(
      refused(401, { code: 'woocommerce_rest_cannot_view', message: 'Sorry, you cannot list resources.', data: { status: 401 } }),
    );
    const out: any = await build(execute).verifyCredentials('woocommerce', 'org1', { ...KEYS, WOOCOMMERCE_URL: 'https://shop.example' });
    expect(out).toMatchObject({ ok: false, kind: 'auth_failed', status: 401 });
    expect(out.message).toMatch(/^WooCommerce treated the call as coming from a user who may not see this data/);
    expect(out.message).toMatch(/\(Request failed with status code 401/);
  });

  it('says WooCommerce is not active when the key call finds no route', async () => {
    outbound.mockResolvedValue(index('https://blog.example', ['wp/v2']));
    const execute = jest.fn().mockRejectedValue(
      refused(404, { code: 'rest_no_route', message: 'No route was found matching the URL and request method.' }),
    );
    const out: any = await build(execute).verifyCredentials('woocommerce', 'org1', { ...KEYS, WOOCOMMERCE_URL: 'https://blog.example' });
    expect(out).toMatchObject({ ok: false, kind: 'not_found', status: 404 });
    expect(out.message).toMatch(/^WordPress answers at https:\/\/blog\.example, but WooCommerce is not active there/);
    // Asked once, before the key: not again after the failure.
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it('names the Cloud address for a firewall that blocks the call', async () => {
    outbound.mockResolvedValue({
      status: 403,
      data: '<html><head><title>Just a moment...</title></head><body>cf-chl</body></html>',
      headers: { 'content-type': 'text/html' },
    } as any);
    const before = process.env.EGRESS_IPS;
    process.env.EGRESS_IPS = '104.248.242.235';
    try {
      const execute = jest.fn().mockRejectedValue(refused(403, '<html><title>Just a moment...</title></html>'));
      const out: any = await build(execute, true).verifyCredentials('woocommerce', 'org1', { ...KEYS, WOOCOMMERCE_URL: 'https://cf.example' });
      expect(out).toMatchObject({ ok: false, status: 403 });
      expect(out.message).toMatch(/^Cloudflare in front of cf\.example/);
      expect(out.message).toContain("AnythingMCP Cloud's address 104.248.242.235");
    } finally {
      if (before === undefined) delete process.env.EGRESS_IPS;
      else process.env.EGRESS_IPS = before;
    }
  });
});
