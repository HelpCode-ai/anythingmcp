import axios from 'axios';
import * as adapter from './calcom.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Cal.com adapter:
 *
 *   1. Static: always runs. Pins the Bearer API key, the region host with
 *      /v2 paths, the cal-api-version header each endpoint family needs
 *      (checked against Cal.com's published v2 OpenAPI), every tool's
 *      method, path, query names and body shape, and which tools write.
 *
 *   2. Live: skipped unless CALCOM_API_KEY is set. Reads only: the profile,
 *      event types, bookings, slots, schedules and calendars.
 *
 *        CALCOM_API_HOST=https://api.cal.com CALCOM_API_KEY=cal_live_... \
 *          npx jest src/adapters/intl/calcom.live.spec.ts
 *
 *      Nothing here books, reschedules or cancels: those email real
 *      attendees.
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
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  probe: { tool: string };
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

// Built at run time so no literal here looks like a real key.
const KEY = ['cal', 'live', '0a1b2c3d4e5f60718293a4b5c6d7e8f9'].join('_');
const HOST = 'https://api.cal.com';
const ENV = { CALCOM_API_HOST: HOST, CALCOM_API_KEY: KEY };
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep({ ...a.connector.authConfig }, env),
      headers: config.headers,
    },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, params);
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES = ['calcom_cancel_booking', 'calcom_create_booking', 'calcom_reschedule_booking'];

describe('calcom adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the API key as a Bearer token, never in the URL', async () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{CALCOM_API_KEY}}' });
    expect(needsBrowserAuthorization(a as never)).toBe(false);
    mockedAxios.mockResolvedValue({ data: {} });
    await call('calcom_get_me', {});
    expect(sent().headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(sent().url).toBe('https://api.cal.com/v2/me');
    expect(JSON.stringify(sent().params ?? {})).not.toContain(KEY);
  });

  it('takes the region host (api.cal.com or api.cal.eu) and nothing else', async () => {
    expect(a.requiredEnvVars).toEqual(['CALCOM_API_HOST', 'CALCOM_API_KEY']);
    const host = new RegExp(a.envVarMeta.CALCOM_API_HOST.pattern!);
    for (const ok of ['https://api.cal.com', 'https://api.cal.eu']) expect(host.test(ok)).toBe(true);
    for (const bad of ['https://api.cal.com/', 'https://api.cal.com/v2', 'http://api.cal.com', 'https://app.cal.com', 'https://api.cal.com.evil.io']) {
      expect(host.test(bad)).toBe(false);
    }
    mockedAxios.mockResolvedValue({ data: {} });
    await execute('calcom_list_schedules', { ...ENV, CALCOM_API_HOST: 'https://api.cal.eu' }, {});
    expect(sent().url).toBe('https://api.cal.eu/v2/schedules');
  });

  it('checks the key format and keeps the key secret', () => {
    const key = new RegExp(a.envVarMeta.CALCOM_API_KEY.pattern!);
    expect(key.test(KEY)).toBe(true);
    expect(key.test(KEY.replace('live', 'test'))).toBe(true);
    expect(key.test(`Bearer ${KEY}`)).toBe(false);
    expect(key.test('0a1b2c3d4e5f60718293a4b5c6d7e8f9')).toBe(false);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'CALCOM_API_KEY')!.secret).toBe(true);
    expect(described.find((d) => d.name === 'CALCOM_API_HOST')!.kind).toBe('address');
  });

  it('sends the cal-api-version each endpoint family is documented with', async () => {
    const version = (path: string) =>
      path.startsWith('/v2/bookings') ? '2024-08-13'
        : path.startsWith('/v2/event-types') ? '2024-06-14'
          : path.startsWith('/v2/slots') ? '2024-09-04'
            : path.startsWith('/v2/schedules') ? '2024-06-11'
              : undefined;
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.headers?.['cal-api-version']}`).toBe(`${t.name}:${version(t.endpointMapping.path)}`);
    }
    mockedAxios.mockResolvedValue({ data: {} });
    await call('calcom_list_bookings', {});
    expect(sent().headers['cal-api-version']).toBe('2024-08-13');
  });

  // [tool, args, method, url]
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['calcom_get_me', {}, 'GET', '/v2/me'],
    ['calcom_list_event_types', {}, 'GET', '/v2/event-types'],
    ['calcom_get_event_type', { eventTypeId: '4403769' }, 'GET', '/v2/event-types/4403769'],
    ['calcom_list_bookings', {}, 'GET', '/v2/bookings'],
    ['calcom_get_booking', { bookingUid: 'abc123' }, 'GET', '/v2/bookings/abc123'],
    ['calcom_get_booking_recordings', { bookingUid: 'abc123' }, 'GET', '/v2/bookings/abc123/recordings'],
    ['calcom_get_booking_transcripts', { bookingUid: 'abc123' }, 'GET', '/v2/bookings/abc123/transcripts'],
    ['calcom_get_available_slots', { start: '2026-10-27', end: '2026-10-28', eventTypeId: 1 }, 'GET', '/v2/slots'],
    ['calcom_list_schedules', {}, 'GET', '/v2/schedules'],
    ['calcom_get_default_schedule', {}, 'GET', '/v2/schedules/default'],
    ['calcom_get_schedule', { scheduleId: 7 }, 'GET', '/v2/schedules/7'],
    ['calcom_list_calendars', {}, 'GET', '/v2/calendars'],
    ['calcom_create_booking', { start: '2026-10-27T09:00:00Z', eventTypeId: 1, attendeeName: 'A', attendeeEmail: 'a@example.com', attendeeTimeZone: 'Europe/Berlin' }, 'POST', '/v2/bookings'],
    ['calcom_reschedule_booking', { bookingUid: 'abc123', start: '2026-10-28T09:00:00Z' }, 'POST', '/v2/bookings/abc123/reschedule'],
    ['calcom_cancel_booking', { bookingUid: 'abc123' }, 'POST', '/v2/bookings/abc123/cancel'],
  ];

  it('covers every tool in the table', () => {
    expect(table.map((r) => r[0]).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s calls %s %s', async (name, args, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, args);
    expect(sent().method).toBe(method);
    expect(sent().url).toBe(`${HOST}${path}`);
  });

  it('maps booking filters to the documented query names (teamsIds, not teamIds)', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('calcom_list_bookings', { status: 'upcoming,unconfirmed', teamIds: '5', afterStart: '2026-10-01', sortStart: 'asc' });
    expect(sent().params).toEqual({ status: 'upcoming,unconfirmed', teamsIds: '5', afterStart: '2026-10-01', sortStart: 'asc', take: 25 });
  });

  it('asks for slots by date range, event type and time zone', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('calcom_get_available_slots', { start: '2026-10-27', end: '2026-10-28', username: 'peer', eventTypeSlug: '15', timeZone: 'Europe/Berlin', format: 'range' });
    expect(sent().params).toEqual({ start: '2026-10-27', end: '2026-10-28', username: 'peer', eventTypeSlug: '15', timeZone: 'Europe/Berlin', format: 'range' });
  });

  it('nests the attendee in the booking body as the 2024-08-13 input expects', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('calcom_create_booking', {
      start: '2026-10-27T09:00:00Z', eventTypeId: 1, attendeeName: 'Ada', attendeeEmail: 'ada@example.com',
      attendeeTimeZone: 'Europe/Berlin', guests: ['g@example.com'],
    });
    expect(sent().data).toEqual({
      start: '2026-10-27T09:00:00Z', eventTypeId: 1,
      attendee: { name: 'Ada', email: 'ada@example.com', timeZone: 'Europe/Berlin' },
      guests: ['g@example.com'],
    });
  });

  it('marks reads read-only and installs every write switched off', () => {
    for (const t of a.tools) expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    expect(a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name).sort()).toEqual(WRITES);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(WRITES);
    for (const name of WRITES) expect(tool(name).description).toMatch(/wait for a yes/);
  });

  it('encodes path ids, so an id cannot reach another route', async () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.path.includes('{bookingUid}'))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
    mockedAxios.mockResolvedValue({ data: {} });
    await call('calcom_get_booking', { bookingUid: '../me' });
    expect(sent().url).toBe(`${HOST}/v2/bookings/..%2Fme`);
  });

  it('probes with the profile, prefixes tools with calcom_ and shares no name with another adapter', () => {
    expect(a.probe).toEqual({ tool: 'calcom_get_me' });
    const mine = new Set(a.tools.map((t) => t.name));
    for (const name of mine) expect(name).toMatch(/^calcom_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bcalcom_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bcalcom_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(5);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const LIVE_KEY = process.env.CALCOM_API_KEY;
const liveDescribe = LIVE_KEY ? describe : describe.skip;

liveDescribe('calcom adapter: live (read-only)', () => {
  const env = { CALCOM_API_HOST: process.env.CALCOM_API_HOST || HOST, CALCOM_API_KEY: LIVE_KEY ?? '' };
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => mockedAxios.__actual.request(cfg)));
  const live = (name: string, params: Record<string, unknown> = {}) => execute(name, env, params);

  it('reads the profile, event types, bookings, schedules and calendars', async () => {
    const me = await live('calcom_get_me');
    expect(me.data.status).toBe('success');
    const types = await live('calcom_list_event_types');
    expect(Array.isArray(types.data.data)).toBe(true);
    const bookings = await live('calcom_list_bookings', { take: 5 });
    expect(bookings.data.status).toBe('success');
    expect((await live('calcom_list_schedules')).data.status).toBe('success');
    expect((await live('calcom_list_calendars')).data.status).toBe('success');
    if (types.data.data.length) {
      const id = types.data.data[0].id;
      const today = new Date().toISOString().slice(0, 10);
      const slots = await live('calcom_get_available_slots', { start: today, end: today, eventTypeId: id });
      expect(slots.data.status).toBe('success');
    }
  }, 60000);
});
