import * as adapter from './microsoft-outlook.json';
import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';

/**
 * Two layers of verification for the Outlook (Microsoft Graph) adapter:
 *
 *   1. Static — always runs. Pins what is easy to get wrong against Graph:
 *      the tenant in both OAuth endpoints, offline_access in the scopes (no
 *      refresh token without it), the `Prefer` headers that make Graph return
 *      a plain-text body and local times, the fixed `$select` that keeps
 *      message lists small, and the Graph object shapes that write tools send
 *      as they are (recipients, body, start/end).
 *
 *   2. Live — skipped unless RUN_OUTLOOK_LIVE is set. Read-only. Needs a
 *      Graph access token with Mail.Read and Calendars.Read (Graph Explorer's
 *      token works and lasts about an hour):
 *
 *        RUN_OUTLOOK_LIVE=1 OUTLOOK_ACCESS_TOKEN=eyJ... \
 *          npx jest src/adapters/intl/microsoft-outlook.live.spec.ts
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
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    headers?: Record<string, string>;
    queryParams?: Record<string, string>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};

const a = adapter as unknown as {
  instructions: string;
  unlisted?: boolean;
  prerequisites?: string;
  requiredEnvVars: string[];
  probe: { tool: string };
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
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({
    name: t.name,
    connectorType: 'REST',
    endpointMapping: t.endpointMapping,
    annotations: t.annotations,
  });

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

const sent = () => mockedAxios.mock.calls[0][0];

describe('microsoft-outlook adapter — static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed, and says up front that it needs an Entra app registration', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.prerequisites).toMatch(/Entra/);
    expect(a.prerequisites).toMatch(/redirect URI/);
  });

  it('authorises in the browser against the configured tenant and asks for a refresh token', () => {
    const auth = a.connector.authConfig;
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.requiredEnvVars).toEqual([
      'MICROSOFT_CLIENT_ID',
      'MICROSOFT_CLIENT_SECRET',
      'MICROSOFT_TENANT_ID',
    ]);
    expect(auth.authorizationUrl).toBe(
      'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/authorize',
    );
    expect(auth.tokenUrl).toBe(
      'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/token',
    );
    expect(auth.scopes.split(' ')).toEqual(
      expect.arrayContaining(['offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite']),
    );
    // The callback stores the refresh token; there is no variable for it.
    expect(auth.refreshToken).toBeUndefined();
  });

  it('probes with /me, which every signed-in user can read', () => {
    expect(a.probe.tool).toBe('outlook_get_me');
    expect(a.connector.healthcheckPath).toBe('/me');
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
  });

  it.each([
    ['outlook_get_me', {}, 'GET', '/me'],
    ['outlook_list_mail_folders', {}, 'GET', '/me/mailFolders'],
    ['outlook_list_child_folders', { folder_id: 'inbox' }, 'GET', '/me/mailFolders/inbox/childFolders'],
    ['outlook_list_messages', { folder_id: 'inbox' }, 'GET', '/me/mailFolders/inbox/messages'],
    ['outlook_search_messages', { search: '"invoice"' }, 'GET', '/me/messages'],
    ['outlook_get_message', { message_id: 'AAMkAD=' }, 'GET', '/me/messages/AAMkAD%3D'],
    ['outlook_send_draft', { message_id: 'AAMkAD=' }, 'POST', '/me/messages/AAMkAD%3D/send'],
    ['outlook_reply_to_message', { message_id: 'm1', comment: 'ok' }, 'POST', '/me/messages/m1/reply'],
    ['outlook_reply_all_to_message', { message_id: 'm1', comment: 'ok' }, 'POST', '/me/messages/m1/replyAll'],
    ['outlook_move_message', { message_id: 'm1', destination_id: 'archive' }, 'POST', '/me/messages/m1/move'],
    ['outlook_list_calendars', {}, 'GET', '/me/calendars'],
    ['outlook_get_event', { event_id: 'e1' }, 'GET', '/me/events/e1'],
    ['outlook_update_event', { event_id: 'e1', subject: 'x' }, 'PATCH', '/me/events/e1'],
  ])('%s sends %s to the right Graph URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await newEngine().execute(connectorConfig(), tool(name).endpointMapping, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method,
        url: `https://graph.microsoft.com/v1.0${path}`,
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
  });

  it('lists messages with a fixed $select and Graph query options', async () => {
    mockedAxios.mockResolvedValue({ data: { value: [] } });
    await newEngine().execute(connectorConfig(), tool('outlook_list_messages').endpointMapping, {
      folder_id: 'inbox',
      filter: 'isRead eq false',
      top: 25,
    });
    const params = sent().params;
    expect(params.$filter).toBe('isRead eq false');
    expect(params.$top).toBe(25);
    expect(params.$select).toContain('bodyPreview');
    expect(params.$select).not.toMatch(/(^|,)body(,|$)/);
    expect(params).not.toHaveProperty('$search');
  });

  it('asks Graph for a plain-text body when reading one message', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await newEngine().execute(connectorConfig(), tool('outlook_get_message').endpointMapping, { message_id: 'm1' });
    expect(sent().headers.Prefer).toBe('outlook.body-content-type="text"');
  });

  it('sends the time zone preference only when one is given', async () => {
    mockedAxios.mockResolvedValue({ data: { value: [] } });
    const range = { start_date_time: '2026-10-08T00:00:00+02:00', end_date_time: '2026-10-09T00:00:00+02:00' };
    await newEngine().execute(connectorConfig(), tool('outlook_list_events').endpointMapping, {
      ...range,
      timezone: 'Europe/Berlin',
    });
    expect(sent().headers.Prefer).toBe('outlook.timezone="Europe/Berlin"');
    expect(sent().params).toMatchObject({ startDateTime: range.start_date_time, endDateTime: range.end_date_time });
    mockedAxios.mockClear();
    await newEngine().execute(connectorConfig(), tool('outlook_list_events').endpointMapping, range);
    expect(sent().headers).not.toHaveProperty('Prefer');
  });

  it('wraps sendMail fields in a message object', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    const to = [{ emailAddress: { address: 'ana@example.com' } }];
    await newEngine().execute(connectorConfig(), tool('outlook_send_mail').endpointMapping, {
      subject: 'Hi',
      body: { contentType: 'Text', content: 'Hello' },
      to_recipients: to,
    });
    expect(sent().data).toEqual({
      message: { subject: 'Hi', body: { contentType: 'Text', content: 'Hello' }, toRecipients: to },
    });
  });

  it('updates an event with only the fields given', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await newEngine().execute(connectorConfig(), tool('outlook_update_event').endpointMapping, {
      event_id: 'e1',
      start: { dateTime: '2026-10-08T14:00:00', timeZone: 'Europe/Berlin' },
    });
    expect(sent().data).toEqual({ start: { dateTime: '2026-10-08T14:00:00', timeZone: 'Europe/Berlin' } });
  });

  it('builds the getSchedule body Graph documents', async () => {
    mockedAxios.mockResolvedValue({ data: { value: [] } });
    const window = {
      start_time: { dateTime: '2026-10-08T08:00:00', timeZone: 'UTC' },
      end_time: { dateTime: '2026-10-08T18:00:00', timeZone: 'UTC' },
    };
    await newEngine().execute(connectorConfig(), tool('outlook_get_free_busy').endpointMapping, {
      schedules: ['ana@example.com'],
      ...window,
      interval_minutes: 60,
    });
    expect(sent().url).toBe('https://graph.microsoft.com/v1.0/me/calendar/getSchedule');
    expect(sent().data).toEqual({
      schedules: ['ana@example.com'],
      startTime: window.start_time,
      endTime: window.end_time,
      availabilityViewInterval: 60,
    });
  });

  it('advertises reads as read-only, getSchedule included, and has no delete tool', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual([
      'outlook_get_event',
      'outlook_get_free_busy',
      'outlook_get_me',
      'outlook_get_message',
      'outlook_list_calendar_events',
      'outlook_list_calendars',
      'outlook_list_child_folders',
      'outlook_list_events',
      'outlook_list_mail_folders',
      'outlook_list_messages',
      'outlook_search_messages',
    ]);
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
  });

  it('only points the model at tools that exist', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\boutlook_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\boutlook_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(5);
    for (const name of mentioned) expect(names).toContain(name);
  });
});

const live = process.env.RUN_OUTLOOK_LIVE ? describe : describe.skip;

live('microsoft-outlook adapter — live Graph API (read-only)', () => {
  const token = process.env.OUTLOOK_ACCESS_TOKEN ?? '';
  const liveConfig = () => ({
    baseUrl: a.connector.baseUrl,
    authType: 'BEARER_TOKEN',
    authConfig: { token },
    headers: { ...a.connector.headers },
  });

  beforeAll(() => {
    if (!token) throw new Error('Set OUTLOOK_ACCESS_TOKEN');
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  const run = (name: string, params: Record<string, unknown>) =>
    newEngine().execute(liveConfig(), tool(name).endpointMapping, params) as Promise<any>;

  it('reads the signed-in user', async () => {
    const me = await run('outlook_get_me', {});
    expect(typeof me.id).toBe('string');
  }, 30_000);

  it('lists mail folders and inbox messages, then reads one as text', async () => {
    const folders = await run('outlook_list_mail_folders', { top: 50 });
    expect(Array.isArray(folders.value)).toBe(true);
    const list = await run('outlook_list_messages', { folder_id: 'inbox', top: 3 });
    expect(Array.isArray(list.value)).toBe(true);
    if (list.value.length > 0) {
      const msg = await run('outlook_get_message', { message_id: list.value[0].id });
      expect(msg.body.contentType).toBe('text');
    }
  }, 60_000);

  it('searches the mailbox', async () => {
    const out = await run('outlook_search_messages', { search: '"the"', top: 3 });
    expect(Array.isArray(out.value)).toBe(true);
  }, 30_000);

  it('lists calendars and the next seven days of events', async () => {
    const cals = await run('outlook_list_calendars', {});
    expect(Array.isArray(cals.value)).toBe(true);
    const now = new Date();
    const events = await run('outlook_list_events', {
      start_date_time: now.toISOString(),
      end_date_time: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
      timezone: 'UTC',
      top: 5,
    });
    expect(Array.isArray(events.value)).toBe(true);
  }, 30_000);
});
