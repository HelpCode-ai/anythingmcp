import axios from 'axios';
import * as adapter from './ablefy.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * ablefy (formerly elopage) API adapter.
 *
 * Static checks always run: the API key and secret as query parameters, every
 * tool's method and path against the Swagger document ablefy publishes
 * (https://api.elopage.com/api/swagger_doc), the invoice filters, the body of
 * the free order, and which tools install switched off. There is no refund
 * tool: nothing here moves money.
 *
 * Live checks run only with RUN_ABLEFY_LIVE=1. Without credentials they
 * confirm that the API refuses an anonymous call; with ABLEFY_API_KEY and
 * ABLEFY_API_SECRET they read the account. Reads only.
 *
 *   RUN_ABLEFY_LIVE=1 ABLEFY_API_KEY=... ABLEFY_API_SECRET=... \
 *     npx jest src/adapters/de/ablefy.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; type?: string; pattern?: string; default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    bodyEncoding?: string;
    envDefaults?: Record<string, string>;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
  responseMapping?: { transform?: { exclude?: string[] } };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  instructions: string;
  aliases?: string[];
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean; options?: Array<{ value: string; label: string }> }>;
  verifyHints: Record<string, unknown>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
    config?: { errorWhen?: unknown };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({ name: entry.name, connectorType: 'REST', endpointMapping: entry.endpointMapping, annotations: entry.annotations });
// Every argument a mapping reads: {path} parts, "$name" values and ${name} in strings.
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
  ABLEFY_API_KEY: 'test-api-key-0123456789',
  ABLEFY_API_SECRET: 'test-api-secret-0123456789',
};

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
      errorWhen: a.connector.config?.errorWhen,
    } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...ENV },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = (data: unknown = {}, status = 200) => mockedAxios.mockResolvedValueOnce({ status, data, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
// The query string as it goes over the wire, percent-decoded for reading.
const wire = (req: { params: Record<string, unknown>; paramsSerializer: (p: Record<string, unknown>) => string }) =>
  decodeURIComponent(req.paramsSerializer(req.params));

// name, HTTP method, path
const TOOLS: Array<[string, string, string]> = [
  ['ablefy_get_account', 'GET', '/api/me'],
  ['ablefy_list_products', 'GET', '/api/products'],
  ['ablefy_get_product', 'GET', '/api/products/{product_id}'],
  ['ablefy_list_pricing_plans', 'GET', '/api/pricing_plans'],
  ['ablefy_get_pricing_plan', 'GET', '/api/pricing_plans/{pricing_plan_id}'],
  ['ablefy_get_order', 'GET', '/api/orders/{order_id}'],
  ['ablefy_get_payment', 'GET', '/api/payments/{payment_id}'],
  ['ablefy_get_transfer', 'GET', '/api/transfers/{transfer_id}'],
  ['ablefy_get_payer', 'GET', '/api/payers/{transfer_ext_id}'],
  ['ablefy_list_invoices', 'GET', '/api/invoices'],
  ['ablefy_create_free_order', 'POST', '/api/orders'],
  ['ablefy_cancel_order', 'POST', '/api/orders/{order_token}/cancel'],
  ['ablefy_list_event_tickets', 'GET', '/api/events/{event_id}/e_tickets'],
  ['ablefy_list_publishers', 'GET', '/api/publishers'],
  ['ablefy_list_affiliate_redirections', 'GET', '/api/affiliate_redirections'],
  ['ablefy_enroll_publisher', 'POST', '/api/publishers/{publisher_id}/enroll'],
  ['ablefy_unenroll_publisher', 'POST', '/api/publishers/{publisher_id}/unenroll'],
  ['ablefy_list_funnels', 'GET', '/api/funnels'],
  ['ablefy_get_funnel', 'GET', '/api/funnels/{funnel_id}'],
  ['ablefy_list_webhook_endpoints', 'GET', '/api/webhook_endpoints'],
  ['ablefy_get_webhook_endpoint', 'GET', '/api/webhook_endpoints/{webhook_endpoint_id}'],
];
const REQUIRED: Record<string, string[]> = {
  ablefy_get_product: ['product_id'],
  ablefy_get_pricing_plan: ['pricing_plan_id'],
  ablefy_get_order: ['order_id'],
  ablefy_get_payment: ['payment_id'],
  ablefy_get_transfer: ['transfer_id'],
  ablefy_get_payer: ['transfer_ext_id'],
  ablefy_create_free_order: ['product_id', 'email', 'first_name', 'last_name'],
  ablefy_cancel_order: ['order_token'],
  ablefy_list_event_tickets: ['event_id'],
  ablefy_enroll_publisher: ['publisher_id', 'affiliate_program_id'],
  ablefy_unenroll_publisher: ['publisher_id', 'affiliate_program_id'],
  ablefy_get_funnel: ['funnel_id'],
  ablefy_get_webhook_endpoint: ['webhook_endpoint_id'],
};
const OFF: string[] = ['ablefy_create_free_order', 'ablefy_cancel_order', 'ablefy_unenroll_publisher'];

describe('ablefy adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends key and secret as query parameters to api.elopage.com', () => {
    expect(a.slug).toBe('ablefy');
    expect(a.region).toBe('de');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('ablefy');
    expect(a.aliases).toContain('elopage');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://api.elopage.com');
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ key: '{{ABLEFY_API_KEY}}', secret: '{{ABLEFY_API_SECRET}}' });
    expect(a.requiredEnvVars).toEqual(['ABLEFY_API_KEY', 'ABLEFY_API_SECRET']);
    for (const name of a.requiredEnvVars) {
      expect(a.envVarMeta[name]).toMatchObject({ kind: 'credential', secret: true });
      expect(new RegExp(a.envVarMeta[name].pattern!).test(ENV[name])).toBe(true);
      expect(new RegExp(a.envVarMeta[name].pattern!).test('has a space')).toBe(false);
    }
    expect(a.probe).toEqual({ tool: 'ablefy_get_account', params: {} });
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('has no refund tool and never deletes', () => {
    for (const entry of a.tools) {
      expect(entry.endpointMapping.path).toMatch(/^\/api\//);
      expect(entry.endpointMapping.path).not.toContain('refund');
      expect(entry.name).not.toMatch(/refund|delete/);
      expect(['GET', 'POST']).toContain(entry.endpointMapping.method);
    }
    // Cancelling an order and removing a publisher are deliberate switches.
    expect(tool('ablefy_cancel_order').enabled).toBe(false);
    expect(tool('ablefy_unenroll_publisher').enabled).toBe(false);
  });

  it('pins every tool to its documented method and path', () => {
    expect(a.tools.map((entry) => [entry.name, entry.endpointMapping.method, entry.endpointMapping.path])).toEqual(TOOLS);
  });

  it('requires exactly the documented parameters', () => {
    for (const entry of a.tools) expect([entry.name, entry.parameters.required ?? []]).toEqual([entry.name, REQUIRED[entry.name] ?? []]);
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^ablefy_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect([entry.name, arg, declared.has(arg) || envNames.has(arg)]).toEqual([entry.name, arg, true]);
      for (const arg of declared) expect([entry.name, arg, used(entry).has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const [param, def] of Object.entries(entry.parameters.properties ?? {})) expect([param, Boolean(def.description)]).toEqual([param, true]);
      expect(entry.description.length).toBeGreaterThan(60);
    }
  });

  it('marks reads read-only and installs only the listed tools switched off', () => {
    for (const entry of a.tools) {
      const read = entry.endpointMapping.method === 'GET';
      expect([entry.name, annotationsOf(entry).readOnlyHint]).toEqual([entry.name, read]);
    }
    expect(a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name).sort()).toEqual([...OFF].sort());
  });

  it('names every tool in the instructions and keeps the text free of MDX traps', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    const outsideCode = (text: string) => text.replace(/`[^`]*`/g, '');
    for (const text of [a.instructions, ...a.tools.map((entry) => entry.description)]) {
      expect(outsideCode(text)).not.toMatch(/[{}<]/);
      expect(text).not.toMatch(/\u2014/);
    }
  });

  it('lists invoices with the documented filters and the key pair in the query', async () => {
    ok([]);
    await call('ablefy_list_invoices', { date_from: '2026-10-01', invoice_state: 'paid', product_id: 42 });
    const req = sent();
    expect(req.url).toBe('https://api.elopage.com/api/invoices');
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(header(req, 'Accept')).toBe('application/json');
    expect(wire(req)).toBe(`key=${ENV.ABLEFY_API_KEY}&secret=${ENV.ABLEFY_API_SECRET}&page=1&date_from=2026-10-01&invoice_state=paid&product_id=42`);

    ok([]);
    await call('ablefy_list_event_tickets', { event_id: 9, last_updated_date: '2026-10-01T00:00:00Z' });
    expect(sent().url).toBe('https://api.elopage.com/api/events/9/e_tickets');
    expect(sent().params).toEqual({ key: ENV.ABLEFY_API_KEY, secret: ENV.ABLEFY_API_SECRET, count: 1000, last_updated_date: '2026-10-01T00:00:00Z' });

    ok({});
    await call('ablefy_get_payment', { payment_id: 'pay_123' });
    expect(sent().url).toBe('https://api.elopage.com/api/payments/pay_123');
    expect(sent().params).toEqual({ key: ENV.ABLEFY_API_KEY, secret: ENV.ABLEFY_API_SECRET });
  });

  it('creates a free order, cancels by token and enrolls a publisher', async () => {
    ok({}, 201);
    await call('ablefy_create_free_order', { product_id: 42, email: 'anna@school.org', first_name: 'Anna', last_name: 'Berg', pricing_plan_id: 7 });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe('https://api.elopage.com/api/orders');
    expect(sent().params).toEqual({ key: ENV.ABLEFY_API_KEY, secret: ENV.ABLEFY_API_SECRET });
    expect(sent().data).toEqual({ product_id: 42, email: 'anna@school.org', first_name: 'Anna', last_name: 'Berg', prid: 7 });

    ok({}, 201);
    await call('ablefy_cancel_order', { order_token: 'tok_1' });
    expect(String(sent().method).toUpperCase()).toBe('POST');
    expect(sent().url).toBe('https://api.elopage.com/api/orders/tok_1/cancel');

    ok({}, 201);
    await call('ablefy_enroll_publisher', { publisher_id: 5, affiliate_program_id: 3 });
    expect(sent().url).toBe('https://api.elopage.com/api/publishers/5/enroll');
    expect(sent().data).toEqual({ affiliate_program_id: 3 });
  });
});

// Opt-in: RUN_ABLEFY_LIVE=1. The refusal check needs no account; the read
// needs ABLEFY_API_KEY and ABLEFY_API_SECRET. Nothing is written.
const live = process.env.RUN_ABLEFY_LIVE === '1';
const liveFetch = mockedAxios.__actual;
(live ? describe : describe.skip)('ablefy: live', () => {
  it('refuses a call without key and secret', async () => {
    const response = await liveFetch.get('https://api.elopage.com/api/me', { validateStatus: () => true });
    expect(response.status).toBe(401);
  });

  it('reads the account', async () => {
    const key = process.env.ABLEFY_API_KEY;
    const secret = process.env.ABLEFY_API_SECRET;
    if (!key || !secret) return;
    const response = await liveFetch.get('https://api.elopage.com/api/me', { params: { key, secret }, validateStatus: () => true });
    expect(response.status).toBe(200);
  });
});
