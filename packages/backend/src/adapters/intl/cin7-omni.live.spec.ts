import axios from 'axios';
import * as adapter from './cin7-omni.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Cin7 Omni adapter (API v1, the original Cin7 at go.cin7.com; not Cin7 Core).
 *
 * Static checks always run: HTTP Basic with the API username and key, every
 * path under https://api.cin7.com/api/v1 as published in Cin7's OpenAPI spec
 * (https://api.cin7.com/api/swagger/v1/swagger.json), the shared paging and
 * where/fields/order filters, writes sent as one-element JSON arrays, no
 * payment writes, and the stock adjustment installed switched off.
 *
 * Live checks run only with RUN_CIN7_OMNI_LIVE=1. Without credentials they
 * confirm a wrong key is refused; with CIN7_OMNI_API_USERNAME and
 * CIN7_OMNI_API_KEY they read one sales order and the branches. Reads only.
 *
 *   RUN_CIN7_OMNI_LIVE=1 CIN7_OMNI_API_USERNAME=... CIN7_OMNI_API_KEY=... \
 *     npx jest src/adapters/intl/cin7-omni.live.spec.ts
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
  CIN7_OMNI_API_USERNAME: 'AcmeTradingNZ',
  CIN7_OMNI_API_KEY: '0123456789abcdef0123456789abcdef',
};
const BASE = 'https://api.cin7.com/api/v1';

const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    ENV,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
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
const ok = (data: unknown = []) => mockedAxios.mockResolvedValueOnce({ status: 200, data, headers: {} });

describe('cin7-omni adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('authenticates with Basic auth and serves every tool from /v1', () => {
    expect(a.slug).toBe('cin7-omni');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('erp');
    expect(a.icon).toBe('cin7-omni');
    expect(a.connector.baseUrl).toBe('https://api.cin7.com/api');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{CIN7_OMNI_API_USERNAME}}', password: '{{CIN7_OMNI_API_KEY}}' });
    expect(a.requiredEnvVars).toEqual(['CIN7_OMNI_API_USERNAME', 'CIN7_OMNI_API_KEY']);
    expect(a.envVarMeta.CIN7_OMNI_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.CIN7_OMNI_API_USERNAME.secret).toBeUndefined();
    expect(new RegExp(a.envVarMeta.CIN7_OMNI_API_KEY.pattern!).test(ENV.CIN7_OMNI_API_KEY)).toBe(true);
    expect(new RegExp(a.envVarMeta.CIN7_OMNI_API_KEY.pattern!).test('short')).toBe(false);
    for (const entry of a.tools) expect(entry.endpointMapping.path).toMatch(/^\/v1\/[A-Za-z]+(\/\{id\})?$/);
  });

  it('explains Omni versus Core in the instructions and the 401 hint', () => {
    expect(a.instructions).toContain('cin7-core');
    expect(a.instructions).toMatch(/3 calls per second, 60 per minute and 5000 per day/);
    expect(a.verifyHints['401']).toMatch(/Cin7 Core/);
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    expect(a.probe).toEqual({ tool: 'cin7_omni_list_sales_orders', params: { rows: 1, fields: 'id' } });
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^cin7_omni_[a-z0-9_]+$/);
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

  it('keeps payments read-only, writes no deletes and installs the stock adjustment switched off', () => {
    for (const entry of a.tools) {
      expect(annotationsOf(entry).readOnlyHint).toBe(entry.endpointMapping.method === 'GET');
      expect(entry.endpointMapping.method).not.toBe('DELETE');
      if (/Payments|CreditNotes/.test(entry.endpointMapping.path)) expect(entry.endpointMapping.method).toBe('GET');
      expect(JSON.stringify(entry.endpointMapping.bodyMapping ?? {})).not.toMatch(/isVoid|dispatchedDate|invoiceDate/);
    }
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off).toEqual(['cin7_omni_create_adjustment']);
  });

  it('names every tool in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('lists sales orders with Basic auth, the where filter and default paging', async () => {
    ok();
    await call('cin7_omni_list_sales_orders', { where: "modifiedDate>='2026-01-01T00:00:00Z'", fields: 'id,reference' });
    const req = sent();
    expect(req.url).toBe(`${BASE}/SalesOrders`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(req.auth).toEqual({ username: ENV.CIN7_OMNI_API_USERNAME, password: ENV.CIN7_OMNI_API_KEY });
    expect(req.params).toEqual({ where: "modifiedDate>='2026-01-01T00:00:00Z'", fields: 'id,reference', page: 1, rows: 25 });

    ok({});
    await call('cin7_omni_get_product', { id: 42 });
    expect(sent().url).toBe(`${BASE}/Products/42`);

    ok();
    await call('cin7_omni_list_stock', { where: 'branchId=3' });
    expect(sent().url).toBe(`${BASE}/Stock`);
    expect(sent().params).toEqual({ where: 'branchId=3', page: 1, rows: 100 });

    ok();
    await call('cin7_omni_list_users', {});
    expect(sent().url).toBe(`${BASE}/Users`);
  });

  it('sends writes as one-element arrays with only the given fields', async () => {
    ok([{ index: 0, success: true, id: 1001 }]);
    await call('cin7_omni_create_sales_order', { member_id: 41, line_items: [{ code: 'ProductZ', qty: 1 }] });
    expect(sent().url).toBe(`${BASE}/SalesOrders`);
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().data).toEqual([{ memberId: 41, isApproved: true, lineItems: [{ code: 'ProductZ', qty: 1 }] }]);

    ok([{ index: 0, success: true, id: 1001 }]);
    await call('cin7_omni_update_sales_order', { id: 1001, stage: 'Processing', tracking_code: 'TRK1' });
    expect(String(sent().method).toUpperCase()).toBe('PUT');
    expect(sent().data).toEqual([{ id: 1001, stage: 'Processing', trackingCode: 'TRK1' }]);

    ok([{ index: 0, success: true, id: 7 }]);
    await call('cin7_omni_create_contact', { type: 'Customer', company: 'Acme Ltd', email: 'ops@acme.example' });
    expect(sent().url).toBe(`${BASE}/Contacts`);
    expect(sent().data).toEqual([{ type: 'Customer', company: 'Acme Ltd', email: 'ops@acme.example' }]);

    ok([{ index: 0, success: true, id: 9 }]);
    await call('cin7_omni_create_branch_transfer', { source_branch_id: 1, destination_branch_id: 2, line_items: [{ code: 'SKU-1', qty: 5 }] });
    expect(sent().url).toBe(`${BASE}/BranchTransfers`);
    expect(sent().data).toEqual([{ sourceBranchId: 1, destinationBranchId: 2, isApproved: false, lineItems: [{ code: 'SKU-1', qty: 5 }] }]);
  });
});

// Opt-in: RUN_CIN7_OMNI_LIVE=1. The refusal check needs no account; the reads
// need CIN7_OMNI_API_USERNAME and CIN7_OMNI_API_KEY. Nothing is written.
const live = process.env.RUN_CIN7_OMNI_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('Cin7 Omni: live', () => {
  it('refuses a wrong key', async () => {
    const response = await liveFetch.get(`${BASE}/Branches`, {
      auth: { username: 'not-a-user', password: 'not-a-real-key-000000' },
      params: { rows: 1 },
      validateStatus: () => true,
    });
    expect([401, 403]).toContain(response.status);
  });

  it('reads one sales order and the branches', async () => {
    const username = process.env.CIN7_OMNI_API_USERNAME;
    const password = process.env.CIN7_OMNI_API_KEY;
    if (!username || !password) throw new Error('Set CIN7_OMNI_API_USERNAME and CIN7_OMNI_API_KEY for the live check');
    const orders = await liveFetch.get(`${BASE}/SalesOrders`, { auth: { username, password }, params: { rows: 1, fields: 'id' }, validateStatus: () => true });
    expect(orders.status).toBe(200);
    expect(Array.isArray(orders.data)).toBe(true);
    const branches = await liveFetch.get(`${BASE}/Branches`, { auth: { username, password }, params: { rows: 5 }, validateStatus: () => true });
    expect(branches.status).toBe(200);
  });
});
