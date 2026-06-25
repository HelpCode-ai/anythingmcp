import * as adapter from './billbee.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Two layers of verification for the Billbee adapter:
 *
 *   1. Static — always runs. Asserts the adapter targets the Billbee REST API
 *      (https://api.billbee.io/api/v1), uses BOTH auth layers Billbee requires
 *      (HTTP Basic Auth via login email + API password AND the X-Billbee-Api-Key
 *      header), and exposes the documented order/product/customer/shipment paths.
 *
 *   2. Live — skipped in CI. Billbee enforces a two-stage auth gate, verified
 *      live: a request with NO X-Billbee-Api-Key header is rejected with 403
 *      "X-Billbee-Api-Key Header is missing"; a request WITH a (bogus) key plus
 *      bogus Basic Auth is rejected with 400 — either way not 404, proving the
 *      endpoint exists and both layers are wired. A full data test needs a valid
 *      BILLBEE_API_KEY (requested from Billbee), the account login email, and an
 *      API password.
 *
 *   Run live with:  RUN_BILLBEE_LIVE=1 npx jest src/adapters/de/billbee.live.spec.ts
 */

describe('billbee adapter — static spec conformance', () => {
  const a = adapter as unknown as {
    connector: {
      baseUrl: string;
      authType: string;
      authConfig: Record<string, string>;
      headers?: Record<string, string>;
    };
    tools: Array<{ name: string; endpointMapping: { method: string; path: string } }>;
  };

  it('targets the Billbee REST API base URL (api.billbee.io, not app.billbee.io)', () => {
    expect(a.connector.baseUrl).toBe('https://api.billbee.io/api/v1');
  });

  it('uses Basic Auth (login email + API password) for the user credentials', () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig.username).toBe('{{BILLBEE_LOGIN_EMAIL}}');
    expect(a.connector.authConfig.password).toBe('{{BILLBEE_API_PASSWORD}}');
  });

  it('also sends the application X-Billbee-Api-Key header (required alongside Basic Auth)', () => {
    expect(a.connector.headers?.['X-Billbee-Api-Key']).toBe('{{BILLBEE_API_KEY}}');
  });

  it('exposes the documented order, product, customer and shipment paths', () => {
    const paths = a.tools.map((t) => t.endpointMapping.path);
    expect(paths).toContain('/orders');
    expect(paths).toContain('/orders/{id}');
    expect(paths).toContain('/orders/findbyextref/{extRef}');
    expect(paths).toContain('/products');
    expect(paths).toContain('/products/{id}');
    expect(paths).toContain('/customers');
    expect(paths).toContain('/customers/{id}/orders');
    expect(paths).toContain('/shipment/shippingproviders');
  });
});

const maybe = process.env.RUN_BILLBEE_LIVE ? describe : describe.skip;

maybe('billbee adapter — live edge reachability', () => {
  const oauth = {} as unknown as OAuth2TokenService;
  const login = {} as unknown as LoginTokenService;
  const engine = new RestEngine(oauth, login);

  const baseUrl = 'https://api.billbee.io/api/v1';

  it('rejects a request missing the X-Billbee-Api-Key header with 403 (gate 1)', async () => {
    let err: any;
    try {
      await engine.execute(
        {
          baseUrl,
          authType: 'BASIC_AUTH',
          authConfig: { username: 'bogus@example.com', password: 'bogus-pass' },
          // deliberately omit connector.headers (no X-Billbee-Api-Key)
        },
        { method: 'GET', path: '/orders', queryParams: { pageSize: '$pageSize' } },
        { pageSize: 1 },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.response?.status).toBe(403);
    expect(JSON.stringify(err.response?.data || '')).toMatch(/X-Billbee-Api-Key/i);
  }, 30000);

  it('reaches Billbee with both auth layers present (bogus → 4xx, not 404)', async () => {
    let err: any;
    try {
      await engine.execute(
        {
          baseUrl,
          authType: 'BASIC_AUTH',
          authConfig: { username: 'bogus@example.com', password: 'bogus-pass' },
          headers: { 'X-Billbee-Api-Key': 'bogus-invalid-key' },
        },
        { method: 'GET', path: '/orders', queryParams: { pageSize: '$pageSize' } },
        { pageSize: 1 },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    // With the key header present but invalid Billbee returns 400 (not 404),
    // proving the endpoint exists and the API-key gate was passed.
    expect([400, 401, 403]).toContain(err.response?.status);
    expect(err.response?.status).not.toBe(404);
  }, 30000);

  it('RestEngine injects both the Basic Auth and the X-Billbee-Api-Key header', async () => {
    let err: any;
    try {
      await engine.execute(
        {
          baseUrl,
          authType: 'BASIC_AUTH',
          authConfig: { username: 'sentinel@example.com', password: 'sentinel-pass' },
          headers: { 'X-Billbee-Api-Key': 'sentinel-key-12345' },
        },
        { method: 'GET', path: '/orders' },
        {},
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.config?.auth?.username).toBe('sentinel@example.com');
    expect(err.config?.auth?.password).toBe('sentinel-pass');
    expect((err.config?.headers || {})['X-Billbee-Api-Key']).toBe('sentinel-key-12345');
  }, 30000);
});
