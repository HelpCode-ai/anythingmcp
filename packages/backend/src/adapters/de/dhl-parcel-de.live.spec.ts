import * as adapter from './dhl-parcel-de.json';

/**
 * Static checks always run. The live part runs against DHL's public sandbox.
 * DHL's API specification publishes sandbox credentials for the token
 * endpoint, but that client has no access to the shipping API, so without
 * your own app the test only proves the token flow and the endpoint (401
 * "no apiproduct match", not 404). With the API key and secret of your own
 * developer.dhl.com app (subscribed to Parcel DE Shipping) it validates one
 * shipment (validate=true books nothing) with the sandbox user user-valid.
 *
 *   RUN_DHL_PARCEL_DE_LIVE=1 [DHL_API_KEY=... DHL_API_SECRET=...] \
 *     npx jest src/adapters/de/dhl-parcel-de.live.spec.ts
 */

type Tool = {
  name: string;
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string>; bodyMapping?: Record<string, string> };
  annotations?: { readOnlyHint: boolean };
};
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;

describe('dhl-parcel-de adapter — static spec conformance', () => {
  it('targets the Parcel DE Shipping API v2 production server', () => {
    expect(a.connector.baseUrl).toBe('https://api-eu.dhl.com/parcel/de/shipping/v2');
  });

  it('uses the OAuth2 password grant of the Parcel Germany auth API', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toMatchObject({
      grant: 'password',
      tokenUrl: 'https://api-eu.dhl.com/parcel/de/account/auth/ropc/v1/token',
      clientId: '{{DHL_API_KEY}}',
      clientSecret: '{{DHL_API_SECRET}}',
      username: '{{DHL_GKP_USERNAME}}',
      password: '{{DHL_GKP_PASSWORD}}',
      tokenAuthMethod: 'client_secret_post',
    });
  });

  it('validates through POST /orders?validate=true and marks it read-only', () => {
    const t = tool('dhl_parcel_de_validate_shipments');
    expect(t.endpointMapping).toMatchObject({ method: 'POST', path: '/orders', queryParams: { validate: 'true' } });
    expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it('books, downloads and cancels on /orders, closes out on /manifests', () => {
    expect(tool('dhl_parcel_de_create_shipments').endpointMapping).toMatchObject({ method: 'POST', path: '/orders' });
    expect(tool('dhl_parcel_de_create_shipments').endpointMapping.queryParams?.validate).toBeUndefined();
    expect(tool('dhl_parcel_de_get_labels').endpointMapping).toMatchObject({ method: 'GET', path: '/orders' });
    expect(tool('dhl_parcel_de_cancel_shipments').endpointMapping).toMatchObject({
      method: 'DELETE',
      path: '/orders',
      queryParams: { profile: '$profile', shipment: '$shipment' },
    });
    expect(tool('dhl_parcel_de_close_out').endpointMapping).toMatchObject({ method: 'POST', path: '/manifests' });
    expect(tool('dhl_parcel_de_get_manifest').endpointMapping).toMatchObject({ method: 'GET', path: '/manifests' });
  });
});

const maybe = process.env.RUN_DHL_PARCEL_DE_LIVE ? describe : describe.skip;

maybe('dhl-parcel-de adapter — live against the DHL sandbox', () => {
  const sandbox = 'https://api-sandbox.dhl.com/parcel/de';
  const ownApp = !!(process.env.DHL_API_KEY && process.env.DHL_API_SECRET);
  // Without an own app: the sandbox client published in DHL's API
  // specification (public, not a secret).
  const form = new URLSearchParams({
    grant_type: 'password',
    username: 'user-valid',
    password: 'SandboxPasswort2023!',
    client_id: process.env.DHL_API_KEY || 'KH2iQ8YwGYtGs4XUBKaGaiyWBPEZnsRm',
    client_secret: process.env.DHL_API_SECRET || 'V8yPDt8GlGlNMRCh',
  });

  it('gets a token and validates a national DHL Paket shipment', async () => {
    const tokenRes = await fetch(`${sandbox}/account/auth/ropc/v1/token`, { method: 'POST', body: form });
    expect(tokenRes.status).toBe(200);
    const { access_token } = (await tokenRes.json()) as { access_token: string };

    const res = await fetch(`${sandbox}/shipping/v2/orders?validate=true`, {
      method: 'POST',
      // Bearer only: DHL rejects a Bearer token sent together with dhl-api-key.
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile: 'STANDARD_GRUPPENPROFIL',
        shipments: [
          {
            product: 'V01PAK',
            billingNumber: '33333333330102',
            shipper: { name1: 'My Online Shop GmbH', addressStreet: 'Sträßchensweg 10', postalCode: '53113', city: 'Bonn', country: 'DEU' },
            consignee: { name1: 'Maria Musterfrau', addressStreet: 'Kurt-Schumacher-Str. 20', postalCode: '53113', city: 'Bonn', country: 'DEU' },
            details: { weight: { uom: 'g', value: 500 } },
          },
        ],
      }),
    });
    if (!ownApp) {
      expect(res.status).toBe(401);
      expect(((await res.json()) as { detail: string }).detail).toMatch(/no apiproduct match/);
      return;
    }
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ sstatus: { statusCode: number } }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].sstatus.statusCode).toBe(200);
  }, 30_000);
});
