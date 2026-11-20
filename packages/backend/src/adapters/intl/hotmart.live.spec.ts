import axios from 'axios';
import * as adapter from './hotmart.json';

/**
 * Hotmart API adapter (https://developers.hotmart.com, sandbox
 * https://sandbox.hotmart.com).
 *
 * OAuth 2.0 client credentials: the Client ID and Client Secret of a Hotmart
 * developer credential go as a Basic header to
 * https://api-sec-vlc.hotmart.com/security/oauth/token, which answers a bearer
 * token that lasts about 48 hours. Paths and parameters come from the request
 * samples and parameter lists of the Hotmart Developers docs,
 * https://developers.hotmart.com/docs/en/.
 *
 * Static checks always run. Live checks run only with RUN_HOTMART_LIVE=1:
 * without an account they confirm that the token endpoint and the API refuse
 * wrong credentials; with HOTMART_CLIENT_ID and HOTMART_CLIENT_SECRET they get
 * a token and read one product. Reads only.
 *
 *   RUN_HOTMART_LIVE=1 HOTMART_CLIENT_ID=... HOTMART_CLIENT_SECRET=... npx jest src/adapters/intl/hotmart.live.spec.ts
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: {
    properties?: Record<string, { type?: string; description?: string; default?: unknown; enum?: unknown[]; pattern?: string }>;
    required?: string[];
  };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    bodyEncoding?: string;
    headers?: Record<string, string>;
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
  aliases?: string[];
  instructions: string;
  prerequisites?: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<
    string,
    { label?: string; kind?: string; secret?: boolean; pattern?: string; options?: Array<{ value: string; label: string }> }
  >;
  verifyHints: Record<string, unknown>;
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
const tool = (name: string): Tool => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
/** Tool arguments a mapping reads: {x} in the path, "$x" and "${x}" in query, body and headers. */
const used = (entry: Tool): Set<string> => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) out.add(p);
  const walk = (v: unknown): void => {
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
/** Text outside `code spans`: the website renders descriptions and instructions as MDX. */
const outsideCode = (text: string): string => text.replace(/`[^`]*`/g, '');

// name, HTTP method, path below the base URL
const TOOLS: Array<[string, string, string]> = [
  ['hotmart_get_user', 'GET', '/user/api/v1/me'],
  ['hotmart_list_products', 'GET', '/products/api/v1/products'],
  ['hotmart_list_product_offers', 'GET', '/products/api/v1/products/{ucode}/offers'],
  ['hotmart_list_product_plans', 'GET', '/products/api/v1/products/{ucode}/plans'],
  ['hotmart_list_coupons', 'GET', '/products/api/v1/coupon/product/{product_id}'],
  ['hotmart_list_sales', 'GET', '/payments/api/v1/sales/history'],
  ['hotmart_get_sales_summary', 'GET', '/payments/api/v1/sales/summary'],
  ['hotmart_list_sales_participants', 'GET', '/payments/api/v1/sales/users'],
  ['hotmart_list_sales_commissions', 'GET', '/payments/api/v1/sales/commissions'],
  ['hotmart_list_sales_price_details', 'GET', '/payments/api/v1/sales/price/details'],
  ['hotmart_refund_sale', 'PUT', '/payments/api/v1/sales/{transaction}/refund'],
  ['hotmart_list_subscriptions', 'GET', '/payments/api/v1/subscriptions'],
  ['hotmart_get_subscriptions_summary', 'GET', '/payments/api/v1/subscriptions/summary'],
  ['hotmart_list_subscription_purchases', 'GET', '/payments/api/v1/subscriptions/{subscriber_code}/purchases'],
  ['hotmart_list_subscription_transactions', 'GET', '/payments/api/v1/subscriptions/transactions'],
  ['hotmart_cancel_subscription', 'POST', '/payments/api/v1/subscriptions/{subscriber_code}/cancel'],
  ['hotmart_reactivate_subscription', 'POST', '/payments/api/v1/subscriptions/{subscriber_code}/reactivate'],
  ['hotmart_list_club_students', 'GET', '/club/api/v1/users'],
  ['hotmart_list_club_modules', 'GET', '/club/api/v1/modules'],
  ['hotmart_list_club_pages', 'GET', '/club/api/v2/modules/{module_id}/pages'],
  ['hotmart_get_club_student_progress', 'GET', '/club/api/v1/users/{user_id}/lessons'],
  ['hotmart_get_event_info', 'GET', '/events/api/v1/{event_id}/info'],
  ['hotmart_list_event_participants', 'GET', '/events/api/v1/{event_id}/participants'],
];
const REQUIRED: Record<string, string[]> = {
  hotmart_list_product_offers: ['ucode'],
  hotmart_list_product_plans: ['ucode'],
  hotmart_list_coupons: ['product_id'],
  hotmart_refund_sale: ['transaction'],
  hotmart_list_subscription_purchases: ['subscriber_code'],
  hotmart_cancel_subscription: ['subscriber_code'],
  hotmart_reactivate_subscription: ['subscriber_code'],
  hotmart_list_club_students: ['subdomain'],
  hotmart_list_club_modules: ['subdomain'],
  hotmart_list_club_pages: ['module_id', 'product_id'],
  hotmart_get_club_student_progress: ['user_id', 'subdomain'],
  hotmart_get_event_info: ['event_id'],
  hotmart_list_event_participants: ['event_id'],
};
const SWITCHED_OFF: string[] = ['hotmart_cancel_subscription', 'hotmart_reactivate_subscription', 'hotmart_refund_sale'];

describe('hotmart adapter: static contract', () => {
  it('is filed where the catalog expects it', () => {
    expect(a.slug).toBe('hotmart');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('hotmart');
    expect(a.docsUrl).toBe('https://developers.hotmart.com/docs/en/');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{HOTMART_API_URL}}');
  });

  it('authenticates as the vendor documents', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      'grant': 'client_credentials',
      'clientId': '{{HOTMART_CLIENT_ID}}',
      'clientSecret': '{{HOTMART_CLIENT_SECRET}}',
      'tokenUrl': 'https://api-sec-vlc.hotmart.com/security/oauth/token',
      'tokenAuthMethod': 'client_secret_basic'
    });
    expect(a.requiredEnvVars).toEqual(['HOTMART_CLIENT_ID', 'HOTMART_CLIENT_SECRET', 'HOTMART_API_URL']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    for (const name of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) {
      expect(a.envVarMeta[name]?.label).toBeTruthy();
    }
    for (const name of ['HOTMART_CLIENT_SECRET']) {
      expect(a.envVarMeta[name]).toMatchObject({ kind: 'credential', secret: true });
    }
  });

  it('maps every tool to the documented method and path', () => {
    expect(a.tools.map((entry) => entry.name)).toEqual(TOOLS.map(([name]) => name));
    for (const [name, method, path] of TOOLS) {
      const m = tool(name).endpointMapping;
      expect(`${name}: ${m.method} ${m.path}`).toBe(`${name}: ${method} ${path}`);
    }
  });

  it('prefixes every tool, declares every argument it reads and requires what the API requires', () => {
    const names = new Set(a.tools.map((entry) => entry.name));
    expect(names.size).toBe(a.tools.length);
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      expect(entry.name).toMatch(/^hotmart_[a-z0-9_]+$/);
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect([entry.name, arg, declared.has(arg) || envNames.has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect([entry.name, entry.parameters.required ?? []]).toEqual([entry.name, REQUIRED[entry.name] ?? []]);
      for (const [param, schema] of Object.entries(entry.parameters.properties ?? {})) {
        expect([entry.name, param, Boolean(schema.description)]).toEqual([entry.name, param, true]);
      }
      expect(entry.description.length).toBeGreaterThanOrEqual(60);
    }
  });

  it('installs the risky tools switched off and marks every GET read-only', () => {
    const offNow = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(offNow.sort()).toEqual(SWITCHED_OFF);
    for (const entry of a.tools) {
      const method = entry.endpointMapping.method;
      if (method === 'GET') expect([entry.name, entry.annotations?.readOnlyHint]).toEqual([entry.name, true]);
      if (method === 'DELETE') expect([entry.name, entry.enabled]).toEqual([entry.name, false]);
    }
  });

  it('names every tool in the instructions and keeps the texts MDX-safe', () => {
    expect(a.instructions.startsWith('## ')).toBe(true);
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    const texts = [a.instructions, a.prerequisites ?? '', ...a.tools.map((entry) => entry.description)];
    for (const entry of a.tools) {
      for (const schema of Object.values(entry.parameters.properties ?? {})) texts.push(schema.description ?? '');
    }
    for (const text of texts) {
      expect(outsideCode(text)).not.toMatch(/[{}<]/);
      expect(text).not.toMatch(/\u2014/);
    }
  });

  it('probes with a cheap read and explains the usual refusals', () => {
    expect(a.probe).toEqual({
      'tool': 'hotmart_list_products',
      'params': {
        'max_results': 1
      }
    });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const key of ['401', '403', '404', 'rate_limited', 'invalid_token', 'unauthorized_client', 'invalid_parameter']) expect(a.verifyHints[key]).toBeTruthy();
  });


  it('lets the user choose production or sandbox as the API host', () => {
    expect(a.envVarMeta.HOTMART_API_URL.options).toEqual([
      { value: 'https://developers.hotmart.com', label: 'Production' },
      { value: 'https://sandbox.hotmart.com', label: 'Sandbox (test data)' },
    ]);
    expect(a.envVarMeta.HOTMART_API_URL.secret).toBeUndefined();
    expect(a.connector.baseUrl).toBe('{{HOTMART_API_URL}}');
  });

  it('calls each API under its own path prefix', () => {
    const prefixes = new Set(a.tools.map((entry) => entry.endpointMapping.path.split('/').slice(0, 4).join('/')));
    expect([...prefixes].sort()).toEqual([
      '/club/api/v1',
      '/club/api/v2',
      '/events/api/v1',
      '/payments/api/v1',
      '/products/api/v1',
      '/user/api/v1',
    ]);
  });

  it('filters sales with millisecond dates and an explicit transaction status', () => {
    for (const name of [
      'hotmart_list_sales',
      'hotmart_get_sales_summary',
      'hotmart_list_sales_participants',
      'hotmart_list_sales_commissions',
      'hotmart_list_sales_price_details',
    ]) {
      const entry = tool(name);
      expect(entry.endpointMapping.queryParams).toMatchObject({
        product_id: '$product_id',
        start_date: '$start_date',
        end_date: '$end_date',
        transaction: '$transaction',
        transaction_status: '$transaction_status',
        max_results: '$max_results',
        page_token: '$page_token',
      });
      expect(entry.parameters.properties?.start_date).toMatchObject({ type: 'integer' });
      expect(entry.parameters.properties?.start_date?.description).toContain('milliseconds');
      expect(entry.parameters.properties?.transaction_status?.enum).toContain('REFUNDED');
    }
    // Hotmart's own spelling.
    expect(tool('hotmart_list_sales').parameters.properties?.transaction_status?.enum).toContain('UNDER_ANALISYS');
    // Several statuses travel as repeated query parameters.
    expect(tool('hotmart_list_subscriptions').parameters.properties?.status).toMatchObject({ type: 'array' });
  });

  it('is read-only apart from three tools that install switched off, and never charges a subscriber', () => {
    const writes = a.tools.filter((entry) => entry.endpointMapping.method !== 'GET');
    expect(writes.map((entry) => entry.name).sort()).toEqual([
      'hotmart_cancel_subscription',
      'hotmart_reactivate_subscription',
      'hotmart_refund_sale',
    ]);
    for (const entry of writes) expect([entry.name, entry.enabled]).toEqual([entry.name, false]);
    expect(tool('hotmart_reactivate_subscription').endpointMapping.bodyMapping).toEqual({ charge: false });
    expect(Object.keys(tool('hotmart_reactivate_subscription').parameters.properties ?? {})).toEqual(['subscriber_code']);
    expect(tool('hotmart_refund_sale').endpointMapping.method).toBe('PUT');
    for (const entry of a.tools) {
      expect(entry.endpointMapping.path).not.toMatch(/link|negotiate|switch-plan|physicalproducts|coupon$/);
    }
  });
});


// Opt-in: RUN_HOTMART_LIVE=1. The refusal checks need no account; the read
// needs HOTMART_CLIENT_ID and HOTMART_CLIENT_SECRET of a production credential.
const live = process.env.RUN_HOTMART_LIVE === '1';
const TOKEN_URL = 'https://api-sec-vlc.hotmart.com/security/oauth/token';
(live ? describe : describe.skip)('hotmart: live', () => {
  it('refuses wrong client credentials at the token endpoint', async () => {
    const response = await axios.post(TOKEN_URL, 'grant_type=client_credentials', {
      headers: {
        Authorization: `Basic ${Buffer.from('not-a-client:not-a-secret').toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      validateStatus: () => true,
    });
    expect(response.status).toBe(401);
  });

  it('refuses an invalid token on the API', async () => {
    const response = await axios.get('https://developers.hotmart.com/payments/api/v1/sales/history', {
      headers: { Authorization: 'Bearer not-a-token' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(401);
    expect(response.data).toMatchObject({ error: 'invalid_token' });
  });

  it('gets a token with the Basic header and reads one product', async () => {
    const id = process.env.HOTMART_CLIENT_ID;
    const secret = process.env.HOTMART_CLIENT_SECRET;
    if (!id || !secret) throw new Error('Set HOTMART_CLIENT_ID and HOTMART_CLIENT_SECRET for the live check');
    const token = await axios.post(TOKEN_URL, 'grant_type=client_credentials', {
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      validateStatus: () => true,
    });
    expect(token.status).toBe(200);
    expect(typeof token.data.access_token).toBe('string');
    const products = await axios.get('https://developers.hotmart.com/products/api/v1/products', {
      headers: { Authorization: `Bearer ${token.data.access_token}` },
      params: { max_results: 1 },
      validateStatus: () => true,
    });
    expect(products.status).toBe(200);
  });
});
