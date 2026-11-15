import axios from 'axios';
import * as adapter from './awin.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Awin adapter (publisher and advertiser API at api.awin.com).
 *
 * Static checks always run: the bearer token, every tool's method and path
 * against Awin's API reference (help.awin.com/apidocs, read Nov 2026), the
 * query names Awin documents (startDate, endDate, timezone, dateType,
 * region...), the offers and link builder bodies, and that transaction
 * validation (approving releases commission) installs switched off.
 * https://help.awin.com/apidocs/introduction-to-awins-apis
 *
 * Live checks run only with RUN_AWIN_LIVE=1. Without a token they confirm
 * that a wrong token is refused; with AWIN_API_TOKEN they list the accounts.
 * Reads only. Not run for the first version: no Awin account was available.
 *
 *   RUN_AWIN_LIVE=1 AWIN_API_TOKEN=... npx jest src/adapters/intl/awin.live.spec.ts
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

type Param = { type?: string; description?: string; pattern?: string; enum?: unknown[]; default?: unknown; items?: Param };
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, Param>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: unknown;
    headers?: Record<string, string>;
    envDefaults?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  description: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string; link?: string; help?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
    headers?: Record<string, string>;
    config?: Record<string, unknown>;
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({ name: entry.name, connectorType: 'REST', endpointMapping: entry.endpointMapping, annotations: entry.annotations } as never);
const used = (entry: Tool) => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (/^\$\w+$/.test(v)) out.add(v.slice(1));
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
const outsideBackticks = (text: string) => text.replace(/`[^`]*`/g, '');

// Method and path of every tool, from the vendor's documentation (see above).
const ROUTES: Record<string, [string, string]> = {
  awin_list_accounts: ['GET', '/accounts'],
  awin_list_programmes: ['GET', '/publishers/{publisher_id}/programmes'],
  awin_get_programme_details: ['GET', '/publishers/{publisher_id}/programmedetails'],
  awin_list_commission_groups: ['GET', '/publishers/{publisher_id}/commissiongroups'],
  awin_list_publisher_transactions: ['GET', '/publishers/{publisher_id}/transactions/'],
  awin_get_publisher_transactions: ['GET', '/publishers/{publisher_id}/transactions'],
  awin_list_transaction_queries: ['GET', '/publisher/{publisher_id}/transactionqueries'],
  awin_get_advertiser_performance_report: ['GET', '/publishers/{publisher_id}/reports/advertiser'],
  awin_get_publisher_campaign_report: ['GET', '/publishers/{publisher_id}/reports/campaign'],
  awin_get_publisher_creative_report: ['GET', '/publishers/{publisher_id}/reports/creative'],
  awin_list_offers: ['POST', '/publisher/{publisher_id}/promotions'],
  awin_generate_tracking_link: ['POST', '/publishers/{publisher_id}/linkbuilder/generate'],
  awin_get_link_builder_quota: ['GET', '/publishers/{publisher_id}/linkbuilder/quota'],
  awin_list_advertiser_transactions: ['GET', '/advertisers/{advertiser_id}/transactions/'],
  awin_get_advertiser_transactions: ['GET', '/advertisers/{advertiser_id}/transactions'],
  awin_get_publisher_performance_report: ['GET', '/advertisers/{advertiser_id}/reports/publisher'],
  awin_get_advertiser_campaign_report: ['GET', '/advertisers/{advertiser_id}/reports/campaign'],
  awin_list_publishers: ['GET', '/advertisers/{advertiser_id}/publishers'],
  awin_list_validation_jobs: ['GET', '/advertisers/{advertiser_id}/transactions/jobs'],
  awin_validate_transactions: ['POST', '/advertisers/{advertiser_id}/transactions/batch'],
};
// Tools that change spend, buy, cancel or delete: installed switched off.
const OFF = ['awin_validate_transactions'];
// POST tools that only read (searches, reports, price estimates).
const READ_POSTS = ['awin_list_offers'];

// Built at runtime so no literal looks like a real credential.
const ENV: Record<string, string> = {
  AWIN_API_TOKEN: ['0a1b2c3d', '4e5f', '6a7b', '8c9d', '0e1f2a3b4c5d'].join('-'),
};

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping as never,
    ENV,
  );
  const tokens = { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService;
  return new RestEngine(tokens, {} as LoginTokenService).execute(
    {
      baseUrl: cfg.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig ?? {}, ENV),
      headers: cfg.headers,
      config: a.connector.config,
    } as never,
    endpointMapping as never,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (data: unknown = {}, status = 200) =>
  mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

describe('awin adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('has the catalog envelope', () => {
    expect(a.slug).toBe('awin');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('advertising');
    expect(a.icon).toBe('awin');
    expect(a.docsUrl).toBe('https://help.awin.com/apidocs/introduction-to-awins-apis');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://api.awin.com');
    expect(a.connector.headers).toMatchObject({ Accept: 'application/json', 'User-Agent': 'AnythingMCP' });
  });

  it('describes every variable and accepts well-formed values', () => {
    const vars = [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])];
    expect(Object.keys(a.envVarMeta).sort()).toEqual([...vars].sort());
    for (const name of vars) {
      const meta = a.envVarMeta[name];
      expect(meta.help).toBeTruthy();
      expect(meta.link).toMatch(/^https:\/\//);
      if (meta.pattern) {
        expect(new RegExp(meta.pattern).test(ENV[name])).toBe(true);
        expect(new RegExp(meta.pattern).test('')).toBe(false);
      }
    }
  });

  it('maps every tool to its documented method and path', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const entry of a.tools) {
      expect([entry.name, entry.endpointMapping.method, entry.endpointMapping.path]).toEqual([entry.name, ...ROUTES[entry.name]]);
    }
  });

  it('installs the spending, buying, cancelling and deleting tools switched off', () => {
    const off = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(off.sort()).toEqual([...OFF].sort());
    for (const name of OFF) expect(tool(name).endpointMapping.method).not.toBe('GET');
  });

  it('marks reads read-only and nothing else', () => {
    for (const entry of a.tools) {
      const read = entry.endpointMapping.method === 'GET' || READ_POSTS.includes(entry.name);
      expect([entry.name, annotationsOf(entry).readOnlyHint === true]).toEqual([entry.name, read]);
    }
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^awin_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)?.tools ?? []) expect(mine.has(other.name)).toBe(false);
    }
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect([entry.name, arg, declared.has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const [param, variable] of Object.entries(entry.endpointMapping.envDefaults ?? {})) {
        expect(declared.has(param)).toBe(true);
        expect(entry.parameters.required ?? []).not.toContain(param);
        expect(a.optionalEnvVars ?? []).toContain(variable);
      }
      expect(entry.description.length).toBeGreaterThan(40);
      for (const prop of Object.values(entry.parameters.properties ?? {})) {
        expect(prop.description).toBeTruthy();
        if (prop.pattern) expect(prop.pattern).not.toMatch(/\\[1-9]/);
      }
    }
  });

  it('keeps the texts free of MDX characters and names every tool in the instructions', () => {
    expect(a.instructions.startsWith('## ')).toBe(true);
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    const texts = [a.description, a.instructions, a.prerequisites, ...Object.values(a.verifyHints)];
    for (const entry of a.tools) {
      texts.push(entry.description);
      for (const prop of Object.values(entry.parameters.properties ?? {})) texts.push(prop.description ?? '');
    }
    for (const text of texts) expect(outsideBackticks(text)).not.toMatch(/[{}<]/);
  });

  it('probes with a cheap read and explains 401, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'awin_list_accounts', params: {} });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).enabled).not.toBe(false);
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('sends the user token as a bearer', async () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{AWIN_API_TOKEN}}' });
    ok([]);
    await call('awin_list_accounts', { type: 'publisher' });
    const req = sent();
    expect(req.url).toBe('https://api.awin.com/accounts');
    expect(header(req, 'Authorization')).toBe(`Bearer ${ENV.AWIN_API_TOKEN}`);
    expect(req.params).toEqual({ type: 'publisher' });
  });

  it('reads publisher transactions with Awin date and time zone parameters', async () => {
    ok([]);
    await call('awin_list_publisher_transactions', {
      publisher_id: '45628',
      start_date: '2026-11-01T00:00:00',
      end_date: '2026-11-15T23:59:59',
      status: 'approved',
    });
    const req = sent();
    expect(req.url).toBe('https://api.awin.com/publishers/45628/transactions/');
    expect(req.params).toEqual({
      startDate: '2026-11-01T00:00:00',
      endDate: '2026-11-15T23:59:59',
      timezone: 'UTC',
      dateType: 'transaction',
      status: 'approved',
    });
  });

  it('requires a region on the publisher reports', () => {
    for (const name of ['awin_get_advertiser_performance_report', 'awin_get_publisher_campaign_report', 'awin_get_publisher_creative_report']) {
      expect(tool(name).parameters.required).toContain('region');
      expect(tool(name).endpointMapping.queryParams).toMatchObject({ region: '$region' });
    }
  });

  it('posts the offer filters and the tracking link as documented', async () => {
    ok([]);
    await call('awin_list_offers', { publisher_id: '45628', region_codes: ['GB'] });
    expect(sent().url).toBe('https://api.awin.com/publisher/45628/promotions');
    expect(sent().data).toEqual({
      filters: { membership: 'joined', type: 'all', status: 'active', regionCodes: ['GB'] },
      pagination: { page: 1, pageSize: 50 },
    });

    ok({ url: 'https://www.awin1.com/x' });
    await call('awin_generate_tracking_link', { publisher_id: '45628', advertiser_id: 1001, destination_url: 'https://shop.example.org/p/1', clickref: 'nl-nov' });
    expect(sent().url).toBe('https://api.awin.com/publishers/45628/linkbuilder/generate');
    expect(sent().data).toEqual({ advertiserId: 1001, destinationUrl: 'https://shop.example.org/p/1', parameters: { clickref: 'nl-nov' }, shorten: false });
  });

  it('sends validation items as the whole body of the switched-off batch tool', async () => {
    const items = [{ action: 'decline', transaction: { transactionId: 1234567, declineReason: 'order returned' } }];
    ok({});
    await call('awin_validate_transactions', { advertiser_id: '1001', transactions: items });
    expect(sent().url).toBe('https://api.awin.com/advertisers/1001/transactions/batch');
    expect(sent().data).toEqual(items);
  });
});

// Opt-in: RUN_AWIN_LIVE=1. The refusal check needs no account; the read
// needs AWIN_API_TOKEN. Nothing is written.
const live = process.env.RUN_AWIN_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('awin: live', () => {
  it('refuses a wrong token', async () => {
    const response = await liveFetch.get('https://api.awin.com/accounts', {
      headers: { Authorization: 'Bearer not-a-token', Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect([401, 403]).toContain(response.status);
  });

  it('lists the accounts of the token', async () => {
    const token = process.env.AWIN_API_TOKEN;
    if (!token) throw new Error('Set AWIN_API_TOKEN for the live check');
    const response = await liveFetch.get('https://api.awin.com/accounts', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
  });
});
