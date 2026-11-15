import { AdaptersService } from './adapters.service';

/**
 * The Shopify setup check. Shopify's token request answers every refusal with
 * a 400 and says which one in the body, so the adapter's hints are filed under
 * that code: in the four weeks to 15 November 2026, 24 of the 30 failed
 * Shopify checks on Cloud showed "The request was rejected as invalid. Check
 * the required parameters and their formats" for an app that was simply not
 * installed on the store.
 */
describe('AdaptersService.verifyCredentials: Shopify', () => {
  const KEYS = {
    // Both built from parts so no key-shaped literal sits in the source.
    SHOPIFY_CLIENT_ID: ['made', 'up', 'client', 'id', 'for', 'specs'].join(''),
    SHOPIFY_CLIENT_SECRET: ['not', 'a', 'real', 'client', 'secret'].join('-'),
  };

  function build(execute: jest.Mock) {
    return new AdaptersService(
      { connector: { findFirst: jest.fn() } } as any,
      { reloadConnectorTools: jest.fn() } as any,
      { get: (k: string) => (k === 'ENCRYPTION_KEY' ? 'a'.repeat(48) : undefined) } as any,
      { executeConnectorCall: execute } as any,
    );
  }

  /** What the engine throws when the token request or the call is refused (axios shape). */
  const refused = (status: number, data: unknown) =>
    Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

  const check = (execute: jest.Mock, store = 'acme-shop') =>
    build(execute).verifyCredentials('shopify', 'org1', { ...KEYS, SHOPIFY_STORE: store }) as Promise<any>;

  it('builds the store address from what the browser shows, admin address included', async () => {
    for (const pasted of ['acme-shop', 'Acme-Shop.myshopify.com', 'https://admin.shopify.com/store/acme-shop/settings/apps']) {
      const execute = jest.fn().mockResolvedValue({ shop: { name: 'Acme' } });
      const out = await check(execute, pasted);
      expect(out).toMatchObject({ ok: true, toolName: 'shopify_get_shop' });
      const connector = execute.mock.calls[0][0];
      expect(connector.baseUrl).toBe('https://acme-shop.myshopify.com/admin/api/2026-10/graphql.json');
      // What is stored is the name alone, so the token address is built from it too.
      expect(connector.envVars.SHOPIFY_STORE).toBe('acme-shop');
    }
  });

  it('refuses a custom domain before anything is sent, naming the field', async () => {
    const execute = jest.fn();
    const out = await check(execute, 'acme.com');
    expect(out).toMatchObject({ ok: false, kind: 'invalid_input' });
    expect(out.message).toMatch(/SHOPIFY_STORE must be only the part before \.myshopify\.com/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('says to install the app when Shopify answers app_not_installed', async () => {
    const execute = jest
      .fn()
      .mockRejectedValue(refused(400, { error: 'app_not_installed', error_description: 'The application is not installed on this shop.' }));
    const out = await check(execute);
    expect(out).toMatchObject({ ok: false, kind: 'bad_request', status: 400, toolName: 'shopify_get_shop' });
    expect(out.message).toMatch(/^The app is not installed on this store yet\. .*Install app/);
    // Shopify's own words follow the hint.
    expect(out.message).toMatch(/\(Request failed with status code 400: \{"error":"app_not_installed"/);
    expect(out.message).not.toMatch(/rejected as invalid/);
  });

  it('says the app and the store are in different organizations for shop_not_permitted', async () => {
    const execute = jest
      .fn()
      .mockRejectedValue(refused(400, { error: 'shop_not_permitted', error_description: 'Client credentials cannot be performed on this shop.' }));
    const out = await check(execute);
    expect(out.message).toMatch(/different Shopify organizations/);
    expect(out.message).toMatch(/Settings → Apps → Develop apps → Build apps in Dev Dashboard/);
  });

  it('puts a Client ID Shopify does not know under its field', async () => {
    // The answer of a real store to a made-up Client ID, 15 Nov 2026.
    const execute = jest.fn().mockRejectedValue(
      refused(400, {
        error: 'application_cannot_be_found',
        error_description: `Could not find Shopify API application with api_key ${KEYS.SHOPIFY_CLIENT_ID}`,
      }),
    );
    const out = await check(execute);
    expect(out.message).toMatch(/no app with this Client ID/);
    expect(out.fields).toEqual({ SHOPIFY_CLIENT_ID: out.message });
  });

  it('keeps a hint for a 400 with another reason, and for a store that does not exist', async () => {
    const other = await check(jest.fn().mockRejectedValue(refused(400, { error: 'invalid_request' })));
    expect(other.message).toMatch(/^Shopify refused the token request; its reason is at the end of this message\./);
    expect(other.message).toMatch(/invalid_request/);

    const missing = await check(jest.fn().mockRejectedValue(refused(404, { errors: 'Not Found' })));
    expect(missing).toMatchObject({ ok: false, kind: 'not_found', status: 404 });
    expect(missing.message).toMatch(/No store has this name at Shopify/);
    expect(missing.fields).toEqual({ SHOPIFY_STORE: missing.message });
  });
});
