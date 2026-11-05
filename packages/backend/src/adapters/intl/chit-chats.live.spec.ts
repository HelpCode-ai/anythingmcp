import axios from 'axios';
import * as adapter from './chit-chats.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Chit Chats shipping adapter (API v1).
 *
 * Static checks always run: the access token goes in the raw Authorization
 * header (no Bearer prefix), every client path sits below
 * /api/v1/clients/{{CHIT_CHATS_CLIENT_ID}}, public tracking is
 * /tracking/{id}.json on the same host, every argument a mapping reads is
 * declared, and buying postage, refunds and deletes install switched off.
 * Paths follow the published docs:
 * https://github.com/chitchats/chitchats-api-doc (sections/shipments.md,
 * sections/batches.md, sections/tracking.md)
 *
 * Live checks run only with RUN_CHIT_CHATS_LIVE=1. Without credentials they
 * confirm a wrong token is refused; with CHIT_CHATS_ACCESS_TOKEN and
 * CHIT_CHATS_CLIENT_ID they read one page of shipments and batches. Reads only.
 *
 *   RUN_CHIT_CHATS_LIVE=1 CHIT_CHATS_ACCESS_TOKEN=... CHIT_CHATS_CLIENT_ID=... \
 *     npx jest src/adapters/intl/chit-chats.live.spec.ts
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
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({
    name: entry.name,
    connectorType: 'REST',
    endpointMapping: entry.endpointMapping,
    annotations: entry.annotations,
  });
// Every argument a mapping reads: {path} segments, "$arg" values and "${arg}" inside strings.
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
  CHIT_CHATS_ACCESS_TOKEN: 'cc0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5',
  CHIT_CHATS_CLIENT_ID: '999999',
};
const CLIENT = 'https://chitchats.com/api/v1/clients/999999';
const stubLogin = {} as LoginTokenService;

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, stubLogin).execute(
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
const ok = () => mockedAxios.mockResolvedValueOnce({ status: 200, data: {}, headers: {} });

describe('chit-chats adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the raw access token in Authorization and puts the client id in every client path', () => {
    expect(a.slug).toBe('chit-chats');
    expect(a.category).toBe('logistics');
    expect(a.icon).toBe('chit-chats');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://chitchats.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: '{{CHIT_CHATS_ACCESS_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['CHIT_CHATS_ACCESS_TOKEN', 'CHIT_CHATS_CLIENT_ID']);
    expect(a.envVarMeta.CHIT_CHATS_ACCESS_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.CHIT_CHATS_CLIENT_ID.secret).toBeUndefined();
    const token = new RegExp(a.envVarMeta.CHIT_CHATS_ACCESS_TOKEN.pattern!);
    expect(token.test(ENV.CHIT_CHATS_ACCESS_TOKEN)).toBe(true);
    for (const bad of ['', 'short', `Bearer ${ENV.CHIT_CHATS_ACCESS_TOKEN}`]) expect(token.test(bad)).toBe(false);
    const client = new RegExp(a.envVarMeta.CHIT_CHATS_CLIENT_ID.pattern!);
    expect(client.test('999999')).toBe(true);
    for (const bad of ['', '0123', 'abc', 'https://chitchats.com/clients/1']) expect(client.test(bad)).toBe(false);
    for (const entry of a.tools) {
      if (entry.name === 'chit_chats_get_tracking') {
        expect(entry.endpointMapping.path).toBe('/tracking/{shipment_id}.json');
      } else {
        expect(entry.endpointMapping.path.startsWith('/api/v1/clients/{{CHIT_CHATS_CLIENT_ID}}/')).toBe(true);
      }
    }
  });

  it('probes with one shipment and explains 401, 403 and 404', () => {
    expect(a.probe).toEqual({ tool: 'chit_chats_list_shipments', params: { limit: 1 } });
    expect(tool('chit_chats_list_shipments').parameters.required ?? []).toEqual([]);
    for (const status of ['401', '403', '404']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^chit_chats_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(declared.has(arg) || envNames.has(arg)).toBe(true);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(40);
    }
  });

  it('marks reads read-only and installs postage purchase, refund and deletes switched off', () => {
    for (const entry of a.tools) {
      if (entry.endpointMapping.method === 'GET') expect(annotationsOf(entry).readOnlyHint).toBe(true);
      else expect(annotationsOf(entry).readOnlyHint).toBe(false);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual(
      ['chit_chats_buy_postage', 'chit_chats_delete_batch', 'chit_chats_delete_shipment', 'chit_chats_refund_shipment'].sort(),
    );
    for (const name of ['chit_chats_delete_shipment', 'chit_chats_delete_batch']) {
      expect(annotationsOf(tool(name)).destructiveHint).toBe(true);
    }
    for (const name of ['chit_chats_create_shipment', 'chit_chats_refresh_shipment', 'chit_chats_create_batch', 'chit_chats_add_shipments_to_batch']) {
      expect(tool(name).enabled).not.toBe(false);
    }
  });

  it('names every tool in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('lists shipments with the raw token, filters and default paging', async () => {
    ok();
    await call('chit_chats_list_shipments', { status: 'ready', q: 'Jane' });
    const req = sent();
    expect(req.url).toBe(`${CLIENT}/shipments`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(req.headers.Authorization).toBe(ENV.CHIT_CHATS_ACCESS_TOKEN);
    expect(req.params).toEqual({ status: 'ready', q: 'Jane', limit: 100, page: 1 });
  });

  it('creates a shipment with the documented JSON body and ship_date today by default', async () => {
    mockedAxios.mockResolvedValueOnce({ status: 201, data: { shipment: { id: 'ABCDE12345' } }, headers: {} });
    await call('chit_chats_create_shipment', {
      name: 'Jane Doe',
      address_1: '123 ANYWHERE ST.',
      city: 'Vancouver',
      province_code: 'BC',
      postal_code: 'V6K 1A1',
      country_code: 'CA',
      description: 'Hand made bracelet',
      value: '84.99',
      value_currency: 'usd',
      package_type: 'parcel',
      size_unit: 'cm',
      size_x: 10,
      size_y: 5,
      size_z: 2,
      weight_unit: 'g',
      weight: 250,
      postage_type: 'chit_chats_canada_tracked',
    });
    const req = sent();
    expect(req.url).toBe(`${CLIENT}/shipments`);
    expect(String(req.method).toUpperCase()).toBe('POST');
    expect(req.data).toEqual({
      name: 'Jane Doe',
      address_1: '123 ANYWHERE ST.',
      city: 'Vancouver',
      province_code: 'BC',
      postal_code: 'V6K 1A1',
      country_code: 'CA',
      description: 'Hand made bracelet',
      value: '84.99',
      value_currency: 'usd',
      package_type: 'parcel',
      size_unit: 'cm',
      size_x: 10,
      size_y: 5,
      size_z: 2,
      weight_unit: 'g',
      weight: 250,
      postage_type: 'chit_chats_canada_tracked',
      ship_date: 'today',
    });
  });

  it('buys a chosen rate, batches shipments and reads public tracking on the documented paths', async () => {
    ok();
    await call('chit_chats_buy_postage', { shipment_id: 'ABCDE12345', postage_type: 'usps_first' });
    expect(sent().url).toBe(`${CLIENT}/shipments/ABCDE12345/buy`);
    expect(String(sent().method).toUpperCase()).toBe('PATCH');
    expect(sent().data).toEqual({ postage_type: 'usps_first' });

    ok();
    await call('chit_chats_add_shipments_to_batch', { batch_id: 1, shipment_ids: ['ABCDE12345', 'Q5P4R3S2T1'] });
    expect(sent().url).toBe(`${CLIENT}/shipments/add_to_batch`);
    expect(String(sent().method).toUpperCase()).toBe('PATCH');
    expect(sent().data).toEqual({ batch_id: 1, shipment_ids: ['ABCDE12345', 'Q5P4R3S2T1'] });

    ok();
    await call('chit_chats_refresh_shipment', { shipment_id: 'ABCDE12345', insurance_requested: true, ship_date: 'today' });
    expect(sent().url).toBe(`${CLIENT}/shipments/ABCDE12345/refresh`);
    expect(sent().data).toEqual({ insurance_requested: true, ship_date: 'today' });

    ok();
    await call('chit_chats_list_batches', { state: 'pending' });
    expect(sent().url).toBe(`${CLIENT}/batches`);
    expect(sent().params).toEqual({ state: 'pending', limit: 100, page: 1 });

    ok();
    await call('chit_chats_get_tracking', { shipment_id: 'B5T85U7E1C' });
    expect(sent().url).toBe('https://chitchats.com/tracking/B5T85U7E1C.json');
    expect(String(sent().method).toUpperCase()).toBe('GET');
  });
});

// Opt-in: RUN_CHIT_CHATS_LIVE=1. The refusal check needs no account; the reads
// need CHIT_CHATS_ACCESS_TOKEN and CHIT_CHATS_CLIENT_ID. Nothing is created or bought.
const live = process.env.RUN_CHIT_CHATS_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('Chit Chats: live', () => {
  it('refuses a wrong token', async () => {
    const response = await liveFetch.get('https://chitchats.com/api/v1/clients/1/shipments', {
      headers: { Authorization: 'not-a-real-token', Accept: 'application/json' },
      params: { limit: 1 },
      validateStatus: () => true,
    });
    expect([401, 403]).toContain(response.status);
  });

  it('reads one page of shipments and batches', async () => {
    const token = process.env.CHIT_CHATS_ACCESS_TOKEN;
    const client = process.env.CHIT_CHATS_CLIENT_ID;
    if (!token || !client) throw new Error('Set CHIT_CHATS_ACCESS_TOKEN and CHIT_CHATS_CLIENT_ID for the live check');
    const headers = { Authorization: token, Accept: 'application/json' };
    const base = `https://chitchats.com/api/v1/clients/${client}`;
    const shipments = await liveFetch.get(`${base}/shipments`, { headers, params: { limit: 1 }, validateStatus: () => true });
    expect(shipments.status).toBe(200);
    expect(Array.isArray(shipments.data)).toBe(true);
    const batches = await liveFetch.get(`${base}/batches`, { headers, params: { limit: 1 }, validateStatus: () => true });
    expect(batches.status).toBe(200);
    expect(Array.isArray(batches.data)).toBe(true);
  });
});
