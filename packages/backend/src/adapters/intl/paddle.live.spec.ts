import * as adapter from './paddle.json';

/**
 * Paddle Billing API (developer.paddle.com, OpenAPI at github.com/PaddleHQ/paddle-openapi):
 * base https://api.paddle.com or https://sandbox-api.paddle.com (PADDLE_API_URL), Bearer API key,
 * JSON responses with data and meta.pagination (cursor in after).
 * Live part (reads only: event types, products, customers, subscriptions, transactions):
 *   PADDLE_API_KEY=... PADDLE_API_URL=https://sandbox-api.paddle.com RUN_PADDLE_LIVE=1 npx jest src/adapters/intl/paddle
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string; advanced?: boolean }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const ENV = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings (connector variables excluded).
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  for (const e of ENV) out.delete(e);
  return out;
};
const PREFIX = 'paddle_';

describe('paddle adapter: static spec conformance', () => {

  it('authenticates with a Bearer API key against the live or sandbox host', () => {
    expect(a.requiredEnvVars).toEqual(['PADDLE_API_KEY', 'PADDLE_API_URL']);
    expect(a.connector.baseUrl).toBe('{{PADDLE_API_URL}}');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{PADDLE_API_KEY}}' });
    expect(a.envVarMeta?.PADDLE_API_KEY.secret).toBe(true);
    const host = new RegExp(a.envVarMeta?.PADDLE_API_URL.pattern as string);
    expect(host.test('https://api.paddle.com')).toBe(true);
    expect(host.test('https://sandbox-api.paddle.com')).toBe(true);
    expect(host.test('https://api.paddle.com/')).toBe(false);
    expect(host.test('https://vendors.paddle.com')).toBe(false);
    expect(a.category).toBe('payments');
  });

  it('maps catalog, customer and subscription endpoints', () => {
    expect(tool('paddle_list_products').endpointMapping).toMatchObject({ method: 'GET', path: '/products', queryParams: { include: '$include', after: '$after', per_page: '$per_page' } });
    expect(tool('paddle_create_price').endpointMapping).toMatchObject({ method: 'POST', path: '/prices', bodyMapping: { product_id: '$product_id', unit_price: '$unit_price', billing_cycle: '$billing_cycle' } });
    expect(tool('paddle_update_discount').endpointMapping).toMatchObject({ method: 'PATCH', path: '/discounts/{discount_id}' });
    expect(tool('paddle_list_customers').endpointMapping.queryParams).toMatchObject({ email: '$email', search: '$search' });
    expect(tool('paddle_create_customer_address').endpointMapping.path).toBe('/customers/{customer_id}/addresses');
    expect(tool('paddle_update_customer_business').endpointMapping).toMatchObject({ method: 'PATCH', path: '/customers/{customer_id}/businesses/{business_id}' });
    expect(tool('paddle_update_subscription').endpointMapping).toMatchObject({ method: 'PATCH', path: '/subscriptions/{subscription_id}', bodyMapping: { items: '$items', proration_billing_mode: '$proration_billing_mode' } });
    expect(tool('paddle_preview_subscription_update').endpointMapping).toMatchObject({ method: 'PATCH', path: '/subscriptions/{subscription_id}/preview' });
    for (const [n, p] of [['paddle_pause_subscription', 'pause'], ['paddle_resume_subscription', 'resume'], ['paddle_cancel_subscription', 'cancel'], ['paddle_activate_subscription', 'activate'], ['paddle_create_subscription_charge', 'charge']])
      expect(tool(n).endpointMapping).toMatchObject({ method: 'POST', path: `/subscriptions/{subscription_id}/${p}` });
    expect(tool('paddle_resume_subscription').parameters?.required).toContain('effective_from');
  });

  it('maps transactions with bracketed date operators, invoices, adjustments, reports and metrics', () => {
    expect(tool('paddle_list_transactions').endpointMapping.queryParams).toMatchObject({
      'billed_at[GTE]': '$billed_from', 'billed_at[LT]': '$billed_to', 'created_at[GTE]': '$created_from', 'created_at[LT]': '$created_to', invoice_number: '$invoice_number', subscription_id: '$subscription_id',
    });
    expect(tool('paddle_get_transaction_invoice').endpointMapping).toEqual({ method: 'GET', path: '/transactions/{transaction_id}/invoice', queryParams: { disposition: '$disposition' } });
    expect(tool('paddle_preview_transaction').endpointMapping).toMatchObject({ method: 'POST', path: '/transactions/preview' });
    expect(tool('paddle_preview_prices').endpointMapping).toMatchObject({ method: 'POST', path: '/pricing-preview' });
    expect(tool('paddle_create_adjustment').endpointMapping).toMatchObject({ method: 'POST', path: '/adjustments', bodyMapping: { action: '$action', transaction_id: '$transaction_id', reason: '$reason', items: '$items' } });
    expect(tool('paddle_get_adjustment_credit_note').endpointMapping.path).toBe('/adjustments/{adjustment_id}/credit-note');
    expect(tool('paddle_get_report_csv').endpointMapping.path).toBe('/reports/{report_id}/download-url');
    expect(tool('paddle_create_report').parameters?.properties?.type.enum).toContain('payout_reconciliation');
    expect(tool('paddle_get_mrr_metrics').endpointMapping).toEqual({ method: 'GET', path: '/metrics/monthly-recurring-revenue', queryParams: { from: '$from', to: '$to' } });
    expect(tool('paddle_replay_notification').endpointMapping).toMatchObject({ method: 'POST', path: '/notifications/{notification_id}/replay' });
  });

  it('installs the one-time charge and cancel switched off and marks cancel destructive', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(['paddle_cancel_subscription', 'paddle_create_subscription_charge']);
    expect(tool('paddle_cancel_subscription').annotations?.destructiveHint).toBe(true);
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
      for (const r of t.parameters?.required ?? []) expect(`${t.name}:${r}:${props.includes(r)}`).toBe(`${t.name}:${r}:true`);
    }
  });

  it('marks reads over POST or PATCH read-only and deletes destructive', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping.method;
      if (m === 'DELETE') expect(`${t.name}:${t.annotations?.destructiveHint}`).toBe(`${t.name}:true`);
      if (m !== 'GET' && /_(search|find|preview|validate)_|_list_/.test(t.name)) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
      if (m === 'GET') expect(t.annotations?.readOnlyHint === false).toBe(false);
    }
  });

  it('probes with a read tool without required parameters and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const live = process.env.RUN_PADDLE_LIVE === '1' && process.env.PADDLE_API_KEY ? describe : describe.skip;
live('paddle adapter: live (read-only)', () => {
  const base = process.env.PADDLE_API_URL || 'https://sandbox-api.paddle.com';
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${process.env.PADDLE_API_KEY}`, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as { data: unknown; meta?: { pagination?: { has_more?: boolean } } };
  };
  it('reads event types, products, customers, subscriptions and transactions', async () => {
    expect(Array.isArray((await get('/event-types')).data)).toBe(true);
    for (const p of ['/products?per_page=1', '/customers?per_page=1', '/subscriptions?per_page=1', '/transactions?per_page=1']) {
      const body = await get(p);
      expect(Array.isArray(body.data)).toBe(true);
      expect(typeof body.meta?.pagination?.has_more).toBe('boolean');
    }
  }, 60_000);
});
