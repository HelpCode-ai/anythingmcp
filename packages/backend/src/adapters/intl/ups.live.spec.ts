import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import * as adapter from './ups.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { PrismaService } from '../../common/prisma.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * UPS adapter (tracking, address validation, rating, time in transit,
 * locator, landed cost, label recovery, pickups; shipping switched off).
 *
 * Static checks always run: the client-credentials token request (client id
 * and secret in a Basic header at onlinetools.ups.com), the transId and
 * transactionSrc headers UPS asks for, every tool's method and path against
 * UPS's official OpenAPI files (github.com/UPS-API/api-documentation:
 * Tracking, AddressValidation, Rating, TimeInTransit, Locator, LandedCost,
 * Shipping, Pickup), the request bodies, and which tools install switched
 * off. Everything that bills the UPS account (shipment, void, pickup) is off.
 *
 * Live checks run only with RUN_UPS_LIVE=1. Without credentials they confirm
 * that the token endpoint refuses wrong credentials; with UPS_CLIENT_ID and
 * UPS_CLIENT_SECRET they validate one address. Reads only.
 *
 *   RUN_UPS_LIVE=1 UPS_CLIENT_ID=... UPS_CLIENT_SECRET=... \
 *     npx jest src/adapters/intl/ups.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
    AxiosHeaders: actual.AxiosHeaders,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  setupGuide: { effort: string; steps: Array<{ id: string; fields?: string[] }> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({ name: entry.name, connectorType: 'REST', endpointMapping: entry.endpointMapping, annotations: entry.annotations });
const used = (entry: Tool) => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (/^\$\w+$/.test(v)) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};

const ENV: Record<string, string> = {
  UPS_CLIENT_ID: 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKl',
  UPS_CLIENT_SECRET: 'test-secret-value-0123456789abcdefghijklmnopqrstuvwxyz',
  UPS_ACCOUNT_NUMBER: 'A1B2C3',
};
const BASE = 'https://onlinetools.ups.com/api';

/** Method and path of every tool, as in UPS's OpenAPI files. */
const ROUTES: Record<string, [string, string]> = {
  ups_track_package: ['GET', '/track/v1/details/{inquiry_number}'],
  ups_track_by_reference: ['GET', '/track/v1/reference/details/{reference_number}'],
  ups_track_shipment_packages: ['GET', '/track/v1/shipment/details/{inquiry_number}'],
  ups_validate_address: ['POST', '/addressvalidation/v2/{request_option}'],
  ups_get_rate: ['POST', '/rating/v2409/Rate'],
  ups_shop_rates: ['POST', '/rating/v2409/Shop'],
  ups_get_time_in_transit: ['POST', '/shipments/v1/transittimes'],
  ups_find_locations: ['POST', '/locations/v3/search/availabilities/{request_option}'],
  ups_quote_landed_cost: ['POST', '/landedcost/v1/quotes'],
  ups_recover_label: ['POST', '/labels/v1/recovery'],
  ups_get_pickup_rate: ['POST', '/shipments/v2409/pickup/{pickup_type}'],
  ups_get_pending_pickups: ['GET', '/shipments/v2409/pickup/{pickup_type}'],
  ups_create_shipment: ['POST', '/shipments/v2409/ship'],
  ups_void_shipment: ['DELETE', '/shipments/v2409/void/cancel/{shipment_identification_number}'],
  ups_create_pickup: ['POST', '/pickupcreation/v2409/pickup'],
  ups_cancel_pickup: ['DELETE', '/shipments/v2409/pickup/02'],
};
const REQUIRED: Record<string, string[]> = {
  ups_track_package: ['inquiry_number'],
  ups_track_by_reference: ['reference_number'],
  ups_track_shipment_packages: ['inquiry_number'],
  ups_validate_address: ['address_lines'],
  ups_get_rate: ['service_code', 'shipper_address', 'ship_to_address', 'packages'],
  ups_shop_rates: ['shipper_address', 'ship_to_address', 'packages'],
  ups_get_time_in_transit: ['origin_country_code', 'destination_country_code'],
  ups_find_locations: ['country_code'],
  ups_quote_landed_cost: ['currency_code', 'shipment'],
  ups_recover_label: ['tracking_number'],
  ups_get_pickup_rate: ['pickup_address', 'account_country_code'],
  ups_get_pending_pickups: [],
  ups_create_shipment: ['shipment'],
  ups_void_shipment: ['shipment_identification_number'],
  ups_create_pickup: ['pickup_date_info', 'pickup_address', 'pickup_pieces', 'account_country_code'],
  ups_cancel_pickup: ['prn'],
};
const SWITCHED_OFF = ['ups_cancel_pickup', 'ups_create_pickup', 'ups_create_shipment', 'ups_void_shipment'];

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  const tokens = { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService;
  return new RestEngine(tokens, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, ENV),
      headers: cfg.headers,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (status = 200) => mockedAxios.mockResolvedValueOnce({ status, data: {}, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

const US_ADDRESS = { AddressLine: ['55 Glenlake Parkway NE'], City: 'Atlanta', StateProvinceCode: 'GA', PostalCode: '30328', CountryCode: 'US' };
const DE_ADDRESS = { AddressLine: ['Unter den Linden 1'], City: 'Berlin', PostalCode: '10117', CountryCode: 'DE' };
const PACKAGES = [{ PackagingType: { Code: '02' }, PackageWeight: { UnitOfMeasurement: { Code: 'LBS' }, Weight: '2.5' } }];

describe('ups adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('uses client credentials with a Basic header at onlinetools.ups.com', () => {
    expect(a.slug).toBe('ups');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('logistics');
    expect(a.icon).toBe('ups');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{UPS_CLIENT_ID}}',
      clientSecret: '{{UPS_CLIENT_SECRET}}',
      tokenUrl: 'https://onlinetools.ups.com/security/v1/oauth/token',
      tokenAuthMethod: 'client_secret_basic',
    });
    // UPS requires transId and transactionSrc on the tracking, time in
    // transit and landed cost calls and accepts them everywhere.
    expect(a.connector.headers).toMatchObject({ transId: 'anythingmcp', transactionSrc: 'AnythingMCP' });
    expect(a.requiredEnvVars).toEqual(['UPS_CLIENT_ID', 'UPS_CLIENT_SECRET', 'UPS_ACCOUNT_NUMBER']);
    expect(a.envVarMeta.UPS_CLIENT_SECRET).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.UPS_ACCOUNT_NUMBER.secret).toBeUndefined();
    for (const name of a.requiredEnvVars) expect(new RegExp(a.envVarMeta[name].pattern!).test(ENV[name])).toBe(true);
    for (const bad of ['', '12345', '1234567', 'A1B2 C3']) expect(new RegExp(a.envVarMeta.UPS_ACCOUNT_NUMBER.pattern!).test(bad)).toBe(false);
  });

  it('sends the client id and secret as Basic auth with grant_type in the form body', async () => {
    const service = new OAuth2TokenService(
      {} as PrismaService,
      { get: () => 'test-encryption-key-32-chars!!!!' } as unknown as ConfigService,
    );
    const post = jest
      .spyOn(mockedAxios as unknown as typeof axios, 'post')
      .mockResolvedValue({ data: { access_token: 'eyJ.token', expires_in: '14399', token_type: 'Bearer' } });
    await expect(service.getAccessToken(interpolateDeep({ ...a.connector.authConfig }, ENV))).resolves.toBe('eyJ.token');
    const [url, body, options] = post.mock.calls[0] as unknown as [string, string, { headers: Record<string, string> }];
    expect(url).toBe('https://onlinetools.ups.com/security/v1/oauth/token');
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({ grant_type: 'client_credentials' });
    expect(options.headers.Authorization).toBe(
      `Basic ${Buffer.from(`${ENV.UPS_CLIENT_ID}:${ENV.UPS_CLIENT_SECRET}`).toString('base64')}`,
    );
    post.mockRestore();
  });

  it('probes address validation and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe.tool).toBe('ups_validate_address');
    expect(a.probe.params).toMatchObject({ request_option: '1', country_code: 'US', postal_code: '30328' });
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('asks for every required variable in the setup guide', () => {
    expect(a.setupGuide.effort).toBe('own_app');
    const asked = a.setupGuide.steps.flatMap((step) => step.fields ?? []);
    expect(asked.sort()).toEqual([...a.requiredEnvVars].sort());
    expect(a.setupGuide.steps.at(-1)!.fields).toEqual(a.requiredEnvVars);
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^ups_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(declared.has(arg) || envNames.has(arg)).toBe(true);
      for (const arg of declared) expect(used(entry).has(arg)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(60);
    }
  });

  it('maps every tool to the method and path of the UPS OpenAPI files', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const entry of a.tools) {
      expect([entry.endpointMapping.method, entry.endpointMapping.path]).toEqual(ROUTES[entry.name]);
      expect(entry.parameters.required ?? []).toEqual(REQUIRED[entry.name]);
    }
  });

  it('installs shipment, void and pickup tools switched off and marks everything else read-only', () => {
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(SWITCHED_OFF);
    for (const entry of a.tools) {
      const isOff = entry.enabled === false;
      expect(annotationsOf(entry).readOnlyHint).toBe(!isOff);
      expect(/switched off/.test(entry.description)).toBe(isOff);
    }
    // No enabled tool can reach the calls that bill the account.
    for (const entry of a.tools.filter((t) => t.enabled !== false)) {
      expect(entry.endpointMapping.path).not.toMatch(/\/ship$|\/void\/|\/pickupcreation\//);
      expect(entry.endpointMapping.method).not.toBe('DELETE');
    }
  });

  it('names every tool in the instructions and keeps them free of MDX-breaking characters', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions.startsWith('## UPS')).toBe(true);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.replace(/`[^`]*`/g, '')).not.toMatch(/[{}<]/);
    for (const entry of a.tools) expect(entry.description.replace(/`[^`]*`/g, '')).not.toMatch(/[{}<]/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('tracks a package with the bearer token and the transaction headers', async () => {
    ok();
    await call('ups_track_package', { inquiry_number: '1Z12345E0205271688' });
    const req = sent();
    expect(req.url).toBe(`${BASE}/track/v1/details/1Z12345E0205271688`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Authorization')).toBe('Bearer test-token');
    expect(header(req, 'transId')).toBe('anythingmcp');
    expect(header(req, 'transactionSrc')).toBe('AnythingMCP');
    expect(req.params).toEqual({ locale: 'en_US' });

    ok();
    await call('ups_track_by_reference', { reference_number: 'ORDER-1001', from_pickup_date: '20261101' });
    expect(sent().url).toBe(`${BASE}/track/v1/reference/details/ORDER-1001`);
    // The shipper number comes from the connector, never from the model.
    expect(sent().params).toEqual({ locale: 'en_US', fromPickUpDate: '20261101', shipperNum: 'A1B2C3', refNumType: 'SmallPackage' });

    ok();
    await call('ups_track_shipment_packages', { inquiry_number: '1Z12345E0205271688' });
    expect(sent().url).toBe(`${BASE}/track/v1/shipment/details/1Z12345E0205271688`);
    expect(sent().params).toEqual({ locale: 'en_US', offset: 0, count: 50 });
  });

  it('builds the address validation, time in transit and locator requests', async () => {
    ok();
    await call('ups_validate_address', a.probe.params ?? {});
    expect(sent().url).toBe(`${BASE}/addressvalidation/v2/1`);
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({
      XAVRequest: {
        AddressKeyFormat: {
          AddressLine: ['55 Glenlake Parkway NE'],
          PoliticalDivision2: 'Atlanta',
          PoliticalDivision1: 'GA',
          PostcodePrimaryLow: '30328',
          CountryCode: 'US',
        },
      },
    });

    ok();
    await call('ups_get_time_in_transit', {
      origin_country_code: 'US',
      origin_postal_code: '10001',
      destination_country_code: 'US',
      destination_postal_code: '90210',
      weight: 2.5,
      weight_unit: 'LBS',
    });
    expect(sent().url).toBe(`${BASE}/shipments/v1/transittimes`);
    expect(sent().data).toEqual({
      originCountryCode: 'US',
      originPostalCode: '10001',
      destinationCountryCode: 'US',
      destinationPostalCode: '90210',
      residentialIndicator: '02',
      weight: 2.5,
      weightUnitOfMeasure: 'LBS',
      numberOfPackages: 1,
    });

    ok();
    await call('ups_find_locations', { country_code: 'DE', postal_code: '10117', request_option: '64' });
    expect(sent().url).toBe(`${BASE}/locations/v3/search/availabilities/64`);
    expect(sent().params).toEqual({ Locale: 'en_US' });
    expect(sent().data).toEqual({
      LocatorRequest: {
        Request: { RequestAction: 'Locator' },
        OriginAddress: { AddressKeyFormat: { PostcodePrimaryLow: '10117', CountryCode: 'DE' } },
        Translate: { Locale: 'en_US' },
        UnitOfMeasurement: { Code: 'KM' },
      },
    });
  });

  it('rates with the account number as shipper number and sends a service only for one-service rating', async () => {
    ok();
    await call('ups_get_rate', { service_code: '03', shipper_address: US_ADDRESS, ship_to_address: DE_ADDRESS, packages: PACKAGES });
    expect(sent().url).toBe(`${BASE}/rating/v2409/Rate`);
    expect(sent().data).toEqual({
      RateRequest: {
        Request: { TransactionReference: { CustomerContext: 'AnythingMCP' } },
        Shipment: {
          Shipper: { ShipperNumber: 'A1B2C3', Address: US_ADDRESS },
          ShipTo: { Address: DE_ADDRESS },
          Service: { Code: '03' },
          Package: PACKAGES,
        },
      },
    });

    ok();
    await call('ups_shop_rates', {
      shipper_address: US_ADDRESS,
      ship_to_address: DE_ADDRESS,
      packages: PACKAGES,
      rating_options: { NegotiatedRatesIndicator: 'Y' },
    });
    expect(sent().url).toBe(`${BASE}/rating/v2409/Shop`);
    const shipment = sent().data.RateRequest.Shipment;
    expect(shipment.Service).toBeUndefined();
    expect(shipment.ShipmentRatingOptions).toEqual({ NegotiatedRatesIndicator: 'Y' });
    expect(shipment.Shipper.ShipperNumber).toBe('A1B2C3');
  });

  it('builds the landed cost, label recovery and pickup reads', async () => {
    const shipment = {
      id: 'ORDER-1001',
      importCountryCode: 'CA',
      exportCountryCode: 'US',
      shipmentItems: [{ commodityId: '1', priceEach: 20, commodityCurrencyCode: 'USD', quantity: 2, UOM: 'EA', originCountryCode: 'US', hsCode: '6109100010' }],
    };
    ok();
    await call('ups_quote_landed_cost', { currency_code: 'USD', shipment });
    expect(sent().url).toBe(`${BASE}/landedcost/v1/quotes`);
    expect(header(sent(), 'AccountNumber')).toBe('A1B2C3');
    expect(sent().data).toEqual({ currencyCode: 'USD', transID: 'anythingmcp', alversion: 1, shipment });

    ok();
    await call('ups_recover_label', { tracking_number: '1Z12345E0205271688' });
    expect(sent().url).toBe(`${BASE}/labels/v1/recovery`);
    expect(sent().data).toEqual({
      LabelRecoveryRequest: {
        Request: { TransactionReference: { CustomerContext: 'AnythingMCP' } },
        LabelSpecification: { LabelImageFormat: { Code: 'PDF' } },
        TrackingNumber: '1Z12345E0205271688',
      },
    });

    const pickupAddress = { AddressLine: '55 Glenlake Parkway NE', City: 'Atlanta', StateProvince: 'GA', PostalCode: '30328', CountryCode: 'US', ResidentialIndicator: 'N' };
    ok();
    await call('ups_get_pickup_rate', { pickup_address: pickupAddress, account_country_code: 'US' });
    expect(sent().url).toBe(`${BASE}/shipments/v2409/pickup/oncall`);
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({
      PickupRateRequest: {
        Request: { TransactionReference: { CustomerContext: 'AnythingMCP' } },
        ShipperAccount: { AccountNumber: 'A1B2C3', AccountCountryCode: 'US' },
        PickupAddress: pickupAddress,
        AlternateAddressIndicator: 'Y',
        ServiceDateOption: '02',
      },
    });

    ok();
    await call('ups_get_pending_pickups', {});
    expect(sent().url).toBe(`${BASE}/shipments/v2409/pickup/oncall`);
    expect(String(sent().method).toUpperCase()).toBe('GET');
    expect(header(sent(), 'AccountNumber')).toBe('A1B2C3');
  });

  it('builds the switched-off shipment and pickup calls as UPS documents them', async () => {
    const shipment = {
      Shipper: { Name: 'Sender', ShipperNumber: 'A1B2C3', Address: US_ADDRESS },
      ShipTo: { Name: 'Receiver', Address: DE_ADDRESS },
      PaymentInformation: { ShipmentCharge: [{ Type: '01', BillShipper: { AccountNumber: 'A1B2C3' } }] },
      Service: { Code: '65' },
      Package: [{ Packaging: { Code: '02' }, PackageWeight: { UnitOfMeasurement: { Code: 'LBS' }, Weight: '2.5' } }],
    };
    ok();
    await call('ups_create_shipment', { shipment });
    expect(sent().url).toBe(`${BASE}/shipments/v2409/ship`);
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({
      ShipmentRequest: {
        Request: { RequestOption: 'nonvalidate', TransactionReference: { CustomerContext: 'AnythingMCP' } },
        Shipment: shipment,
        LabelSpecification: { LabelImageFormat: { Code: 'GIF' } },
      },
    });

    ok();
    await call('ups_void_shipment', { shipment_identification_number: '1Z12345E0205271688' });
    expect(String(sent().method).toUpperCase()).toBe('DELETE');
    expect(sent().url).toBe(`${BASE}/shipments/v2409/void/cancel/1Z12345E0205271688`);

    ok();
    await call('ups_create_pickup', {
      pickup_date_info: { PickupDate: '20261120', ReadyTime: '0900', CloseTime: '1700' },
      pickup_address: { CompanyName: 'Sender', ContactName: 'Jane Doe', AddressLine: ['55 Glenlake Parkway NE'], City: 'Atlanta', CountryCode: 'US', ResidentialIndicator: 'N', Phone: { Number: '4045550100' } },
      pickup_pieces: [{ ServiceCode: '003', Quantity: '2', DestinationCountryCode: 'US', ContainerCode: '01' }],
      account_country_code: 'US',
    });
    expect(sent().url).toBe(`${BASE}/pickupcreation/v2409/pickup`);
    const pickup = sent().data.PickupCreationRequest;
    expect(pickup.Shipper).toEqual({ Account: { AccountNumber: 'A1B2C3', AccountCountryCode: 'US' } });
    expect(pickup.PaymentMethod).toBe('01');
    expect(pickup.RatePickupIndicator).toBe('Y');
    expect(pickup.PickupPiece).toEqual([{ ServiceCode: '003', Quantity: '2', DestinationCountryCode: 'US', ContainerCode: '01' }]);

    ok();
    await call('ups_cancel_pickup', { prn: '2929602E9CP' });
    expect(String(sent().method).toUpperCase()).toBe('DELETE');
    expect(sent().url).toBe(`${BASE}/shipments/v2409/pickup/02`);
    expect(header(sent(), 'Prn')).toBe('2929602E9CP');
  });
});

// Opt-in: RUN_UPS_LIVE=1. The refusal check needs no account; the read needs
// UPS_CLIENT_ID and UPS_CLIENT_SECRET of a production app with the Address
// Validation product. Nothing is written.
const live = process.env.RUN_UPS_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('ups: live', () => {
  it('refuses wrong client credentials at the token endpoint', async () => {
    const response = await liveFetch.post('https://onlinetools.ups.com/security/v1/oauth/token', 'grant_type=client_credentials', {
      headers: {
        Authorization: `Basic ${Buffer.from('not-a-client:not-a-secret').toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      validateStatus: () => true,
    });
    expect([400, 401]).toContain(response.status);
  });

  it('validates one address', async () => {
    const id = process.env.UPS_CLIENT_ID;
    const secret = process.env.UPS_CLIENT_SECRET;
    if (!id || !secret) return;
    const token = await liveFetch.post('https://onlinetools.ups.com/security/v1/oauth/token', 'grant_type=client_credentials', {
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    });
    expect(token.data.access_token).toBeTruthy();
    const response = await liveFetch.post(
      `${BASE}/addressvalidation/v2/1`,
      { XAVRequest: { AddressKeyFormat: { AddressLine: ['55 Glenlake Parkway NE'], PoliticalDivision2: 'Atlanta', PoliticalDivision1: 'GA', PostcodePrimaryLow: '30328', CountryCode: 'US' } } },
      { headers: { Authorization: `Bearer ${token.data.access_token}`, Accept: 'application/json', transId: 'anythingmcp', transactionSrc: 'AnythingMCP' } },
    );
    expect(response.status).toBe(200);
    expect(response.data.XAVResponse).toBeDefined();
  });
});
