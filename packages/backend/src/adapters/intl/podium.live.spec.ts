import axios from 'axios';
import * as adapter from './podium.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Podium API v4 (docs.podium.com; each reference page carries the OpenAPI
 * definition of its operation): base https://api.podium.com/v4, OAuth2
 * authorization code at api.podium.com/oauth/authorize and /oauth/token
 * (the token endpoint parses form-encoded client credentials: checked with a
 * fake client, which it answers with invalid_client), cursor paging through
 * metadata.nextCursor, money in cents. Paths, query names and bodies below
 * were checked against those definitions.
 *
 * The live block reads only, with an access token of a signed-in user:
 *   RUN_PODIUM_LIVE=1 PODIUM_ACCESS_TOKEN=... npx jest src/adapters/intl/podium
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
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string' && v.startsWith('$')) out.add(v.slice(1));
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  return out;
};

const P = 'podium_';
const V4 = 'https://api.podium.com/v4';
const TOKEN = ['tok', 'en', '9f8e7d6c5b4a'].join('');
const ENV = { PODIUM_CLIENT_ID: 'fae50485-7774-4341-9e2c-43a1dc18021d', PODIUM_CLIENT_SECRET: 'secretsecretsecretsecret' };
const tokens = { getAccessToken: jest.fn(async () => TOKEN) } as unknown as OAuth2TokenService;
const execute = (name: string, params: Record<string, unknown>, svc = tokens) =>
  new RestEngine(svc, {} as LoginTokenService).execute(
    {
      baseUrl: a.connector.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep({ ...a.connector.authConfig }, ENV),
      headers: a.connector.headers,
    },
    tool(name).endpointMapping as never,
    { ...applySchemaDefaults(tool(name).parameters, params), ...ENV },
  ) as Promise<any>;
const sent = () => mockedAxios.mock.calls[0][0];

const LOC = '00000000-0000-0000-0000-00000000000a';
const WRITES_OFF = [`${P}cancel_invoice`, `${P}delete_contact`, `${P}refund_invoice`];

describe('podium adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in with the documented OAuth endpoints and asks for the scopes the tools need', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toMatchObject({
      clientId: '{{PODIUM_CLIENT_ID}}',
      clientSecret: '{{PODIUM_CLIENT_SECRET}}',
      authorizationUrl: 'https://api.podium.com/oauth/authorize',
      tokenUrl: 'https://api.podium.com/oauth/token',
    });
    const scopes = a.connector.authConfig.scopes.split(' ');
    for (const s of ['read_locations', 'read_contacts', 'write_contacts', 'read_messages', 'write_messages', 'read_reviews', 'read_payments', 'write_payments', 'read_campaigns', 'write_campaigns', 'read_appointments', 'write_appointments', 'read_phones']) {
      expect(scopes).toContain(s);
    }
    expect(a.instructions).toContain(a.connector.authConfig.scopes);
    expect(needsBrowserAuthorization(a as never)).toBe(true);
    expect(a.requiredEnvVars).toEqual(['PODIUM_CLIENT_ID', 'PODIUM_CLIENT_SECRET']);
    expect(describeAdapterEnvVars(a as never).find((d) => d.name === 'PODIUM_CLIENT_SECRET')!.secret).toBe(true);
    expect(new RegExp(a.envVarMeta.PODIUM_CLIENT_ID.pattern!).test(ENV.PODIUM_CLIENT_ID)).toBe(true);
  });

  it('sends the Bearer token to /v4', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await execute(`${P}list_locations`, {});
    expect(sent().url).toBe(`${V4}/locations`);
    expect(sent().headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent().params).toEqual({ limit: 25 });
  });

  // [tool suffix, args, method, path under /v4]
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['list_locations', {}, 'GET', '/locations'],
    ['get_location', { location_uid: LOC }, 'GET', `/locations/${LOC}`],
    ['get_organization', { organization_uid: 'o1' }, 'GET', '/organizations/o1'],
    ['list_users', {}, 'GET', '/users'],
    ['get_user', { user_uid: 'u1' }, 'GET', '/users/u1'],
    ['list_contacts', {}, 'GET', '/contacts'],
    ['get_contact', { identifier: 'c1' }, 'GET', '/contacts/c1'],
    ['create_contact', { name: 'Ann', location_uids: [LOC] }, 'POST', '/contacts'],
    ['update_contact', { identifier: 'c1', name: 'Ann' }, 'PATCH', '/contacts/c1'],
    ['delete_contact', { identifier: 'c1' }, 'DELETE', '/contacts/c1'],
    ['list_conversations', {}, 'GET', '/conversations'],
    ['get_conversation', { conversation_uid: 'v1' }, 'GET', '/conversations/v1'],
    ['update_conversation', { conversation_uid: 'v1', closed: true }, 'PUT', '/conversations/v1'],
    ['list_messages', { conversation_uid: 'v1' }, 'GET', '/conversations/v1/messages'],
    ['get_message', { conversation_uid: 'v1', message_uid: 'm1' }, 'GET', '/conversations/v1/messages/m1'],
    ['send_message', { location_uid: LOC, channel_type: 'phone', channel_identifier: '+15555555555', body: 'Hi' }, 'POST', '/messages'],
    ['list_templates', {}, 'GET', '/templates'],
    ['list_reviews', {}, 'GET', '/reviews'],
    ['get_review', { review_uid: 'r1' }, 'GET', '/reviews/r1'],
    ['list_feedback', {}, 'GET', '/feedback'],
    ['list_invoices', {}, 'GET', '/invoices'],
    ['get_invoice', { invoice_uid: 'i1', location_uid: LOC }, 'GET', '/invoices/i1'],
    ['create_invoice', { location_uid: LOC, customer_name: 'Ann', channel_identifier: '+15555555555', invoice_number: 'A-1', line_items: [{ amount: 100 }] }, 'POST', '/invoices'],
    ['cancel_invoice', { invoice_uid: 'i1', location_uid: LOC, note: 'dup' }, 'POST', '/invoices/i1/cancel'],
    ['refund_invoice', { invoice_uid: 'i1', location_uid: LOC, payment_uid: 'p1', amount: 100, reason: 'duplicate' }, 'POST', '/invoices/i1/refund'],
    ['get_payment', { payment_uid: 'p1' }, 'GET', '/payments/p1'],
    ['get_refund', { refund_uid: 'f1', location_uid: LOC }, 'GET', '/refunds/f1'],
    ['list_products', {}, 'GET', '/products'],
    ['get_product', { product_uid: 'x1' }, 'GET', '/products/x1'],
    ['list_campaigns', {}, 'GET', '/campaigns'],
    ['get_campaign', { campaign_uid: 'k1' }, 'GET', '/campaigns/k1'],
    ['create_campaign_draft', { name: 'Fall', location_uids: [LOC], message: 'Hi' }, 'POST', '/campaigns'],
    ['list_appointments', {}, 'GET', '/appointments'],
    ['get_appointment', { appointment_uid: 'a1' }, 'GET', '/appointments/a1'],
    ['create_appointment', { location_uid: LOC, contact_name: 'Ann', contact_phone_number: '+15555555555', datetime: '2026-11-01T15:00:00Z' }, 'POST', '/appointments'],
    ['list_calls', {}, 'GET', '/calls'],
    ['get_call', { call_uid: 'c9' }, 'GET', '/calls/c9'],
    ['get_call_voicemail', { call_uid: 'c9' }, 'GET', '/calls/c9/voicemail'],
  ];

  it('covers every tool in the table', () => {
    expect(table.map((r) => P + r[0]).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s calls %s %s', async (suffix, args, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await execute(P + suffix, args);
    expect(sent().method).toBe(method);
    expect(sent().url).toBe(`${V4}${path}`);
  });

  it('sends the documented message, contact, invoice, refund, campaign and appointment bodies', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await execute(`${P}send_message`, { location_uid: LOC, channel_type: 'email', channel_identifier: 'ann@example.com', body: 'Your car is ready', subject: 'Pickup' });
    expect(sent().data).toEqual({ locationUid: LOC, channel: { type: 'email', identifier: 'ann@example.com' }, body: 'Your car is ready', subject: 'Pickup' });
    mockedAxios.mockClear();
    await execute(`${P}create_contact`, { name: 'Ann', location_uids: [LOC], phone_number: '+15555555555' });
    expect(sent().data).toEqual({ name: 'Ann', locations: [LOC], phoneNumber: '+15555555555' });
    mockedAxios.mockClear();
    await execute(`${P}create_invoice`, { location_uid: LOC, customer_name: 'Ann', channel_identifier: '+15555555555', invoice_number: 'A-1', line_items: [{ description: 'Oil change', amount: 4999 }] });
    expect(sent().data).toEqual({ locationUid: LOC, customerName: 'Ann', channelIdentifier: '+15555555555', invoiceNumber: 'A-1', lineItems: [{ description: 'Oil change', amount: 4999 }] });
    mockedAxios.mockClear();
    await execute(`${P}refund_invoice`, { invoice_uid: 'i1', location_uid: LOC, payment_uid: 'p1', amount: 500, reason: 'requested_by_customer' });
    expect(sent().data).toEqual({ locationUid: LOC, paymentUid: 'p1', amount: 500, reason: 'requested_by_customer' });
    mockedAxios.mockClear();
    await execute(`${P}create_campaign_draft`, { name: 'Fall', location_uids: [LOC], message: 'Hi' });
    expect(sent().data).toEqual({ name: 'Fall', locations: [LOC], message: 'Hi', status: 'DRAFT' });
    mockedAxios.mockClear();
    await execute(`${P}update_conversation`, { conversation_uid: 'v1', closed: false, assigned_user_uid: 'u1' });
    expect(sent().data).toEqual({ closed: false, assignedUserUid: 'u1' });
    mockedAxios.mockClear();
    await execute(`${P}create_appointment`, { location_uid: LOC, contact_name: 'Ann', contact_phone_number: '+15555555555', datetime: '2026-11-01T15:00:00Z', duration_min: 30 });
    expect(sent().data).toEqual({ locationUid: LOC, contactName: 'Ann', contactPhoneNumber: '+15555555555', datetime: '2026-11-01T15:00:00Z', durationMin: 30 });
  });

  it('writes date filters in the deepObject form and search fields in the bracket form', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await execute(`${P}list_reviews`, { created_from: '2026-10-01T00:00:00Z', created_to: '2026-10-31T00:00:00Z' });
    expect(sent().params).toEqual({ 'createdAt[gte]': '2026-10-01T00:00:00Z', 'createdAt[lte]': '2026-10-31T00:00:00Z', limit: 25 });
    mockedAxios.mockClear();
    await execute(`${P}list_locations`, { search: 'Austin', search_fields: ['name', 'address'] });
    expect(sent().params).toEqual({ search: 'Austin', 'searchFields[]': ['name', 'address'], limit: 25 });
    mockedAxios.mockClear();
    await execute(`${P}get_invoice`, { invoice_uid: 'i1', location_uid: LOC });
    expect(sent().params).toEqual({ locationUid: LOC });
  });

  it('encodes a phone or email contact identifier into one path segment', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await execute(`${P}get_contact`, { identifier: '+15555555555' });
    expect(sent().url).toBe(`${V4}/contacts/%2B15555555555`);
  });

  it('every declared parameter reaches the request, path parameters are required and encoded', () => {
    for (const t of a.tools) {
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) {
        expect(t.parameters?.required).toContain(p);
        expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
      }
    }
  });

  it('marks GETs read-only, everything else a write, and installs delete, refund and invoice cancel switched off', () => {
    for (const t of a.tools) expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(WRITES_OFF);
    expect(annotationsOf(tool(`${P}delete_contact`)).destructiveHint).toBe(true);
    for (const name of ['send_message', 'create_invoice', 'refund_invoice', 'delete_contact']) expect(tool(P + name).description).toMatch(/wait for a yes/);
  });

  it('probes with a read tool, names every tool in the instructions, and shares no name with another adapter', () => {
    expect(a.probe.tool).toBe(`${P}list_locations`);
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    const names = new Set(a.tools.map((t) => t.name));
    for (const m of [...a.instructions.matchAll(/\bpodium_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bpodium_[a-z_]+/g)])]) expect(names).toContain(m[0]);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(names.has(t.name)).toBe(false);
    }
    expect(JSON.stringify(adapter)).not.toMatch(/—/);
  });
});

const LIVE = process.env.RUN_PODIUM_LIVE === '1' && process.env.PODIUM_ACCESS_TOKEN ? describe : describe.skip;
LIVE('podium adapter: live (read-only)', () => {
  const live = { getAccessToken: jest.fn(async () => process.env.PODIUM_ACCESS_TOKEN) } as unknown as OAuth2TokenService;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => mockedAxios.__actual.request(cfg)));

  it('reads locations, contacts, conversations, reviews and invoices', async () => {
    for (const name of ['list_locations', 'list_contacts', 'list_conversations', 'list_reviews', 'list_invoices']) {
      const res = await execute(P + name, { limit: 1 }, live);
      expect(res.data).toHaveProperty('data');
    }
  }, 60000);
});
