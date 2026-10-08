import axios from 'axios';
import * as adapter from './google-calendar.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Google Calendar adapter:
 *
 *   1. Static: always runs. Pins the OAuth setup shared by the Google
 *      adapters, the two narrow scopes, percent-encoded calendar ids (they
 *      are email addresses), the requests the write tools build, and which
 *      tools install switched off.
 *
 *   2. Live: skipped unless GOOGLE_ACCESS_TOKEN is set (e.g. from the OAuth
 *      2.0 Playground with calendar.readonly, or calendar.events plus
 *      calendar.readonly for the write round-trip). Read-only by default:
 *
 *        GOOGLE_ACCESS_TOKEN=ya29... npx jest src/adapters/intl/google-calendar.live.spec.ts
 *
 *      With GOOGLE_LIVE_WRITE=1 as well, one "AnythingMCP test" event is
 *      created tomorrow on the primary calendar (nobody invited, no email),
 *      changed, read back and deleted again in `finally`; the same for one
 *      quick-add event.
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    // The outbound helper also calls axios.getUri, getAdapter and friends:
    // keep every real static, only the call itself is mocked.
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
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
  unlisted?: boolean;
  instructions: string;
  requiredEnvVars: string[];
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
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

const BASE = 'https://www.googleapis.com/calendar/v3';
const newEngine = () =>
  new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  );
const connectorConfig = () => ({
  baseUrl: a.connector.baseUrl,
  authType: a.connector.authType,
  authConfig: { ...a.connector.authConfig },
  headers: { ...a.connector.headers },
});
// Arguments as DynamicMcpTools hands them to the engine: schema defaults filled in.
const call = (name: string, params: Record<string, unknown>) =>
  newEngine().execute(connectorConfig(), tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params));
const sent = () => mockedAxios.mock.calls[0][0];

describe('google-calendar adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until verified against a real account', () => {
    expect(a.unlisted).toBe(true);
  });

  it('signs in with the shared Google OAuth client and the two narrow Calendar scopes', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{GOOGLE_CLIENT_ID}}',
      clientSecret: '{{GOOGLE_CLIENT_SECRET}}',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly',
    });
    expect(a.requiredEnvVars).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toContain('Google Calendar API');
    // The read-only alternative is documented.
    expect(a.instructions).toMatch(/read-only setup[^\n]*calendar\.readonly/);
  });

  it('probes with a cheap read that needs no arguments beyond the probe params', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    for (const r of probe.parameters.required ?? []) expect(a.probe.params ?? {}).toHaveProperty(r);
    expect(a.connector.healthcheckPath).toBe('/colors');
  });

  it('prefixes every tool with gcal_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^gcal_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('percent-encodes ids placed in the path', () => {
    for (const t of a.tools) {
      if (/\{\w+\}/.test(t.endpointMapping.path)) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('installs only the delete tool switched off, and says so', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['gcal_delete_event']);
    expect(a.instructions).toMatch(/Switched off at install\*\*: `gcal_delete_event`/);
    expect(annotationsOf(tool('gcal_delete_event')).destructiveHint).toBe(true);
  });

  it('marks reads read-only, the POST free/busy query included', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual([
      'gcal_get_calendar',
      'gcal_get_event',
      'gcal_list_calendars',
      'gcal_list_colors',
      'gcal_list_events',
      'gcal_query_free_busy',
    ]);
  });

  it('only points the model at tools that exist', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bgcal_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgcal_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(5);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it.each([
    ['gcal_list_calendars', {}, 'GET', '/users/me/calendarList'],
    ['gcal_get_calendar', { calendar_id: 'primary' }, 'GET', '/calendars/primary'],
    ['gcal_list_events', { calendar_id: 'team@group.calendar.google.com' }, 'GET', '/calendars/team%40group.calendar.google.com/events'],
    ['gcal_get_event', { calendar_id: 'primary', event_id: 'abc_20261009T070000Z' }, 'GET', '/calendars/primary/events/abc_20261009T070000Z'],
    ['gcal_quick_add', { calendar_id: 'primary', text: 'Lunch tomorrow 12:30' }, 'POST', '/calendars/primary/events/quickAdd'],
    ['gcal_delete_event', { calendar_id: 'primary', event_id: 'e1' }, 'DELETE', '/calendars/primary/events/e1'],
    ['gcal_query_free_busy', { time_min: 'x', time_max: 'y', items: [{ id: 'primary' }] }, 'POST', '/freeBusy'],
    ['gcal_list_colors', {}, 'GET', '/colors'],
  ])('%s sends %s to the right Calendar URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method,
        url: `${BASE}${path}`,
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
  });

  it('expands recurring events in start order by default and passes the search', async () => {
    mockedAxios.mockResolvedValue({ data: { items: [] } });
    await call('gcal_list_events', { calendar_id: 'primary', time_min: '2026-10-09T00:00:00+02:00', q: 'review', event_types: ['default', 'focusTime'] });
    expect(sent().params).toEqual({
      timeMin: '2026-10-09T00:00:00+02:00',
      q: 'review',
      singleEvents: true,
      orderBy: 'startTime',
      eventTypes: ['default', 'focusTime'],
    });
  });

  it('creates an event with guests and a Meet request, conferenceDataVersion always set', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const meet = { createRequest: { requestId: 'r-1', conferenceSolutionKey: { type: 'hangoutsMeet' } } };
    await call('gcal_create_event', {
      calendar_id: 'primary',
      summary: 'Review',
      start: { dateTime: '2026-10-09T09:00:00+02:00' },
      end: { dateTime: '2026-10-09T10:00:00+02:00' },
      attendees: [{ email: 'ana@example.com' }],
      conference_data: meet,
      send_updates: 'all',
    });
    expect(sent().params).toEqual({ conferenceDataVersion: 1, sendUpdates: 'all' });
    expect(sent().data).toEqual({
      summary: 'Review',
      start: { dateTime: '2026-10-09T09:00:00+02:00' },
      end: { dateTime: '2026-10-09T10:00:00+02:00' },
      attendees: [{ email: 'ana@example.com' }],
      conferenceData: meet,
    });
  });

  it('patches only the fields given', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('gcal_update_event', { calendar_id: 'primary', event_id: 'e1', location: 'Room 2' });
    expect(sent().method).toBe('PATCH');
    expect(sent().data).toEqual({ location: 'Room 2' });
    mockedAxios.mockClear();
    await call('gcal_respond_to_event', {
      calendar_id: 'primary',
      event_id: 'e1',
      attendees: [{ email: 'me@example.com', self: true, responseStatus: 'accepted' }],
    });
    expect(sent().data).toEqual({ attendees: [{ email: 'me@example.com', self: true, responseStatus: 'accepted' }] });
  });

  it('builds the free/busy body Google documents', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('gcal_query_free_busy', {
      time_min: '2026-10-09T08:00:00+02:00',
      time_max: '2026-10-09T18:00:00+02:00',
      items: [{ id: 'primary' }, { id: 'ana@example.com' }],
    });
    expect(sent().data).toEqual({
      timeMin: '2026-10-09T08:00:00+02:00',
      timeMax: '2026-10-09T18:00:00+02:00',
      items: [{ id: 'primary' }, { id: 'ana@example.com' }],
    });
  });
});

const TOKEN = process.env.GOOGLE_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('google-calendar adapter: live Calendar API', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
      { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: TOKEN as string }, headers: a.connector.headers },
      tool(name).endpointMapping,
      applySchemaDefaults(tool(name).parameters, params),
    );

  it('runs the probe and reads the primary calendar', async () => {
    const list = await run(a.probe.tool, a.probe.params);
    expect(Array.isArray(list.items)).toBe(true);
    const primary = await run('gcal_get_calendar', { calendar_id: 'primary' });
    expect(typeof primary.timeZone).toBe('string');
  }, 30_000);

  it('lists the next seven days of events and the colors', async () => {
    const now = new Date();
    const events = await run('gcal_list_events', {
      calendar_id: 'primary',
      time_min: now.toISOString(),
      time_max: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
      max_results: 5,
    });
    expect(Array.isArray(events.items)).toBe(true);
    if (events.items.length) {
      const one = await run('gcal_get_event', { calendar_id: 'primary', event_id: events.items[0].id });
      expect(one.id).toBe(events.items[0].id);
    }
    const colors = await run('gcal_list_colors');
    expect(colors.event['1']).toBeDefined();
  }, 30_000);

  it('queries free/busy for the primary calendar', async () => {
    const now = new Date();
    const fb = await run('gcal_query_free_busy', {
      time_min: now.toISOString(),
      time_max: new Date(now.getTime() + 86_400_000).toISOString(),
      items: [{ id: 'primary' }],
    });
    expect(fb.calendars.primary).toBeDefined();
  }, 30_000);

  (process.env.GOOGLE_LIVE_WRITE === '1' ? it : it.skip)(
    'creates, changes, reads and deletes a test event (nobody invited)',
    async () => {
      const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      const created = await run('gcal_create_event', {
        calendar_id: 'primary',
        summary: 'AnythingMCP test event',
        description: 'Created by the AnythingMCP live spec; deleted right away.',
        start: { dateTime: `${day}T07:00:00Z` },
        end: { dateTime: `${day}T07:30:00Z` },
        transparency: 'transparent',
      });
      let quick: { id?: string } = {};
      try {
        expect(created.summary).toBe('AnythingMCP test event');
        const updated = await run('gcal_update_event', { calendar_id: 'primary', event_id: created.id, location: 'AnythingMCP test room' });
        expect(updated.location).toBe('AnythingMCP test room');
        expect(updated.summary).toBe('AnythingMCP test event');
        quick = await run('gcal_quick_add', { calendar_id: 'primary', text: 'AnythingMCP test quick add tomorrow 6am-6:15am' });
        expect(quick.id).toBeTruthy();
      } finally {
        await run('gcal_delete_event', { calendar_id: 'primary', event_id: created.id });
        if (quick.id) await run('gcal_delete_event', { calendar_id: 'primary', event_id: quick.id });
      }
    },
    60_000,
  );
});
