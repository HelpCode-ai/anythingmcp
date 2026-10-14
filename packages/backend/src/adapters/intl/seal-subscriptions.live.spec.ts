import axios from 'axios';
import * as adapter from './seal-subscriptions.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Seal Subscriptions adapter:
 *
 *   1. Static: always runs. Pins the X-Seal-Token header, every tool's method,
 *      URL, query and body through the real RestEngine, checked against Seal's
 *      merchant API documentation
 *      (sealsubscriptions.com/articles/merchant-api-documentation, read 13 Oct
 *      2026): /subscription with an `action` in the PUT body, billing attempts
 *      by id and subscription_id, discount codes, rules and webhooks. Also the
 *      switched-off cancel, delete and charge tools and the removal of the
 *      customer's secret edit_url from answers.
 *
 *   2. Live: skipped unless RUN_SEAL_SUBSCRIPTIONS_LIVE=1. Without a token it
 *      checks that Seal refuses a wrong one with 403 on real routes and answers
 *      404 on a made-up one. With SEAL_SUBSCRIPTIONS_API_TOKEN it reads the
 *      first page of rules and subscriptions (nothing is changed):
 *
 *        RUN_SEAL_SUBSCRIPTIONS_LIVE=1 SEAL_SUBSCRIPTIONS_API_TOKEN=... npx jest src/adapters/intl/seal-subscriptions.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: unknown[] }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
    config: { errorWhen: unknown[] };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const BASE = 'https://app.sealsubscriptions.com/shopify/merchant/api';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = 'seal-test-' + 'x'.repeat(24);
const ENV: Record<string, string> = { SEAL_SUBSCRIPTIONS_API_TOKEN: FAKE_TOKEN };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; schema defaults applied before the call.
const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[0][0];

const SWITCHED_OFF = [
  'seal_subscriptions_cancel_subscription',
  'seal_subscriptions_charge_now',
  'seal_subscriptions_delete_webhook',
  'seal_subscriptions_get_customer_magic_link',
  'seal_subscriptions_process_billing_attempt',
  'seal_subscriptions_remove_discount_code',
  'seal_subscriptions_remove_items',
  'seal_subscriptions_schedule_cancellation',
];

describe('seal-subscriptions adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: verified read-only on a live account on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('seal-subscriptions');
  });

  it('sends the shop token in X-Seal-Token, on the merchant API', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Seal-Token', apiKey: '{{SEAL_SUBSCRIPTIONS_API_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/subscription-rules?page=1');
    expect(a.requiredEnvVars).toEqual(['SEAL_SUBSCRIPTIONS_API_TOKEN']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'SEAL_SUBSCRIPTIONS_API_TOKEN', kind: 'credential', secret: true, required: true });
    const pattern = new RegExp(a.envVarMeta.SEAL_SUBSCRIPTIONS_API_TOKEN.pattern!);
    expect(pattern.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', `X-Seal-Token: ${FAKE_TOKEN}`, `${FAKE_TOKEN} `, 'short']) expect(pattern.test(bad)).toBe(false);
  });

  it('probes with the rules list and explains 403 and the 503 concurrency limit', () => {
    expect(a.probe).toEqual({ tool: 'seal_subscriptions_list_rules' });
    expect(a.verifyHints['403']).toMatch(/General Settings > API/);
    expect(a.verifyHints['503']).toMatch(/10 requests/);
    expect(a.connector.config.errorWhen).toEqual([{ path: 'success', equals: false, messagePath: 'error', status: 400 }]);
  });

  it('prefixes every tool and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^seal_subscriptions_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('ships cancel, removals, deletes, charges and the magic link switched off', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(SWITCHED_OFF);
  });

  it('marks the GETs read-only and asks for confirmation on every write', () => {
    for (const t of a.tools) {
      const readOnly = annotationsOf(t).readOnlyHint === true;
      expect(`${t.name}:${readOnly}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
      if (!readOnly) expect(t.description).toMatch(/confirm/i);
    }
  });

  it('only points the model at tools that exist, documents setup, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bseal_subscriptions_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bseal_subscriptions_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/General Settings > API/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('carries valid response mappings', () => {
    for (const t of a.tools) {
      if (t.responseMapping?.transform) expect(validateTransform(t.responseMapping.transform)).toBeNull();
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['seal_subscriptions_list_subscriptions', {}, 'GET', `${BASE}/subscriptions`],
    ['seal_subscriptions_list_by_billing_date', { from_datetime: '2026-10-19T00:00:00', to_datetime: '2026-10-25T23:59:59' }, 'GET', `${BASE}/subscriptions-by-billing-date`],
    ['seal_subscriptions_get_subscription', { id: 123 }, 'GET', `${BASE}/subscription`],
    ['seal_subscriptions_pause_subscription', { id: 123 }, 'PUT', `${BASE}/subscription`],
    ['seal_subscriptions_resume_subscription', { id: 123 }, 'PUT', `${BASE}/subscription`],
    ['seal_subscriptions_cancel_subscription', { id: 123 }, 'PUT', `${BASE}/subscription`],
    ['seal_subscriptions_schedule_cancellation', { id: 123, date: '2026-12-31' }, 'PUT', `${BASE}/subscription-schedule-cancellation`],
    ['seal_subscriptions_update_subscription', { id: 123, delivery_interval: '2 week' }, 'PUT', `${BASE}/subscription`],
    ['seal_subscriptions_add_items', { id: 123, items: [{ product_id: '1', variant_id: '2', quantity: 1, title: 'Coffee', price: 9.9 }] }, 'PUT', `${BASE}/subscription`],
    ['seal_subscriptions_edit_items', { id: 123, items: [{ id: 9, quantity: 2 }] }, 'PUT', `${BASE}/subscription`],
    ['seal_subscriptions_remove_items', { id: 123, item_ids: [9] }, 'PUT', `${BASE}/subscription`],
    ['seal_subscriptions_skip_billing_attempt', { id: 77, subscription_id: 123 }, 'PUT', `${BASE}/subscription-billing-attempt`],
    ['seal_subscriptions_unskip_billing_attempt', { id: 77, subscription_id: 123 }, 'PUT', `${BASE}/subscription-billing-attempt`],
    ['seal_subscriptions_reschedule_billing_attempt', { id: 77, subscription_id: 123, date: '2026-11-02' }, 'PUT', `${BASE}/subscription-billing-attempt`],
    ['seal_subscriptions_charge_now', { id: 123 }, 'PUT', `${BASE}/subscription-create-charge-now`],
    ['seal_subscriptions_process_billing_attempt', { subscription_id: 123, billing_attempt_id: 77 }, 'PUT', `${BASE}/subscription-process-charge`],
    ['seal_subscriptions_apply_discount_code', { subscription_id: 123, discount_code: 'LOYAL10' }, 'PUT', `${BASE}/subscription-discount-code`],
    ['seal_subscriptions_remove_discount_code', { subscription_id: 123, discount_code_id: 'd4d2be91' }, 'DELETE', `${BASE}/subscription-discount-code`],
    ['seal_subscriptions_get_payment_update_url', { id: 123 }, 'GET', `${BASE}/subscription-payment-method-update-url`],
    ['seal_subscriptions_send_payment_update_email', { id: 123 }, 'PUT', `${BASE}/subscription`],
    ['seal_subscriptions_get_customer_magic_link', { email: 'a@example.com' }, 'GET', `${BASE}/customer-magic-link`],
    ['seal_subscriptions_list_rules', {}, 'GET', `${BASE}/subscription-rules`],
    ['seal_subscriptions_get_rule', { id: 5 }, 'GET', `${BASE}/subscription-rule`],
    ['seal_subscriptions_list_webhooks', {}, 'GET', `${BASE}/webhooks`],
    ['seal_subscriptions_create_webhook', { topic: 'subscription/cancelled', address: 'https://example.com/hook' }, 'POST', `${BASE}/webhooks`],
    ['seal_subscriptions_delete_webhook', { id: 8 }, 'DELETE', `${BASE}/webhooks`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the shop token', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.headers['X-Seal-Token']).toBe(FAKE_TOKEN);
    expect(req.headers['Content-Type']).toBe('application/json');
  });

  it('lists subscriptions with Seal\'s hyphenated filters', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('seal_subscriptions_list_subscriptions', { query: 'john', page: 2, active_only: true, with_billing_attempts: true });
    expect(sent().params).toEqual({ query: 'john', page: 2, 'active-only': true, 'with-billing-attempts': true });
    mockedAxios.mockClear();
    await call('seal_subscriptions_list_by_billing_date', { from_datetime: '2026-10-19T00:00:00', to_datetime: '2026-10-25T23:59:59', cursor: 'abc' });
    expect(sent().params).toEqual({ from_datetime: '2026-10-19T00:00:00', to_datetime: '2026-10-25T23:59:59', cursor: 'abc' });
  });

  it('sends the documented action bodies on /subscription', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const bodies: Array<[string, Record<string, unknown>, unknown]> = [
      ['seal_subscriptions_pause_subscription', { id: 123 }, { id: 123, action: 'pause' }],
      ['seal_subscriptions_resume_subscription', { id: 123 }, { id: 123, action: 'resume' }],
      ['seal_subscriptions_resume_subscription', { id: 123, action: 'reactivate' }, { id: 123, action: 'reactivate' }],
      ['seal_subscriptions_cancel_subscription', { id: 123 }, { id: 123, action: 'cancel' }],
      ['seal_subscriptions_send_payment_update_email', { id: 123 }, { id: 123, action: 'send_payment_method_update_email' }],
      ['seal_subscriptions_remove_items', { id: 123, item_ids: [9, 10] }, { id: 123, action: 'remove_items', remove_items: [9, 10] }],
      ['seal_subscriptions_edit_items', { id: 123, items: [{ id: 9, quantity: 2 }] }, { id: 123, action: 'edit_items', edit_items: [{ id: 9, quantity: 2 }] }],
      [
        'seal_subscriptions_update_subscription',
        { id: 123, delivery_interval: '4 week', billing_interval: '8 week', s_city: 'Wien' },
        { id: 123, action: 'edit', edit: { delivery_interval: '4 week', billing_interval: '8 week', s_city: 'Wien' } },
      ],
    ];
    for (const [name, params, body] of bodies) {
      mockedAxios.mockClear();
      await call(name, params);
      expect(sent().data).toEqual(body);
    }
  });

  it('skips, reschedules and charges billing attempts with the documented fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('seal_subscriptions_skip_billing_attempt', { id: 77, subscription_id: 123 });
    expect(sent().data).toEqual({ id: 77, subscription_id: 123, action: 'skip' });
    mockedAxios.mockClear();
    await call('seal_subscriptions_reschedule_billing_attempt', { id: 77, subscription_id: 123, date: '2026-11-02' });
    expect(sent().data).toEqual({ id: 77, subscription_id: 123, date: '2026-11-02', time: '09:00', timezone: '+00:00', action: 'reschedule' });
    mockedAxios.mockClear();
    await call('seal_subscriptions_schedule_cancellation', { id: 123, date: '2026-12-31', time: '13:00' });
    expect(sent().data).toEqual({ id: 123, date: '2026-12-31', time: '13:00', timezone: '+00:00' });
    mockedAxios.mockClear();
    await call('seal_subscriptions_process_billing_attempt', { subscription_id: 123, billing_attempt_id: 77 });
    expect(sent().data).toEqual({ subscription_id: 123, billing_attempt_id: 77 });
    mockedAxios.mockClear();
    await call('seal_subscriptions_remove_discount_code', { subscription_id: 123, discount_code_id: 'd4d2be91' });
    expect(sent().params).toEqual({ subscription_id: 123, discount_code_id: 'd4d2be91' });
    expect(sent().data).toBeUndefined();
  });

  it('removes the customer\'s secret edit_url from subscription answers', () => {
    const one = { success: true, payload: { id: 1, status: 'ACTIVE', edit_url: 'https://secret', email: 'a@example.com' } };
    const out = applyResponseTransform(one, tool('seal_subscriptions_get_subscription').responseMapping as any);
    expect(out.value).toEqual({ success: true, payload: { id: 1, status: 'ACTIVE', email: 'a@example.com' } });
    for (const raw of [
      { success: true, payload: { subscriptions: [{ id: 1, edit_url: 'https://secret' }, { id: 2, edit_url: 'https://secret2' }] } },
      { success: true, payload: [{ id: 1, edit_url: 'https://secret' }] },
    ]) {
      const listed = applyResponseTransform(raw, tool('seal_subscriptions_list_subscriptions').responseMapping as any);
      expect(JSON.stringify(listed.value)).not.toContain('secret');
      expect(JSON.stringify(listed.value)).toContain('"id":1');
    }
  });
});

const live = process.env.RUN_SEAL_SUBSCRIPTIONS_LIVE === '1' ? describe : describe.skip;
live('seal-subscriptions adapter: live', () => {
  const realToken = process.env.SEAL_SUBSCRIPTIONS_API_TOKEN;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['seal_subscriptions_list_rules', {}],
    ['seal_subscriptions_list_subscriptions', { page: 1 }],
    ['seal_subscriptions_get_subscription', { id: 1 }],
    ['seal_subscriptions_list_webhooks', {}],
  ])('%s: Seal refuses a wrong token with 403', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 403 } });
  }, 30000);

  it('answers 404 on a made-up route', async () => {
    await expect(
      (mockedAxios.__actual as any).request({ url: `${BASE}/does-not-exist-xyz`, method: 'GET', headers: { 'X-Seal-Token': FAKE_TOKEN } }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (realToken ? it : it.skip)('reads the rules and the first page of subscriptions', async () => {
    const env = { SEAL_SUBSCRIPTIONS_API_TOKEN: realToken! };
    const rules = await call('seal_subscriptions_list_rules', {}, env);
    expect(rules.success).toBe(true);
    const subs = await call('seal_subscriptions_list_subscriptions', { page: 1 }, env);
    expect(subs.success).toBe(true);
    const shaped = applyResponseTransform(subs, tool('seal_subscriptions_list_subscriptions').responseMapping as any);
    expect(JSON.stringify(shaped.value)).not.toContain('edit_url');
  }, 60000);
});
