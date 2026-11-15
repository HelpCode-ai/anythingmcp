import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import * as adapter from './usps.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { PrismaService } from '../../common/prisma.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * USPS adapter (the REST APIs of developers.usps.com that replaced Web
 * Tools: addresses, domestic and international prices, service standards,
 * shipping options, Tracking 3.2, locations, carrier pickup reads, payment
 * account read; payment authorization, labels, refunds, pickup booking and
 * SCAN Forms switched off).
 *
 * Static checks always run: the client-credentials token request (Consumer
 * Key and Secret as form fields at /oauth2/v3/token on the chosen host, one
 * of the two content types USPS's OAuth spec accepts), the production / TEM
 * host choice, every tool's method and path against the OpenAPI specs USPS
 * publishes on developers.usps.com (addresses, domestic-prices,
 * international-prices, service-standards, international-service-standard,
 * shipping-options, tracking-v3r2, locations, carrier-pickup, payments,
 * labels, international-labels, scan-form), the request bodies and headers,
 * and which tools install switched off. Everything that buys postage,
 * cancels or refunds a label, books or cancels a pickup or creates a SCAN
 * Form is off.
 *
 * Live checks run only with RUN_USPS_LIVE=1. Without credentials they
 * confirm that the token endpoint refuses wrong credentials; with
 * USPS_CLIENT_ID and USPS_CLIENT_SECRET (Consumer Key and Secret) they look
 * up one ZIP Code and track one number. Reads only.
 *
 *   RUN_USPS_LIVE=1 USPS_CLIENT_ID=... USPS_CLIENT_SECRET=... \
 *     npx jest src/adapters/intl/usps.live.spec.ts
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
    bodyMapping?: Record<string, unknown> | unknown[];
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
};
type EnvMeta = { pattern?: string; kind?: string; secret?: boolean; advanced?: boolean; options?: Array<{ value: string; label: string }> };
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  instructionFacts: string[];
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  envVarMeta: Record<string, EnvMeta>;
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
  deriveToolAnnotations({ name: entry.name, connectorType: 'REST', endpointMapping: entry.endpointMapping as never, annotations: entry.annotations });
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
  USPS_CLIENT_ID: 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z',
  USPS_CLIENT_SECRET: 'Zq7Wx2Cv9Bn4Lk1J',
  USPS_API_HOST: 'https://apis.usps.com',
};
const BASE = 'https://apis.usps.com';
const LABELS_JSON = 'application/vnd.usps.labels+json';

/** Method and path of every tool, as in USPS's OpenAPI specs (server base + operation path). */
const ROUTES: Record<string, [string, string]> = {
  usps_validate_address: ['GET', '/addresses/v3/address'],
  usps_get_city_state: ['GET', '/addresses/v3/city-state'],
  usps_get_zip_code: ['GET', '/addresses/v3/zipcode'],
  usps_search_domestic_prices: ['POST', '/prices/v3/total-rates/search'],
  usps_list_domestic_prices: ['POST', '/prices/v3/base-rates-list/search'],
  usps_search_letter_prices: ['POST', '/prices/v3/letter-rates/search'],
  usps_search_international_prices: ['POST', '/international-prices/v3/total-rates/search'],
  usps_list_international_prices: ['POST', '/international-prices/v3/base-rates-list/search'],
  usps_search_international_letter_prices: ['POST', '/international-prices/v3/letter-rates/search'],
  usps_get_delivery_estimates: ['GET', '/service-standards/v3/estimates'],
  usps_get_service_standards: ['GET', '/service-standards/v3/standards'],
  usps_get_international_service_standard: ['GET', '/international-service-standard/v3/international-service-standard'],
  usps_search_shipping_options: ['POST', '/shipments/v3/options/search'],
  usps_track_package: ['POST', '/tracking/v3r2/tracking'],
  usps_track_packages: ['POST', '/tracking/v3r2/tracking'],
  usps_register_tracking_notifications: ['POST', '/tracking/v3r2/tracking/{tracking_number}/notifications'],
  usps_request_proof_of_delivery: ['POST', '/tracking/v3r2/tracking/{tracking_number}/proof-of-delivery'],
  usps_find_post_offices: ['GET', '/locations/v3/post-office-locations'],
  usps_find_dropoff_locations: ['GET', '/locations/v3/dropoff-locations'],
  usps_find_parcel_lockers: ['GET', '/locations/v3/parcel-locker-locations'],
  usps_check_pickup_eligibility: ['GET', '/pickup/v3/carrier-pickup/eligibility'],
  usps_get_pickup: ['GET', '/pickup/v3/carrier-pickup/{confirmation_number}'],
  usps_get_payment_account: ['GET', '/payments/v3/payment-account/{account_number}'],
  usps_create_payment_authorization: ['POST', '/payments/v3/payment-authorization'],
  usps_create_label: ['POST', '/labels/v3/label'],
  usps_create_return_label: ['POST', '/labels/v3/return-label'],
  usps_cancel_label: ['DELETE', '/labels/v3/label/{tracking_number}'],
  usps_create_international_label: ['POST', '/international-labels/v3/international-label'],
  usps_cancel_international_label: ['DELETE', '/international-labels/v3/international-label/{tracking_number}'],
  usps_schedule_pickup: ['POST', '/pickup/v3/carrier-pickup'],
  usps_cancel_pickup: ['DELETE', '/pickup/v3/carrier-pickup/{confirmation_number}'],
  usps_create_scan_form: ['POST', '/scan-forms/v3/scan-form'],
};
const PACKAGE = ['origin_zip_code', 'destination_zip_code', 'weight', 'length', 'width', 'height'];
const INTL_PACKAGE = ['origin_zip_code', 'destination_country_code', 'weight', 'length', 'width', 'height'];
const LETTER = ['weight', 'length', 'height', 'thickness', 'processing_category'];
const LABEL = ['payment_authorization_token', 'to_address', 'from_address', 'package_description'];
const REQUIRED: Record<string, string[]> = {
  usps_validate_address: ['street_address'],
  usps_get_city_state: ['zip_code'],
  usps_get_zip_code: ['street_address', 'city', 'state'],
  usps_search_domestic_prices: PACKAGE,
  usps_list_domestic_prices: PACKAGE,
  usps_search_letter_prices: LETTER,
  usps_search_international_prices: INTL_PACKAGE,
  usps_list_international_prices: INTL_PACKAGE,
  usps_search_international_letter_prices: ['destination_country_code', ...LETTER],
  usps_get_delivery_estimates: ['origin_zip_code', 'destination_zip_code'],
  usps_get_service_standards: ['origin_zip_code', 'destination_zip_code'],
  usps_get_international_service_standard: ['country_code', 'mail_class'],
  usps_search_shipping_options: ['origin_zip_code', 'weight', 'length', 'width', 'height'],
  usps_track_package: ['tracking_number'],
  usps_track_packages: ['packages'],
  usps_register_tracking_notifications: ['tracking_number', 'unique_tracking_id', 'notify_event_types', 'recipients'],
  usps_request_proof_of_delivery: ['tracking_number', 'unique_tracking_id', 'recipients'],
  usps_find_post_offices: [],
  usps_find_dropoff_locations: ['destination_zip_code'],
  usps_find_parcel_lockers: [],
  usps_check_pickup_eligibility: ['street_address'],
  usps_get_pickup: ['confirmation_number'],
  usps_get_payment_account: ['account_number'],
  usps_create_payment_authorization: ['crid', 'mid'],
  usps_create_label: LABEL,
  usps_create_return_label: LABEL,
  usps_cancel_label: ['tracking_number', 'payment_authorization_token'],
  usps_create_international_label: [...LABEL, 'customs_form'],
  usps_cancel_international_label: ['tracking_number', 'payment_authorization_token'],
  usps_schedule_pickup: ['pickup_date', 'pickup_address', 'packages', 'estimated_weight', 'pickup_location'],
  usps_cancel_pickup: ['confirmation_number'],
  usps_create_scan_form: ['mailing_date', 'entry_facility_zip_code', 'tracking_numbers', 'from_address'],
};
const SWITCHED_OFF = [
  'usps_cancel_international_label',
  'usps_cancel_label',
  'usps_cancel_pickup',
  'usps_create_international_label',
  'usps_create_label',
  'usps_create_payment_authorization',
  'usps_create_return_label',
  'usps_create_scan_form',
  'usps_schedule_pickup',
];
/** Enabled writes: they send an email from USPS and cost nothing. */
const FREE_WRITES = ['usps_register_tracking_notifications', 'usps_request_proof_of_delivery'];

const call = (name: string, params: Record<string, unknown>, env: Record<string, string> = ENV) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping as never,
    env,
  );
  const tokens = { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService;
  return new RestEngine(tokens, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: cfg.headers,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...env },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (status = 200) => mockedAxios.mockResolvedValueOnce({ status, data: {}, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

const FROM = { firstName: 'Jane', lastName: 'Doe', firm: 'Doe Goods', streetAddress: '4120 Bingham Ave', city: 'Saint Louis', state: 'MO', ZIPCode: '63116' };
const TO = { firstName: 'John', lastName: 'Roe', streetAddress: '1100 Wyoming', secondaryAddress: 'Suite 150', city: 'Saint Louis', state: 'MO', ZIPCode: '63118' };
const PACKAGE_DESCRIPTION = {
  mailClass: 'USPS_GROUND_ADVANTAGE',
  rateIndicator: 'SP',
  processingCategory: 'MACHINABLE',
  destinationEntryFacilityType: 'NONE',
  weight: 2,
  length: 10,
  width: 8,
  height: 4,
  mailingDate: '2026-11-17',
};

describe('usps adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('uses client credentials on the chosen USPS host', () => {
    expect(a.slug).toBe('usps');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('logistics');
    expect(a.icon).toBe('usps');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{USPS_API_HOST}}');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{USPS_CLIENT_ID}}',
      clientSecret: '{{USPS_CLIENT_SECRET}}',
      tokenUrl: '{{USPS_API_HOST}}/oauth2/v3/token',
      tokenAuthMethod: 'client_secret_post',
    });
    expect(a.requiredEnvVars).toEqual(['USPS_CLIENT_ID', 'USPS_CLIENT_SECRET', 'USPS_API_HOST']);
    expect(a.optionalEnvVars).toEqual(['USPS_CRID', 'USPS_MID', 'USPS_EPS_ACCOUNT_NUMBER']);
    expect(a.envVarMeta.USPS_CLIENT_SECRET).toMatchObject({ kind: 'credential', secret: true });
    for (const name of a.optionalEnvVars) expect(a.envVarMeta[name]).toMatchObject({ kind: 'setting', advanced: true });
    for (const name of a.requiredEnvVars) expect(new RegExp(a.envVarMeta[name].pattern!).test(ENV[name])).toBe(true);
    // Optional values only reach the model through the instruction facts.
    for (const name of a.optionalEnvVars) expect(a.instructionFacts.join(' ')).toContain(`{{${name}}}`);
  });

  it('offers production and the Testing Environment for Mailers as the only hosts', () => {
    const host = a.envVarMeta.USPS_API_HOST;
    expect(host.kind).toBe('address');
    expect(host.options!.map((o) => o.value)).toEqual(['https://apis.usps.com', 'https://apis-tem.usps.com']);
    const pattern = new RegExp(host.pattern!);
    for (const option of host.options!) expect(pattern.test(option.value)).toBe(true);
    for (const bad of ['https://apis.usps.com/', 'http://apis.usps.com', 'https://secure.shippingapis.com', 'https://apis-cat.usps.com']) {
      expect(pattern.test(bad)).toBe(false);
    }
  });

  it('sends the Consumer Key and Secret as form fields, without a Basic header', async () => {
    const service = new OAuth2TokenService(
      {} as PrismaService,
      { get: () => 'test-encryption-key-32-chars!!!!' } as unknown as ConfigService,
    );
    const post = jest
      .spyOn(mockedAxios as unknown as typeof axios, 'post')
      .mockResolvedValue({ data: { access_token: 'eyJ.token', token_type: 'Bearer', expires_in: 28799, status: 'approved' } });
    const tem = { ...ENV, USPS_API_HOST: 'https://apis-tem.usps.com' };
    await expect(service.getAccessToken(interpolateDeep({ ...a.connector.authConfig }, tem))).resolves.toBe('eyJ.token');
    const [url, body, options] = post.mock.calls[0] as unknown as [string, string, { headers: Record<string, string> }];
    expect(url).toBe('https://apis-tem.usps.com/oauth2/v3/token');
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
      grant_type: 'client_credentials',
      client_id: ENV.USPS_CLIENT_ID,
      client_secret: ENV.USPS_CLIENT_SECRET,
    });
    expect(options.headers.Authorization).toBeUndefined();
    post.mockRestore();
  });

  it('probes a ZIP Code lookup and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'usps_get_city_state', params: { zip_code: '30022' } });
    expect(tool(a.probe.tool).enabled).not.toBe(false);
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    // What needs USPS approval, and what works with the default app access, is spelled out.
    expect(a.instructions).toMatch(/Carrier Pickup, Payments, Labels, International Labels and SCAN Forms need USPS approval/);
    expect(a.instructions).toMatch(/Enterprise Payment Account/);
    expect(a.instructions).toMatch(/USPS Ship/);
    expect(a.instructions).toContain('https://apis-tem.usps.com');
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
    for (const name of mine) expect(name).toMatch(/^usps_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...a.optionalEnvVars]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(declared.has(arg) || envNames.has(arg)).toBe(true);
      for (const arg of declared) expect(used(entry).has(arg)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(60);
    }
  });

  it('maps every tool to the method and path of the USPS specs', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const entry of a.tools) {
      expect([entry.endpointMapping.method, entry.endpointMapping.path]).toEqual(ROUTES[entry.name]);
      expect(entry.parameters.required ?? []).toEqual(REQUIRED[entry.name]);
    }
  });

  it('installs postage, refunds, pickups and SCAN Forms switched off and marks the reads read-only', () => {
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(SWITCHED_OFF);
    for (const entry of a.tools) {
      const isOff = entry.enabled === false;
      const isWrite = isOff || FREE_WRITES.includes(entry.name);
      expect(annotationsOf(entry).readOnlyHint).toBe(!isWrite);
      expect(/switched off/.test(entry.description)).toBe(isOff);
    }
    for (const name of FREE_WRITES) expect(annotationsOf(tool(name)).destructiveHint).toBe(false);
    // Every label, payment and pickup-booking path is off; the enabled ones only read.
    const enabled = a.tools.filter((entry) => entry.enabled !== false);
    for (const entry of enabled) expect(entry.endpointMapping.path).not.toMatch(/^\/(labels|international-labels|scan-forms)\//);
    expect(enabled.filter((e) => e.endpointMapping.path.startsWith('/payments/')).map((e) => e.endpointMapping.method)).toEqual(['GET']);
    expect(enabled.filter((e) => e.endpointMapping.path.startsWith('/pickup/')).map((e) => e.endpointMapping.method)).toEqual(['GET', 'GET']);
  });

  it('names every tool in the instructions and keeps them free of MDX-breaking characters', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions.startsWith('## USPS')).toBe(true);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.replace(/`[^`]*`/g, '')).not.toMatch(/[{}<]/);
    for (const entry of a.tools) {
      expect(entry.description.replace(/`[^`]*`/g, '')).not.toMatch(/[{}<]/);
      for (const prop of Object.values(entry.parameters.properties ?? {})) {
        expect((prop.description ?? '').replace(/`[^`]*`/g, '')).not.toMatch(/[{}<]/);
      }
    }
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('builds the address requests as query parameters with the bearer token', async () => {
    ok();
    await call('usps_get_city_state', a.probe.params ?? {});
    const req = sent();
    expect(req.url).toBe(`${BASE}/addresses/v3/city-state`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Authorization')).toBe('Bearer test-token');
    expect(req.params).toEqual({ ZIPCode: '30022' });

    ok();
    await call('usps_validate_address', { street_address: '3120 M St', secondary_address: 'NW', city: 'Washington', state: 'DC', zip_code: '20027' });
    expect(sent().url).toBe(`${BASE}/addresses/v3/address`);
    expect(sent().params).toEqual({ streetAddress: '3120 M St', secondaryAddress: 'NW', city: 'Washington', state: 'DC', ZIPCode: '20027' });

    ok();
    await call('usps_get_zip_code', { street_address: '1273 Pale San Vitores Rd', city: 'Tamuning', state: 'GU' });
    expect(sent().url).toBe(`${BASE}/addresses/v3/zipcode`);
    expect(sent().params).toEqual({ streetAddress: '1273 Pale San Vitores Rd', city: 'Tamuning', state: 'GU' });
  });

  it('sends the same request to the test host when it is chosen', async () => {
    ok();
    await call('usps_get_city_state', { zip_code: '30022' }, { ...ENV, USPS_API_HOST: 'https://apis-tem.usps.com' });
    expect(sent().url).toBe('https://apis-tem.usps.com/addresses/v3/city-state');
  });

  it('builds the domestic and international price searches', async () => {
    ok();
    await call('usps_search_domestic_prices', { origin_zip_code: '10001', destination_zip_code: '94105', weight: 3, length: 12, width: 10, height: 6, extra_services: [920] });
    expect(sent().url).toBe(`${BASE}/prices/v3/total-rates/search`);
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual({
      originZIPCode: '10001',
      destinationZIPCode: '94105',
      weight: 3,
      length: 12,
      width: 10,
      height: 6,
      mailClasses: ['ALL'],
      priceType: 'COMMERCIAL',
      extraServices: [920],
    });

    ok();
    await call('usps_list_domestic_prices', { origin_zip_code: '10001', destination_zip_code: '94105', weight: 3, length: 12, width: 10, height: 6, mail_classes: ['PRIORITY_MAIL'], price_type: 'CONTRACT', account_type: 'EPS', account_number: '1000123456' });
    expect(sent().url).toBe(`${BASE}/prices/v3/base-rates-list/search`);
    expect(sent().data).toEqual({
      originZIPCode: '10001',
      destinationZIPCode: '94105',
      weight: 3,
      length: 12,
      width: 10,
      height: 6,
      mailClasses: ['PRIORITY_MAIL'],
      priceType: 'CONTRACT',
      accountType: 'EPS',
      accountNumber: '1000123456',
    });

    ok();
    await call('usps_search_letter_prices', { weight: 1, length: 9.5, height: 4.1, thickness: 0.1, processing_category: 'LETTERS', extra_services: [910] });
    expect(sent().url).toBe(`${BASE}/prices/v3/letter-rates/search`);
    expect(sent().data).toEqual({ weight: 1, length: 9.5, height: 4.1, thickness: 0.1, processingCategory: 'LETTERS', extraServices: [910] });

    ok();
    await call('usps_search_international_prices', {
      origin_zip_code: '10001',
      destination_country_code: 'CA',
      foreign_postal_code: 'K1A 0B1',
      weight: 2,
      length: 10,
      width: 8,
      height: 4,
      request_duties_taxes_fees: true,
      items: [{ itemId: 'MUG1', itemValue: 25, itemQuantity: 2 }],
    });
    expect(sent().url).toBe(`${BASE}/international-prices/v3/total-rates/search`);
    expect(sent().data).toEqual({
      originZIPCode: '10001',
      destinationCountryCode: 'CA',
      foreignPostalCode: 'K1A 0B1',
      weight: 2,
      length: 10,
      width: 8,
      height: 4,
      mailClass: 'ALL',
      priceType: 'COMMERCIAL',
      requestDutiesTaxesFees: true,
      items: [{ itemId: 'MUG1', itemValue: 25, itemQuantity: 2 }],
    });

    ok();
    await call('usps_list_international_prices', { origin_zip_code: '10001', destination_country_code: 'GB', weight: 1, length: 8, width: 6, height: 2 });
    expect(sent().url).toBe(`${BASE}/international-prices/v3/base-rates-list/search`);
    expect(sent().data).toEqual({ originZIPCode: '10001', destinationCountryCode: 'GB', weight: 1, length: 8, width: 6, height: 2, mailClass: 'ALL', priceType: 'COMMERCIAL' });

    ok();
    await call('usps_search_international_letter_prices', { destination_country_code: 'DE', weight: 1, length: 9, height: 4, thickness: 0.1, processing_category: 'LETTERS' });
    expect(sent().url).toBe(`${BASE}/international-prices/v3/letter-rates/search`);
    expect(sent().data).toEqual({ destinationCountryCode: 'DE', weight: 1, length: 9, height: 4, thickness: 0.1, processingCategory: 'LETTERS' });
  });

  it('builds the service standard and shipping options requests', async () => {
    ok();
    await call('usps_get_delivery_estimates', { origin_zip_code: '10018', destination_zip_code: '95823', acceptance_date: '2026-11-17', mail_class: 'PRIORITY_MAIL', destination_type: 'HOLD_FOR_PICKUP', service_type_codes: '925' });
    expect(sent().url).toBe(`${BASE}/service-standards/v3/estimates`);
    expect(sent().params).toEqual({ originZIPCode: '10018', destinationZIPCode: '95823', acceptanceDate: '2026-11-17', mailClass: 'PRIORITY_MAIL', destinationType: 'HOLD_FOR_PICKUP', serviceTypeCodes: '925' });

    ok();
    await call('usps_get_service_standards', { origin_zip_code: '100', destination_zip_code: '95823' });
    expect(sent().url).toBe(`${BASE}/service-standards/v3/standards`);
    expect(sent().params).toEqual({ originZIPCode: '100', destinationZIPCode: '95823', mailClass: 'ALL' });

    ok();
    await call('usps_get_international_service_standard', { country_code: 'CA', mail_class: 'PRIORITY_MAIL_INTERNATIONAL' });
    expect(sent().url).toBe(`${BASE}/international-service-standard/v3/international-service-standard`);
    expect(sent().params).toEqual({ countryCode: 'CA', mailClass: 'PRIORITY_MAIL_INTERNATIONAL' });

    ok();
    await call('usps_search_shipping_options', { origin_zip_code: '05485', destination_zip_code: '38746', weight: 1, length: 6, width: 4, height: 2, package_value: 35 });
    expect(sent().url).toBe(`${BASE}/shipments/v3/options/search`);
    // No empty paymentAccount object unless one is given: the spec uses it only for CONTRACT prices.
    expect(sent().data).toEqual({
      pricingOptions: [{ priceType: 'COMMERCIAL' }],
      originZIPCode: '05485',
      destinationZIPCode: '38746',
      packageDescription: { weight: 1, length: 6, width: 4, height: 2, mailClass: 'ALL', packageValue: 35 },
    });

    ok();
    await call('usps_search_shipping_options', {
      origin_zip_code: '05485',
      destination_country_code: 'CA',
      weight: 1,
      length: 6,
      width: 4,
      height: 2,
      mail_class: 'PRIORITY_MAIL_INTERNATIONAL',
      price_type: 'CONTRACT',
      payment_account: { accountType: 'EPS', accountNumber: '1000123456' },
      shipping_filter: 'PRICE',
    });
    expect(sent().data).toEqual({
      pricingOptions: [{ priceType: 'CONTRACT', paymentAccount: { accountType: 'EPS', accountNumber: '1000123456' } }],
      originZIPCode: '05485',
      destinationCountryCode: 'CA',
      packageDescription: { weight: 1, length: 6, width: 4, height: 2, mailClass: 'PRIORITY_MAIL_INTERNATIONAL' },
      shippingFilter: 'PRICE',
    });
  });

  it('tracks with Tracking 3.2, whose body is a JSON array', async () => {
    ok();
    await call('usps_track_package', { tracking_number: '9400111899223817568426' });
    expect(sent().url).toBe(`${BASE}/tracking/v3r2/tracking`);
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual([{ trackingNumber: '9400111899223817568426' }]);

    ok();
    await call('usps_track_package', { tracking_number: '9400111899223817568426', mailing_date: '2026-11-10', destination_zip_code: '52404' });
    expect(sent().data).toEqual([{ trackingNumber: '9400111899223817568426', mailingDate: '2026-11-10', destinationZIPCode: '52404' }]);

    const packages = [{ trackingNumber: '9400111899223817568426' }, { trackingNumber: '9205590164917312751089', destinationZIPCode: '30022' }];
    ok(207);
    await call('usps_track_packages', { packages });
    expect(sent().url).toBe(`${BASE}/tracking/v3r2/tracking`);
    expect(sent().data).toEqual(packages);

    const recipients = [{ email: 'shipping@example.com', firstName: 'Jane' }];
    ok(202);
    await call('usps_register_tracking_notifications', { tracking_number: '9400111899223817568426', unique_tracking_id: 'abc-123', notify_event_types: ['DELIVERY_ACTIVITY'], recipients });
    expect(sent().url).toBe(`${BASE}/tracking/v3r2/tracking/9400111899223817568426/notifications`);
    expect(sent().data).toEqual({ uniqueTrackingID: 'abc-123', notifyEventTypes: ['DELIVERY_ACTIVITY'], recipients });

    ok(202);
    await call('usps_request_proof_of_delivery', { tracking_number: '9400111899223817568426', unique_tracking_id: 'abc-123', recipients });
    expect(sent().url).toBe(`${BASE}/tracking/v3r2/tracking/9400111899223817568426/proof-of-delivery`);
    expect(sent().data).toEqual({ uniqueTrackingID: 'abc-123', letterType: 'PROOF_OF_DELIVERY', recipients });
  });

  it('builds the location, pickup and payment account reads', async () => {
    ok();
    await call('usps_find_post_offices', { zip_code: '10463', radius: 1 });
    expect(sent().url).toBe(`${BASE}/locations/v3/post-office-locations`);
    expect(sent().params).toEqual({ ZIPCode: '10463', radius: 1, limit: 20 });

    ok();
    await call('usps_find_post_offices', { latitude: 40.75, longitude: -73.99, hours: 'SUNDAY_HOURS', limit: 5, offset: 5 });
    expect(sent().params).toEqual({ LAT: 40.75, LONG: -73.99, hours: 'SUNDAY_HOURS', limit: 5, offset: 5 });

    ok();
    await call('usps_find_dropoff_locations', { destination_zip_code: '30343', mail_class: 'PARCEL_SELECT' });
    expect(sent().url).toBe(`${BASE}/locations/v3/dropoff-locations`);
    expect(sent().params).toEqual({ destinationZIPCode: '30343', mailClass: 'PARCEL_SELECT' });

    ok();
    await call('usps_find_parcel_lockers', { city: 'Los Angeles', state: 'CA' });
    expect(sent().url).toBe(`${BASE}/locations/v3/parcel-locker-locations`);
    expect(sent().params).toEqual({ city: 'Los Angeles', state: 'CA' });

    ok();
    await call('usps_check_pickup_eligibility', { street_address: '4120 Bingham Ave', city: 'Saint Louis', state: 'MO', zip_code: '63116' });
    expect(sent().url).toBe(`${BASE}/pickup/v3/carrier-pickup/eligibility`);
    expect(sent().params).toEqual({ streetAddress: '4120 Bingham Ave', city: 'Saint Louis', state: 'MO', ZIPCode: '63116' });

    ok();
    await call('usps_get_pickup', { confirmation_number: 'WTC123456789' });
    expect(sent().url).toBe(`${BASE}/pickup/v3/carrier-pickup/WTC123456789`);
    expect(String(sent().method).toUpperCase()).toBe('GET');

    ok();
    await call('usps_get_payment_account', { account_number: '1000123456', amount: 25.5 });
    expect(sent().url).toBe(`${BASE}/payments/v3/payment-account/1000123456`);
    expect(sent().params).toEqual({ accountType: 'EPS', amount: 25.5 });
  });

  it('builds the switched-off payment authorization, label, pickup and SCAN Form calls', async () => {
    ok();
    await call('usps_create_payment_authorization', { crid: '56982563', mid: '904128936', account_number: '1000123456' });
    expect(sent().url).toBe(`${BASE}/payments/v3/payment-authorization`);
    const role = { CRID: '56982563', MID: '904128936', accountType: 'EPS', accountNumber: '1000123456' };
    expect(sent().data).toEqual({ roles: [{ roleName: 'PAYER', ...role }, { roleName: 'LABEL_OWNER', ...role }] });

    ok();
    await call('usps_create_label', { payment_authorization_token: 'pay-token', to_address: TO, from_address: FROM, package_description: PACKAGE_DESCRIPTION });
    let req = sent();
    expect(req.url).toBe(`${BASE}/labels/v3/label`);
    expect(String(req.method).toUpperCase()).toBe('POST');
    expect(header(req, 'X-Payment-Authorization-Token')).toBe('pay-token');
    // JSON with the image in base64 instead of the default multipart answer.
    expect(header(req, 'Accept')).toBe(LABELS_JSON);
    expect(header(req, 'X-Idempotency-Key')).toBeUndefined();
    expect(req.data).toEqual({
      imageInfo: { imageType: 'PDF', labelType: '4X6LABEL', receiptOption: 'NONE' },
      toAddress: TO,
      fromAddress: FROM,
      packageDescription: PACKAGE_DESCRIPTION,
    });

    ok();
    await call('usps_create_return_label', { payment_authorization_token: 'pay-token', to_address: FROM, from_address: TO, package_description: PACKAGE_DESCRIPTION, idempotency_key: '3fa85f64-5717-4562-b3fc-2c963f66afa6' });
    req = sent();
    expect(req.url).toBe(`${BASE}/labels/v3/return-label`);
    expect(header(req, 'X-Idempotency-Key')).toBe('3fa85f64-5717-4562-b3fc-2c963f66afa6');
    expect(req.data).toMatchObject({ toAddress: FROM, fromAddress: TO });

    ok();
    await call('usps_cancel_label', { tracking_number: '9400111899223817568426', payment_authorization_token: 'pay-token' });
    req = sent();
    expect(String(req.method).toUpperCase()).toBe('DELETE');
    expect(req.url).toBe(`${BASE}/labels/v3/label/9400111899223817568426`);
    expect(header(req, 'X-Payment-Authorization-Token')).toBe('pay-token');

    const customsForm = { customsContentType: 'MERCHANDISE', AESITN: 'NO EEI 30.37(a)', contents: [{ itemDescription: 'Mug', itemQuantity: 1, itemValue: 25 }] };
    const abroad = { firstName: 'Ann', lastName: 'Lee', streetAddress: '1 Main St', city: 'Toronto', postalCode: 'M5V 2T6', country: 'Canada', countryISOAlpha2Code: 'CA' };
    ok();
    await call('usps_create_international_label', { payment_authorization_token: 'pay-token', to_address: abroad, from_address: FROM, package_description: { ...PACKAGE_DESCRIPTION, mailClass: 'PRIORITY_MAIL_INTERNATIONAL' }, customs_form: customsForm });
    req = sent();
    expect(req.url).toBe(`${BASE}/international-labels/v3/international-label`);
    expect(header(req, 'Accept')).toBe(LABELS_JSON);
    expect(req.data).toMatchObject({ toAddress: abroad, fromAddress: FROM, customsForm });

    ok();
    await call('usps_cancel_international_label', { tracking_number: 'LZ123456789US', payment_authorization_token: 'pay-token' });
    expect(String(sent().method).toUpperCase()).toBe('DELETE');
    expect(sent().url).toBe(`${BASE}/international-labels/v3/international-label/LZ123456789US`);

    const pickup = {
      pickup_date: '2026-11-18',
      pickup_address: { firstName: 'Jane', lastName: 'Doe', address: { streetAddress: '4120 Bingham Ave', city: 'Saint Louis', state: 'MO', ZIPCode: '63116' } },
      packages: [{ packageType: 'PRIORITY_MAIL', packageCount: 2 }],
      estimated_weight: 6,
      pickup_location: { packageLocation: 'FRONT_DOOR' },
    };
    ok();
    await call('usps_schedule_pickup', pickup);
    expect(sent().url).toBe(`${BASE}/pickup/v3/carrier-pickup`);
    expect(sent().data).toEqual({
      pickupDate: '2026-11-18',
      pickupAddress: pickup.pickup_address,
      packages: pickup.packages,
      estimatedWeight: 6,
      pickupLocation: pickup.pickup_location,
    });

    ok();
    await call('usps_cancel_pickup', { confirmation_number: 'WTC123456789' });
    expect(String(sent().method).toUpperCase()).toBe('DELETE');
    expect(sent().url).toBe(`${BASE}/pickup/v3/carrier-pickup/WTC123456789`);

    ok();
    await call('usps_create_scan_form', { mailing_date: '2026-11-18', entry_facility_zip_code: '63116', tracking_numbers: ['9400111899223817568426'], from_address: FROM });
    req = sent();
    expect(req.url).toBe(`${BASE}/scan-forms/v3/scan-form`);
    expect(header(req, 'Accept')).toBe(LABELS_JSON);
    expect(req.data).toEqual({
      mailingDate: '2026-11-18',
      entryFacilityZIPCode: '63116',
      destinationEntryFacilityType: 'NONE',
      shipment: { trackingNumbers: ['9400111899223817568426'] },
      fromAddress: FROM,
    });
  });
});

// Opt-in: RUN_USPS_LIVE=1. The refusal check needs no account; the reads
// need the Consumer Key and Secret of an app (default product). Nothing is
// written.
const live = process.env.RUN_USPS_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('usps: live', () => {
  it('refuses wrong client credentials at the token endpoint', async () => {
    const response = await liveFetch.post(
      `${BASE}/oauth2/v3/token`,
      'grant_type=client_credentials&client_id=not-a-key&client_secret=not-a-secret',
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, validateStatus: () => true },
    );
    expect([400, 401]).toContain(response.status);
  });

  it('looks up a ZIP Code and tracks one number', async () => {
    const id = process.env.USPS_CLIENT_ID;
    const secret = process.env.USPS_CLIENT_SECRET;
    if (!id || !secret) return;
    const token = await liveFetch.post(
      `${BASE}/oauth2/v3/token`,
      new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } },
    );
    expect(token.data.access_token).toBeTruthy();
    const auth = { Authorization: `Bearer ${token.data.access_token}`, Accept: 'application/json' };

    const cityState = await liveFetch.get(`${BASE}/addresses/v3/city-state`, { params: { ZIPCode: '30022' }, headers: auth });
    expect(cityState.data).toMatchObject({ city: 'ALPHARETTA', state: 'GA' });

    const tracking = await liveFetch.post(`${BASE}/tracking/v3r2/tracking`, [{ trackingNumber: '9400111899223817568426' }], {
      headers: { ...auth, 'Content-Type': 'application/json' },
      validateStatus: () => true,
    });
    // An unknown number is a normal answer here: 404, or 200/207 with an error inside.
    expect([200, 207, 404]).toContain(tracking.status);
  });
});
