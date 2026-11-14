import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import * as adapter from './fedex.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { PrismaService } from '../../common/prisma.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * FedEx adapter (track, proof of delivery, rates, transit times, service
 * availability, address validation, locations, pickup availability; ship,
 * cancel and pickup booking switched off).
 *
 * Static checks always run: the client-credentials token request (API key
 * and secret key as form fields at apis.fedex.com/oauth/token, as FedEx
 * documents it), every tool's method and path against FedEx's public
 * resource specs (developer.fedex.com/wirc/json/api_groups: Track, Rate,
 * ServiceAvailability, AddressValidation, Location, Pickup, Ship), the
 * request bodies with the account number of the connector, and which tools
 * install switched off. Everything that creates a shipment or books a
 * courier is off; the Ship API also needs FedEx's label validation.
 *
 * Live checks run only with RUN_FEDEX_LIVE=1. Without credentials they
 * confirm that the token endpoint refuses wrong credentials; with
 * FEDEX_CLIENT_ID and FEDEX_CLIENT_SECRET (production keys) they track one
 * number. Reads only.
 *
 *   RUN_FEDEX_LIVE=1 FEDEX_CLIENT_ID=... FEDEX_CLIENT_SECRET=... \
 *     npx jest src/adapters/intl/fedex.live.spec.ts
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
  FEDEX_CLIENT_ID: 'l7a1b2c3d4e5f60718293a4b5c6d7e8f90',
  FEDEX_CLIENT_SECRET: '0123456789abcdef0123456789abcdef',
  FEDEX_ACCOUNT_NUMBER: '740561073',
};
const BASE = 'https://apis.fedex.com';
const ACCOUNT = { value: '740561073' };

/** Method and path of every tool, as in FedEx's resource specs. */
const ROUTES: Record<string, [string, string]> = {
  fedex_track_by_tracking_number: ['POST', '/track/v1/trackingnumbers'],
  fedex_track_by_reference: ['POST', '/track/v1/referencenumbers'],
  fedex_track_multi_piece_shipment: ['POST', '/track/v1/associatedshipments'],
  fedex_get_tracking_document: ['POST', '/track/v1/trackingdocuments'],
  fedex_get_rates: ['POST', '/rate/v1/rates/quotes'],
  fedex_get_transit_times: ['POST', '/availability/v1/transittimes'],
  fedex_get_package_and_service_options: ['POST', '/availability/v1/packageandserviceoptions'],
  fedex_get_special_service_options: ['POST', '/availability/v1/specialserviceoptions'],
  fedex_validate_address: ['POST', '/address/v1/addresses/resolve'],
  fedex_find_locations: ['POST', '/location/v1/locations'],
  fedex_check_pickup_availability: ['POST', '/pickup/v1/pickups/availabilities'],
  fedex_validate_shipment: ['POST', '/ship/v1/shipments/packages/validate'],
  fedex_create_shipment: ['POST', '/ship/v1/shipments'],
  fedex_cancel_shipment: ['PUT', '/ship/v1/shipments/cancel'],
  fedex_create_pickup: ['POST', '/pickup/v1/pickups'],
  fedex_cancel_pickup: ['PUT', '/pickup/v1/pickups/cancel'],
};
const REQUIRED: Record<string, string[]> = {
  fedex_track_by_tracking_number: ['tracking_number'],
  fedex_track_by_reference: ['value', 'ship_date_begin', 'ship_date_end'],
  fedex_track_multi_piece_shipment: ['master_tracking_number'],
  fedex_get_tracking_document: ['tracking_number'],
  fedex_get_rates: ['shipper_address', 'recipient_address', 'packages'],
  fedex_get_transit_times: ['shipper_address', 'recipient_address', 'packages'],
  fedex_get_package_and_service_options: ['shipper_address', 'recipient_address'],
  fedex_get_special_service_options: ['shipper_address', 'recipient_address', 'packages'],
  fedex_validate_address: ['street_lines', 'country_code'],
  fedex_find_locations: ['address'],
  fedex_check_pickup_availability: ['pickup_address'],
  fedex_validate_shipment: ['requested_shipment'],
  fedex_create_shipment: ['requested_shipment'],
  fedex_cancel_shipment: ['tracking_number'],
  fedex_create_pickup: ['origin_detail', 'carrier_code'],
  fedex_cancel_pickup: ['pickup_confirmation_code', 'scheduled_date'],
};
const SWITCHED_OFF = ['fedex_cancel_pickup', 'fedex_cancel_shipment', 'fedex_create_pickup', 'fedex_create_shipment'];

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

const MEMPHIS = { postalCode: '38116', countryCode: 'US' };
const SEATTLE = { postalCode: '98101', countryCode: 'US', residential: true };
const PACKAGES = [{ weight: { units: 'LB', value: 5 } }];
const REQUESTED_SHIPMENT = {
  shipper: { contact: { personName: 'Jane Doe', phoneNumber: '9015550100' }, address: { streetLines: ['10 FedEx Parkway'], city: 'Memphis', stateOrProvinceCode: 'TN', postalCode: '38116', countryCode: 'US' } },
  recipients: [{ contact: { personName: 'John Roe', phoneNumber: '2065550100' }, address: { streetLines: ['500 Pine St'], city: 'Seattle', stateOrProvinceCode: 'WA', postalCode: '98101', countryCode: 'US' } }],
  pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
  serviceType: 'FEDEX_GROUND',
  packagingType: 'YOUR_PACKAGING',
  shippingChargesPayment: { paymentType: 'SENDER' },
  labelSpecification: { imageType: 'PDF', labelStockType: 'PAPER_85X11_TOP_HALF_LABEL' },
  requestedPackageLineItems: [{ weight: { units: 'LB', value: 5 } }],
};

describe('fedex adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('uses client credentials in the form body at apis.fedex.com', () => {
    expect(a.slug).toBe('fedex');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('logistics');
    expect(a.icon).toBe('fedex');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{FEDEX_CLIENT_ID}}',
      clientSecret: '{{FEDEX_CLIENT_SECRET}}',
      tokenUrl: 'https://apis.fedex.com/oauth/token',
      tokenAuthMethod: 'client_secret_post',
    });
    expect(a.connector.headers).toMatchObject({ 'X-locale': 'en_US' });
    expect(a.requiredEnvVars).toEqual(['FEDEX_CLIENT_ID', 'FEDEX_CLIENT_SECRET', 'FEDEX_ACCOUNT_NUMBER']);
    expect(a.envVarMeta.FEDEX_CLIENT_SECRET).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.FEDEX_ACCOUNT_NUMBER.secret).toBeUndefined();
    for (const name of a.requiredEnvVars) expect(new RegExp(a.envVarMeta[name].pattern!).test(ENV[name])).toBe(true);
    for (const bad of ['', '12345678', '1234567890', '7405 61073']) expect(new RegExp(a.envVarMeta.FEDEX_ACCOUNT_NUMBER.pattern!).test(bad)).toBe(false);
  });

  it('sends the API key and secret key as form fields, without a Basic header', async () => {
    const service = new OAuth2TokenService(
      {} as PrismaService,
      { get: () => 'test-encryption-key-32-chars!!!!' } as unknown as ConfigService,
    );
    const post = jest
      .spyOn(mockedAxios as unknown as typeof axios, 'post')
      .mockResolvedValue({ data: { access_token: 'eyJ.token', expires_in: 3599, token_type: 'bearer', scope: 'CXS' } });
    await expect(service.getAccessToken(interpolateDeep({ ...a.connector.authConfig }, ENV))).resolves.toBe('eyJ.token');
    const [url, body, options] = post.mock.calls[0] as unknown as [string, string, { headers: Record<string, string> }];
    expect(url).toBe('https://apis.fedex.com/oauth/token');
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
      grant_type: 'client_credentials',
      client_id: ENV.FEDEX_CLIENT_ID,
      client_secret: ENV.FEDEX_CLIENT_SECRET,
    });
    expect(options.headers.Authorization).toBeUndefined();
    post.mockRestore();
  });

  it('probes tracking and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'fedex_track_by_tracking_number', params: { tracking_number: '123456789012', include_detailed_scans: false } });
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    // The validation FedEx asks for before the Ship API works is explained to the user.
    expect(a.instructions).toMatch(/Label validation before shipping/);
    expect(a.instructions).toContain('label@fedex.com');
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
    for (const name of mine) expect(name).toMatch(/^fedex_[a-z0-9_]+$/);
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

  it('maps every tool to the method and path of the FedEx resource specs', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const entry of a.tools) {
      expect([entry.endpointMapping.method, entry.endpointMapping.path]).toEqual(ROUTES[entry.name]);
      expect(entry.parameters.required ?? []).toEqual(REQUIRED[entry.name]);
    }
  });

  it('installs ship, cancel and pickup booking switched off and marks everything else read-only', () => {
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(SWITCHED_OFF);
    for (const entry of a.tools) {
      const isOff = entry.enabled === false;
      expect(annotationsOf(entry).readOnlyHint).toBe(!isOff);
      expect(/switched off/.test(entry.description)).toBe(isOff);
    }
    // The only enabled Ship and Pickup paths are the ones that create nothing.
    const enabledPaths = a.tools.filter((entry) => entry.enabled !== false).map((entry) => entry.endpointMapping.path);
    expect(enabledPaths.filter((path) => path.startsWith('/ship/'))).toEqual(['/ship/v1/shipments/packages/validate']);
    expect(enabledPaths.filter((path) => path.startsWith('/pickup/'))).toEqual(['/pickup/v1/pickups/availabilities']);
  });

  it('names every tool in the instructions and keeps them free of MDX-breaking characters', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions.startsWith('## FedEx')).toBe(true);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.replace(/`[^`]*`/g, '')).not.toMatch(/[{}<]/);
    for (const entry of a.tools) expect(entry.description.replace(/`[^`]*`/g, '')).not.toMatch(/[{}<]/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('tracks by number, reference and master number with the bearer token', async () => {
    ok();
    await call('fedex_track_by_tracking_number', a.probe.params ?? {});
    const req = sent();
    expect(req.url).toBe(`${BASE}/track/v1/trackingnumbers`);
    expect(String(req.method).toUpperCase()).toBe('POST');
    expect(header(req, 'Authorization')).toBe('Bearer test-token');
    expect(header(req, 'X-locale')).toBe('en_US');
    expect(req.data).toEqual({ includeDetailedScans: false, trackingInfo: [{ trackingNumberInfo: { trackingNumber: '123456789012' } }] });

    ok();
    await call('fedex_track_by_reference', { value: 'ORDER-1001', type: 'CUSTOMER_REFERENCE', ship_date_begin: '2026-11-01', ship_date_end: '2026-11-14' });
    expect(sent().url).toBe(`${BASE}/track/v1/referencenumbers`);
    // The account number comes from the connector, never from the model.
    expect(sent().data).toEqual({
      referencesInformation: { type: 'CUSTOMER_REFERENCE', value: 'ORDER-1001', accountNumber: '740561073', shipDateBegin: '2026-11-01', shipDateEnd: '2026-11-14' },
      includeDetailedScans: true,
    });

    ok();
    await call('fedex_track_multi_piece_shipment', { master_tracking_number: '794953555571' });
    expect(sent().url).toBe(`${BASE}/track/v1/associatedshipments`);
    expect(sent().data).toEqual({
      includeDetailedScans: false,
      associatedType: 'STANDARD_MPS',
      masterTrackingNumberInfo: { trackingNumberInfo: { trackingNumber: '794953555571' } },
      pagingDetails: { resultsPerPage: 50 },
    });

    ok();
    await call('fedex_get_tracking_document', { tracking_number: '794953555571', account_number: '740561073' });
    expect(sent().url).toBe(`${BASE}/track/v1/trackingdocuments`);
    expect(sent().data).toEqual({
      trackDocumentDetail: { documentType: 'SIGNATURE_PROOF_OF_DELIVERY', documentFormat: 'PDF' },
      trackDocumentSpecification: [{ trackingNumberInfo: { trackingNumber: '794953555571' }, accountNumber: '740561073' }],
    });
  });

  it('quotes rates and transit times with the account number of the connector', async () => {
    ok();
    await call('fedex_get_rates', { shipper_address: MEMPHIS, recipient_address: SEATTLE, packages: PACKAGES });
    expect(sent().url).toBe(`${BASE}/rate/v1/rates/quotes`);
    expect(sent().data).toEqual({
      accountNumber: ACCOUNT,
      rateRequestControlParameters: { returnTransitTimes: true },
      requestedShipment: {
        shipper: { address: MEMPHIS },
        recipient: { address: SEATTLE },
        packagingType: 'YOUR_PACKAGING',
        pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
        rateRequestType: ['ACCOUNT', 'LIST'],
        requestedPackageLineItems: PACKAGES,
      },
    });

    ok();
    await call('fedex_get_transit_times', { shipper_address: MEMPHIS, recipient_address: SEATTLE, packages: PACKAGES, service_type: 'FEDEX_GROUND' });
    expect(sent().url).toBe(`${BASE}/availability/v1/transittimes`);
    expect(sent().data).toEqual({
      requestedShipment: {
        shipper: { address: MEMPHIS },
        recipients: [{ address: SEATTLE }],
        serviceType: 'FEDEX_GROUND',
        packagingType: 'YOUR_PACKAGING',
        pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
        requestedPackageLineItems: PACKAGES,
      },
    });

    ok();
    await call('fedex_get_package_and_service_options', { shipper_address: MEMPHIS, recipient_address: SEATTLE });
    expect(sent().url).toBe(`${BASE}/availability/v1/packageandserviceoptions`);
    expect(sent().data).toEqual({
      requestedShipment: { shipper: { address: MEMPHIS }, recipients: [{ address: SEATTLE }], pickupType: 'DROPOFF_AT_FEDEX_LOCATION' },
      accountNumber: ACCOUNT,
    });

    ok();
    await call('fedex_get_special_service_options', { shipper_address: MEMPHIS, recipient_address: SEATTLE, packages: PACKAGES });
    expect(sent().url).toBe(`${BASE}/availability/v1/specialserviceoptions`);
    expect(sent().data).toEqual({
      requestedShipment: {
        shipper: { address: MEMPHIS },
        recipient: { address: SEATTLE },
        packagingType: 'YOUR_PACKAGING',
        requestedPackageLineItems: PACKAGES,
        pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
      },
      accountNumber: ACCOUNT,
    });
  });

  it('builds the address validation, location and pickup availability requests', async () => {
    ok();
    await call('fedex_validate_address', { street_lines: ['7372 PARKRIDGE BLVD', 'APT 286'], city: 'IRVING', state_or_province_code: 'TX', postal_code: '75063-8659', country_code: 'US' });
    expect(sent().url).toBe(`${BASE}/address/v1/addresses/resolve`);
    expect(sent().data).toEqual({
      validateAddressControlParameters: { includeResolutionTokens: true },
      addressesToValidate: [
        { address: { streetLines: ['7372 PARKRIDGE BLVD', 'APT 286'], city: 'IRVING', stateOrProvinceCode: 'TX', postalCode: '75063-8659', countryCode: 'US' } },
      ],
    });

    ok();
    await call('fedex_find_locations', { address: { postalCode: '10001', countryCode: 'US' } });
    expect(sent().url).toBe(`${BASE}/location/v1/locations`);
    expect(sent().data).toEqual({
      locationsSummaryRequestControlParameters: { distance: { units: 'KM', value: 25 }, maxResults: 10 },
      locationSearchCriterion: 'ADDRESS',
      location: { address: { postalCode: '10001', countryCode: 'US' } },
      multipleMatchesAction: 'RETURN_ALL',
      sort: { criteria: 'DISTANCE', order: 'ASCENDING' },
    });

    ok();
    await call('fedex_check_pickup_availability', { pickup_address: { streetLines: ['10 FedEx Parkway'], postalCode: '38116', countryCode: 'US' }, dispatch_date: '2026-11-20' });
    expect(sent().url).toBe(`${BASE}/pickup/v1/pickups/availabilities`);
    expect(sent().data).toEqual({
      pickupAddress: { streetLines: ['10 FedEx Parkway'], postalCode: '38116', countryCode: 'US' },
      dispatchDate: '2026-11-20',
      pickupRequestType: ['FUTURE_DAY'],
      carriers: ['FDXE'],
      countryRelationship: 'DOMESTIC',
    });
  });

  it('builds the shipment validation and the switched-off ship, cancel and pickup calls', async () => {
    ok();
    await call('fedex_validate_shipment', { requested_shipment: REQUESTED_SHIPMENT });
    expect(sent().url).toBe(`${BASE}/ship/v1/shipments/packages/validate`);
    expect(sent().data).toEqual({ requestedShipment: REQUESTED_SHIPMENT, accountNumber: ACCOUNT });

    ok();
    await call('fedex_create_shipment', { requested_shipment: REQUESTED_SHIPMENT });
    expect(sent().url).toBe(`${BASE}/ship/v1/shipments`);
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({ requestedShipment: REQUESTED_SHIPMENT, labelResponseOptions: 'URL_ONLY', accountNumber: ACCOUNT, shipAction: 'CONFIRM' });

    ok();
    await call('fedex_cancel_shipment', { tracking_number: '794953555571', sender_country_code: 'US' });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/ship/v1/shipments/cancel`);
    expect(sent().data).toEqual({ accountNumber: ACCOUNT, senderCountryCode: 'US', deletionControl: 'DELETE_ALL_PACKAGES', trackingNumber: '794953555571' });

    const originDetail = {
      pickupLocation: {
        contact: { personName: 'Jane Doe', phoneNumber: '9015550100' },
        address: { streetLines: ['10 FedEx Parkway'], city: 'Memphis', stateOrProvinceCode: 'TN', postalCode: '38116', countryCode: 'US' },
      },
      readyDateTimestamp: '2026-11-20T11:00:00Z',
      customerCloseTime: '18:00:00',
    };
    ok();
    await call('fedex_create_pickup', { origin_detail: originDetail, carrier_code: 'FDXE', package_count: 2 });
    expect(sent().url).toBe(`${BASE}/pickup/v1/pickups`);
    expect(sent().data).toEqual({ associatedAccountNumber: ACCOUNT, originDetail, packageCount: 2, carrierCode: 'FDXE', pickupType: 'ON_CALL' });

    ok();
    await call('fedex_cancel_pickup', { pickup_confirmation_code: '7', scheduled_date: '2026-11-20', carrier_code: 'FDXE', location: 'LOSA' });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().url).toBe(`${BASE}/pickup/v1/pickups/cancel`);
    expect(sent().data).toEqual({ associatedAccountNumber: ACCOUNT, pickupConfirmationCode: '7', carrierCode: 'FDXE', scheduledDate: '2026-11-20', location: 'LOSA' });
  });
});

// Opt-in: RUN_FEDEX_LIVE=1. The refusal check needs no account; the read
// needs the production API key and secret key of a project with the Track
// API. Nothing is written.
const live = process.env.RUN_FEDEX_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('fedex: live', () => {
  it('refuses wrong client credentials at the token endpoint', async () => {
    const response = await liveFetch.post(
      'https://apis.fedex.com/oauth/token',
      'grant_type=client_credentials&client_id=not-a-key&client_secret=not-a-secret',
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, validateStatus: () => true },
    );
    expect([400, 401]).toContain(response.status);
  });

  it('tracks one number', async () => {
    const id = process.env.FEDEX_CLIENT_ID;
    const secret = process.env.FEDEX_CLIENT_SECRET;
    if (!id || !secret) return;
    const token = await liveFetch.post(
      'https://apis.fedex.com/oauth/token',
      new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } },
    );
    expect(token.data.access_token).toBeTruthy();
    const response = await liveFetch.post(
      `${BASE}/track/v1/trackingnumbers`,
      { includeDetailedScans: false, trackingInfo: [{ trackingNumberInfo: { trackingNumber: '123456789012' } }] },
      { headers: { Authorization: `Bearer ${token.data.access_token}`, 'X-locale': 'en_US', Accept: 'application/json' } },
    );
    // FedEx answers 200 for a number it cannot find and reports it inside the result.
    expect(response.status).toBe(200);
    expect(response.data.output.completeTrackResults).toBeDefined();
  });
});
