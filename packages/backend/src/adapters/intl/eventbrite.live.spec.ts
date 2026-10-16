import axios from 'axios';
import * as adapter from './eventbrite.json';
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
 * Two layers of verification for the Eventbrite adapter:
 *
 *   1. Static: always runs. Pins Bearer auth with the private token, the
 *      /users/me/ healthcheck, and every tool's method, URL, query and body
 *      through the real RestEngine, checked against Eventbrite's API
 *      Blueprint (jsapi.apiary.io/apis/eventbriteapiv3public.apib, the source
 *      of eventbrite.com/platform/api, read 14 Oct 2026) and the bodies of
 *      maintained clients that run against the live API. Also which tools only
 *      read, that every write asks for confirmation, that cancel and delete
 *      ship switched off and that barcodes never leave the connector.
 *
 *   2. Live: skipped unless RUN_EVENTBRITE_LIVE=1. Without a token it checks
 *      that Eventbrite refuses a wrong token with 401 on the real routes. With
 *      EVENTBRITE_PRIVATE_TOKEN it reads the user, organizations, events,
 *      ticket classes, attendees, orders, venues and the description, shaped
 *      by each tool's response mapping as production does. Nothing is written
 *      unless RUN_EVENTBRITE_LIVE_WRITES=1 too: then one draft event is
 *      created (never published) and its summary updated.
 *
 *        RUN_EVENTBRITE_LIVE=1 EVENTBRITE_PRIVATE_TOKEN=... \
 *          npx jest src/adapters/intl/eventbrite.live.spec.ts
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
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath?: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const HOST = 'https://www.eventbriteapi.com/v3';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = 'ABCDEFGHIJ' + '0'.repeat(10);
const ENV: Record<string, string> = { EVENTBRITE_PRIVATE_TOKEN: FAKE_TOKEN };

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
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const shaped = async (name: string, params: Record<string, unknown>, env = ENV) => shape(name, await call(name, params, env));
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = [
  'eventbrite_cancel_event',
  'eventbrite_create_event',
  'eventbrite_create_ticket_class',
  'eventbrite_create_venue',
  'eventbrite_delete_event',
  'eventbrite_publish_event',
  'eventbrite_set_event_description',
  'eventbrite_unpublish_event',
  'eventbrite_update_event',
  'eventbrite_update_ticket_class',
];

describe('eventbrite adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor SDK and API spec on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('sends the private token as a Bearer token and checks it on /users/me/', () => {
    expect(a.category).toBe('scheduling');
    expect(a.icon).toBe('eventbrite');
    expect(a.connector.baseUrl).toBe(HOST);
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{EVENTBRITE_PRIVATE_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/users/me/');
    expect(a.requiredEnvVars).toEqual(['EVENTBRITE_PRIVATE_TOKEN']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.EVENTBRITE_PRIVATE_TOKEN).toMatchObject({ kind: 'credential', secret: true, required: true });
  });

  it('accepts a bare token and refuses one pasted with a prefix', () => {
    const token = new RegExp(a.envVarMeta.EVENTBRITE_PRIVATE_TOKEN.pattern!);
    expect(token.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_TOKEN}`, 'short', ` ${FAKE_TOKEN}`]) expect(token.test(bad)).toBe(false);
  });

  it('explains wrong tokens, missing permissions and the hourly limit', () => {
    for (const status of ['401', '403', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['401']).toMatch(/Private token/);
  });

  it('prefixes every tool with eventbrite_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^eventbrite_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('confirms every write and ships cancel and delete switched off', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of WRITES) expect(`${name}:${/confirm/i.test(tool(name).description)}`).toBe(`${name}:true`);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(['eventbrite_cancel_event', 'eventbrite_delete_event']);
    for (const name of ['eventbrite_cancel_event', 'eventbrite_delete_event', 'eventbrite_unpublish_event', 'eventbrite_set_event_description']) {
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
  });

  it('only points the model at tools that exist, documents setup, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\beventbrite_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\beventbrite_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('Private token');
    expect(a.instructions).toMatch(/public event search/i);
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('gives every tool a valid response mapping that does real work', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:true`);
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.exclude ?? tr.include ?? tr.expression).toBeDefined();
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['eventbrite_get_current_user', {}, 'GET', '/users/me/'],
    ['eventbrite_list_my_organizations', {}, 'GET', '/users/me/organizations/'],
    ['eventbrite_list_events', { organization_id: 'o1' }, 'GET', '/organizations/o1/events/'],
    ['eventbrite_get_event', { event_id: 'e1' }, 'GET', '/events/e1/'],
    [
      'eventbrite_create_event',
      { organization_id: 'o1', name: 'Party', start_utc: '2026-11-20T18:00:00Z', end_utc: '2026-11-20T22:00:00Z', timezone: 'Europe/Berlin', currency: 'EUR' },
      'POST',
      '/organizations/o1/events/',
    ],
    ['eventbrite_update_event', { event_id: 'e1', summary: 'New' }, 'POST', '/events/e1/'],
    ['eventbrite_publish_event', { event_id: 'e1' }, 'POST', '/events/e1/publish/'],
    ['eventbrite_unpublish_event', { event_id: 'e1' }, 'POST', '/events/e1/unpublish/'],
    ['eventbrite_cancel_event', { event_id: 'e1' }, 'POST', '/events/e1/cancel/'],
    ['eventbrite_delete_event', { event_id: 'e1' }, 'DELETE', '/events/e1/'],
    ['eventbrite_get_event_description', { event_id: 'e1' }, 'GET', '/events/e1/structured_content/edit/'],
    ['eventbrite_set_event_description', { event_id: 'e1', version: '3', html: '<p>Hi</p>' }, 'POST', '/events/e1/structured_content/3/'],
    ['eventbrite_list_ticket_classes', { event_id: 'e1' }, 'GET', '/events/e1/ticket_classes/'],
    ['eventbrite_create_ticket_class', { event_id: 'e1', name: 'GA', free: true, capacity: 100 }, 'POST', '/events/e1/ticket_classes/'],
    ['eventbrite_update_ticket_class', { event_id: 'e1', ticket_class_id: 't1', hidden: true }, 'POST', '/events/e1/ticket_classes/t1/'],
    ['eventbrite_list_attendees', { event_id: 'e1' }, 'GET', '/events/e1/attendees/'],
    ['eventbrite_get_attendee', { event_id: 'e1', attendee_id: 'a1' }, 'GET', '/events/e1/attendees/a1/'],
    ['eventbrite_list_event_orders', { event_id: 'e1' }, 'GET', '/events/e1/orders/'],
    ['eventbrite_list_organization_orders', { organization_id: 'o1' }, 'GET', '/organizations/o1/orders/'],
    ['eventbrite_get_order', { order_id: 'r1' }, 'GET', '/orders/r1/'],
    ['eventbrite_list_venues', { organization_id: 'o1' }, 'GET', '/organizations/o1/venues/'],
    ['eventbrite_create_venue', { organization_id: 'o1', name: 'Hall' }, 'POST', '/organizations/o1/venues/'],
    ['eventbrite_list_discounts', { organization_id: 'o1', event_id: 'e1' }, 'GET', '/organizations/o1/discounts/'],
    ['eventbrite_get_sales_report', { event_ids: ['e1'] }, 'GET', '/reports/sales/'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the Bearer token', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${path}`);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(JSON.stringify(req)).not.toContain('{{');
  });

  it('sends the documented list filters with sensible defaults', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('eventbrite_list_events', { organization_id: 'o1', status: 'live', name_filter: 'Summer' });
    expect(sent().params).toEqual({ status: 'live', time_filter: 'current_future', order_by: 'start_asc', name_filter: 'Summer', page_size: 20, expand: 'venue' });
    mockedAxios.mockClear();
    await call('eventbrite_get_event', { event_id: 'e1' });
    expect(sent().params).toEqual({ expand: 'venue,ticket_availability' });
    mockedAxios.mockClear();
    await call('eventbrite_list_attendees', { event_id: 'e1', status: 'attending', continuation: 'abc' });
    expect(sent().params).toEqual({ status: 'attending', continuation: 'abc' });
    mockedAxios.mockClear();
    await call('eventbrite_list_discounts', { organization_id: 'o1', event_id: 'e1', type: 'coded' });
    expect(sent().params).toEqual({ scope: 'event', event_id: 'e1', type: 'coded' });
    mockedAxios.mockClear();
    await call('eventbrite_get_sales_report', { event_ids: ['e1', 'e2'], date_facet: 'none' });
    expect(sent().params).toEqual({ event_ids: ['e1', 'e2'], date_facet: 'none' });
  });

  it('wraps event, ticket class and venue bodies the way the API expects', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('eventbrite_create_event', {
      organization_id: 'o1',
      name: 'Summer Party',
      start_utc: '2026-11-20T18:00:00Z',
      end_utc: '2026-11-20T22:00:00Z',
      timezone: 'Europe/Berlin',
      currency: 'EUR',
      online_event: true,
      listed: false,
    });
    expect(sent().data).toEqual({
      event: {
        name: { html: 'Summer Party' },
        start: { timezone: 'Europe/Berlin', utc: '2026-11-20T18:00:00Z' },
        end: { timezone: 'Europe/Berlin', utc: '2026-11-20T22:00:00Z' },
        currency: 'EUR',
        online_event: true,
        listed: false,
      },
    });
    mockedAxios.mockClear();
    // Only what is passed: no empty name or start objects that Eventbrite would reject.
    await call('eventbrite_update_event', { event_id: 'e1', summary: 'Now with food' });
    expect(sent().data).toEqual({ event: { summary: 'Now with food' } });
    mockedAxios.mockClear();
    await call('eventbrite_update_event', { event_id: 'e1', name: { html: 'Renamed' }, start: { timezone: 'Europe/Berlin', utc: '2026-11-21T18:00:00Z' } });
    expect(sent().data).toEqual({ event: { name: { html: 'Renamed' }, start: { timezone: 'Europe/Berlin', utc: '2026-11-21T18:00:00Z' } } });
    mockedAxios.mockClear();
    await call('eventbrite_create_ticket_class', { event_id: 'e1', name: 'Early bird', cost: 'EUR,2500', capacity: 50, sales_channels: ['online'] });
    expect(sent().data).toEqual({ ticket_class: { name: 'Early bird', cost: 'EUR,2500', capacity: 50, sales_channels: ['online'] } });
    mockedAxios.mockClear();
    await call('eventbrite_update_ticket_class', { event_id: 'e1', ticket_class_id: 't1', hidden: true });
    expect(sent().data).toEqual({ ticket_class: { hidden: true } });
    mockedAxios.mockClear();
    const address = { address_1: 'Hauptstr. 1', city: 'Freiburg', postal_code: '79098', country: 'DE' };
    await call('eventbrite_create_venue', { organization_id: 'o1', name: 'Hall', address, capacity: 200 });
    expect(sent().data).toEqual({ venue: { name: 'Hall', address, capacity: 200 } });
    mockedAxios.mockClear();
    await call('eventbrite_publish_event', { event_id: 'e1' });
    expect(sent().data ?? {}).toEqual({});
  });

  it('sends the description as one published text module', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('eventbrite_set_event_description', { event_id: 'e1', version: '4', html: '<p>Doors at <strong>7</strong></p>' });
    expect(sent().data).toEqual({
      modules: [{ type: 'text', data: { body: { text: '<p>Doors at <strong>7</strong></p>', alignment: 'left' } } }],
      publish: true,
      purpose: 'listing',
    });
  });

  it('never returns attendee barcode values and keeps lists compact', () => {
    const out = shape('eventbrite_list_attendees', {
      pagination: { has_more_items: false, page_count: 1 },
      attendees: [
        {
          id: 'a1',
          status: 'Checked In',
          checked_in: true,
          ticket_class_name: 'GA',
          order_id: 'r1',
          profile: { name: 'Ada Lovelace', email: 'ada@example.com', addresses: { home: { city: 'London' } } },
          costs: { gross: { display: '€25.00' } },
          barcodes: [{ barcode: '1234567890123', status: 'used', checkin_type: 1, changed: '2026-10-01T10:00:00Z' }],
          answers: [{ answer: 'x' }],
        },
      ],
    });
    expect(out.attendees).toEqual([
      {
        id: 'a1',
        status: 'Checked In',
        checked_in: true,
        ticket_class_name: 'GA',
        order_id: 'r1',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        gross: '€25.00',
        barcodes: [{ status: 'used', checkin_type: 1, changed: '2026-10-01T10:00:00Z' }],
      },
    ]);
    expect(JSON.stringify(out)).not.toContain('1234567890123');
    const one = shape('eventbrite_get_attendee', { id: 'a1', barcodes: [{ barcode: '1234567890123', status: 'unused' }], profile: { name: 'Ada' } });
    expect(JSON.stringify(one)).not.toContain('1234567890123');
    const ev = shape('eventbrite_get_event', {
      id: 'e1',
      name: { text: 'Party', html: 'Party' },
      description: { text: 'long', html: '<p>long</p>' },
      start: { timezone: 'Europe/Berlin', local: '2026-11-20T19:00:00', utc: '2026-11-20T18:00:00Z' },
      status: 'live',
      venue: { id: 'v1', name: 'Hall', address: { localized_address_display: 'Hauptstr. 1, Freiburg' } },
      logo: { url: 'https://img' },
    });
    expect(ev).toEqual({
      id: 'e1',
      name: 'Party',
      start: { timezone: 'Europe/Berlin', local: '2026-11-20T19:00:00', utc: '2026-11-20T18:00:00Z' },
      status: 'live',
      venue: { id: 'v1', name: 'Hall', address: 'Hauptstr. 1, Freiburg' },
    });
  });
});

const live = process.env.RUN_EVENTBRITE_LIVE === '1' ? describe : describe.skip;
live('eventbrite adapter: live', () => {
  const real = !!process.env.EVENTBRITE_PRIVATE_TOKEN;
  const env = () => ({ EVENTBRITE_PRIVATE_TOKEN: process.env.EVENTBRITE_PRIVATE_TOKEN! });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['eventbrite_get_current_user', {}],
    ['eventbrite_list_my_organizations', {}],
    ['eventbrite_list_events', { organization_id: '1' }],
    ['eventbrite_get_sales_report', { event_ids: ['1'] }],
  ])('%s reaches Eventbrite and is refused with a wrong token (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (real ? it : it.skip)('reads the user, organizations, events and what belongs to the first event', async () => {
    const me = await shaped('eventbrite_get_current_user', {}, env());
    expect(me.id).toBeTruthy();
    const orgs = await shaped('eventbrite_list_my_organizations', {}, env());
    expect(Array.isArray(orgs.organizations)).toBe(true);
    const orgId = orgs.organizations[0]?.id;
    if (!orgId) return;
    const venues = await shaped('eventbrite_list_venues', { organization_id: orgId }, env());
    expect(Array.isArray(venues.venues)).toBe(true);
    const orders = await shaped('eventbrite_list_organization_orders', { organization_id: orgId }, env());
    expect(Array.isArray(orders.orders)).toBe(true);
    const events = await shaped('eventbrite_list_events', { organization_id: orgId, time_filter: 'all', page_size: 5 }, env());
    expect(Array.isArray(events.events)).toBe(true);
    const eventId = events.events[0]?.id;
    if (!eventId) return;
    const ev = await shaped('eventbrite_get_event', { event_id: eventId }, env());
    expect(ev.id).toBe(eventId);
    expect(Array.isArray((await shaped('eventbrite_list_ticket_classes', { event_id: eventId }, env())).ticket_classes)).toBe(true);
    expect(Array.isArray((await shaped('eventbrite_list_attendees', { event_id: eventId }, env())).attendees)).toBe(true);
    expect(Array.isArray((await shaped('eventbrite_list_event_orders', { event_id: eventId }, env())).orders)).toBe(true);
    const desc = await shaped('eventbrite_get_event_description', { event_id: eventId }, env());
    expect(desc).toBeDefined();
  }, 120000);

  const writes = real && process.env.RUN_EVENTBRITE_LIVE_WRITES === '1';
  (writes ? it : it.skip)('creates one unpublished draft event and updates its summary', async () => {
    const orgs = await shaped('eventbrite_list_my_organizations', {}, env());
    const start = new Date(Date.now() + 60 * 24 * 3600 * 1000);
    start.setUTCMilliseconds(0);
    const end = new Date(start.getTime() + 2 * 3600 * 1000);
    const iso = (d: Date) => d.toISOString().replace('.000Z', 'Z');
    const created = await shaped(
      'eventbrite_create_event',
      {
        organization_id: orgs.organizations[0].id,
        name: `AnythingMCP live check ${Date.now()}`,
        start_utc: iso(start),
        end_utc: iso(end),
        timezone: 'Europe/Berlin',
        currency: 'EUR',
        online_event: true,
        listed: false,
      },
      env(),
    );
    expect(created.status).toBe('draft');
    const updated = await shaped('eventbrite_update_event', { event_id: created.id, summary: 'Draft created by a test' }, env());
    expect(updated.summary).toBe('Draft created by a test');
  }, 60000);
});
