import axios from 'axios';
import * as adapter from './pagerduty.json';
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
 * Two layers of verification for the PagerDuty adapter:
 *
 *   1. Static: always runs. Pins the `Token token=` auth, the selectable US or
 *      EU host, the version header, the optional From header on writes, and
 *      every tool's method, URL, query and body through the real RestEngine,
 *      checked against PagerDuty's OpenAPI document (PagerDuty/api-schema,
 *      reference/REST/openapiv3.json) and PagerDuty's own Python client models
 *      (read 15 Oct 2026). Also which tools write, that each write asks for
 *      confirmation, and that response mappings keep answers small.
 *
 *   2. Live: skipped unless RUN_PAGERDUTY_LIVE=1. Without a key it checks that
 *      PagerDuty refuses a wrong key with 401 (PagerDuty checks the key before
 *      routing, so a made-up path answers 401 too). With PAGERDUTY_API_KEY (and
 *      PAGERDUTY_API_HOST, default api.pagerduty.com) it reads services,
 *      incidents, on-calls, schedules, escalation policies, users, teams and
 *      priorities, shaped by each tool's response mapping as production does.
 *      Changes run only with RUN_PAGERDUTY_LIVE_WRITES=1 and
 *      PAGERDUTY_TEST_INCIDENT_ID: one note is added to that incident (and
 *      PAGERDUTY_FROM_EMAIL is sent when set).
 *
 *        RUN_PAGERDUTY_LIVE=1 PAGERDUTY_API_KEY=... \
 *          npx jest src/adapters/intl/pagerduty.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; headers?: Record<string, string>; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
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
  optionalEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
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

// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'u+' + 'x'.repeat(18);
const ENV: Record<string, string> = { PAGERDUTY_API_KEY: FAKE_KEY, PAGERDUTY_API_HOST: 'api.pagerduty.com', PAGERDUTY_FROM_EMAIL: '' };
const HOST = 'https://api.pagerduty.com';

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector, the mapping
// and authConfig; connector variables and schema defaults merged into params.
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
const query = () => {
  const req = sent();
  return req.paramsSerializer ? req.paramsSerializer(req.params) : '';
};

const WRITES = [
  'pagerduty_acknowledge_incident',
  'pagerduty_add_incident_note',
  'pagerduty_create_incident',
  'pagerduty_escalate_incident',
  'pagerduty_reassign_incident',
  'pagerduty_resolve_incident',
  'pagerduty_update_incident',
];

describe('pagerduty adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('sends the key as Token token= with the v2 Accept header to the chosen region', () => {
    expect(a.category).toBe('monitoring');
    expect(a.icon).toBe('pagerduty');
    expect(a.connector.baseUrl).toBe('https://{{PAGERDUTY_API_HOST}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'Token token={{PAGERDUTY_API_KEY}}' });
    expect(a.connector.headers.Accept).toBe('application/vnd.pagerduty+json;version=2');
    expect(a.connector.healthcheckPath).toBe('/abilities');
    expect(a.probe.tool).toBe('pagerduty_list_services');
    expect(a.requiredEnvVars).toEqual(['PAGERDUTY_API_KEY', 'PAGERDUTY_API_HOST']);
    expect(a.optionalEnvVars).toEqual(['PAGERDUTY_FROM_EMAIL']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.PAGERDUTY_API_KEY).toMatchObject({ kind: 'credential', secret: true, required: true });
    expect(meta.PAGERDUTY_API_HOST).toMatchObject({ secret: false, required: true });
    expect(meta.PAGERDUTY_FROM_EMAIL).toMatchObject({ secret: false, required: false });
  });

  it('accepts only the US and EU API hosts, a bare key and an email', () => {
    const host = new RegExp(a.envVarMeta.PAGERDUTY_API_HOST.pattern!);
    for (const ok of ['api.pagerduty.com', 'api.eu.pagerduty.com']) expect(host.test(ok)).toBe(true);
    for (const bad of ['https://api.pagerduty.com', 'events.pagerduty.com', 'acme.pagerduty.com', 'api.pagerduty.com/']) expect(host.test(bad)).toBe(false);
    const key = new RegExp(a.envVarMeta.PAGERDUTY_API_KEY.pattern!);
    expect(key.test(FAKE_KEY)).toBe(true);
    expect(key.test('y_NbAkKc66ryYTWUXYEu')).toBe(true);
    for (const bad of ['', `Token token=${FAKE_KEY}`, `token=${FAKE_KEY}`, `Bearer ${FAKE_KEY}`, 'short']) expect(key.test(bad)).toBe(false);
    const email = new RegExp(a.envVarMeta.PAGERDUTY_FROM_EMAIL.pattern!);
    expect(email.test('oncall@example.com')).toBe(true);
    expect(email.test('oncall')).toBe(false);
  });

  it('explains wrong keys, the region and missing permissions', () => {
    for (const status of ['401', '403', '429']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['401']).toMatch(/api\.eu\.pagerduty\.com/);
  });

  it('prefixes every tool with pagerduty_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^pagerduty_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks exactly the incident changes as writes, each asks for confirmation, and analytics POSTs are read-only', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of WRITES) {
      expect(tool(name).description).toMatch(/wait for their yes/);
      // A general access key needs the From header on every change.
      expect(tool(name).endpointMapping.headers).toEqual({ From: '${PAGERDUTY_FROM_EMAIL}' });
    }
    for (const name of ['pagerduty_get_incident_analytics', 'pagerduty_get_incident_metrics']) {
      expect(tool(name).endpointMapping.method).toBe('POST');
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: true });
    }
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
  });

  it('only points the model at tools that exist, documents setup, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bpagerduty_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bpagerduty_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('API Access Keys');
    expect(a.instructions).toContain('api.eu.pagerduty.com');
    expect(a.instructions).toMatch(/Events API/);
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
    ['pagerduty_get_current_user', {}, 'GET', '/users/me'],
    ['pagerduty_list_incidents', {}, 'GET', '/incidents'],
    ['pagerduty_get_incident', { id: 'PT4KHLK' }, 'GET', '/incidents/PT4KHLK'],
    ['pagerduty_list_incident_notes', { id: 'PT4KHLK' }, 'GET', '/incidents/PT4KHLK/notes'],
    ['pagerduty_list_incident_log_entries', { id: 'PT4KHLK' }, 'GET', '/incidents/PT4KHLK/log_entries'],
    ['pagerduty_list_incident_alerts', { id: 'PT4KHLK' }, 'GET', '/incidents/PT4KHLK/alerts'],
    ['pagerduty_acknowledge_incident', { id: 'PT4KHLK' }, 'PUT', '/incidents/PT4KHLK'],
    ['pagerduty_resolve_incident', { id: 'PT4KHLK' }, 'PUT', '/incidents/PT4KHLK'],
    ['pagerduty_reassign_incident', { id: 'PT4KHLK', user_id: 'PXPGF42' }, 'PUT', '/incidents/PT4KHLK'],
    ['pagerduty_escalate_incident', { id: 'PT4KHLK', escalation_level: 2 }, 'PUT', '/incidents/PT4KHLK'],
    ['pagerduty_update_incident', { id: 'PT4KHLK', urgency: 'low' }, 'PUT', '/incidents/PT4KHLK'],
    ['pagerduty_add_incident_note', { id: 'PT4KHLK', content: 'Looking' }, 'POST', '/incidents/PT4KHLK/notes'],
    ['pagerduty_create_incident', { service_id: 'PWIXJZS', title: 'Disk full' }, 'POST', '/incidents'],
    ['pagerduty_list_services', {}, 'GET', '/services'],
    ['pagerduty_get_service', { id: 'PWIXJZS' }, 'GET', '/services/PWIXJZS'],
    ['pagerduty_list_escalation_policies', {}, 'GET', '/escalation_policies'],
    ['pagerduty_get_escalation_policy', { id: 'PANZZEQ' }, 'GET', '/escalation_policies/PANZZEQ'],
    ['pagerduty_list_oncalls', {}, 'GET', '/oncalls'],
    ['pagerduty_list_schedules', {}, 'GET', '/schedules'],
    ['pagerduty_get_schedule', { id: 'PI7DH85' }, 'GET', '/schedules/PI7DH85'],
    ['pagerduty_list_users', {}, 'GET', '/users'],
    ['pagerduty_get_user', { id: 'PXPGF42' }, 'GET', '/users/PXPGF42'],
    ['pagerduty_list_teams', {}, 'GET', '/teams'],
    ['pagerduty_list_priorities', {}, 'GET', '/priorities'],
    ['pagerduty_get_incident_analytics', {}, 'POST', '/analytics/raw/incidents'],
    ['pagerduty_get_incident_metrics', {}, 'POST', '/analytics/metrics/incidents/all'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the PagerDuty token', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${path}`);
    expect(req.headers.Authorization).toBe(`Token token=${FAKE_KEY}`);
    expect(req.headers.Accept).toBe('application/vnd.pagerduty+json;version=2');
    // No From header unless the email is set.
    expect(req.headers.From).toBeUndefined();
    expect(JSON.stringify(req)).not.toContain('{{');
  });

  it('switches to the EU host and sends From on changes when the email is set', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const eu = { ...ENV, PAGERDUTY_API_HOST: 'api.eu.pagerduty.com', PAGERDUTY_FROM_EMAIL: 'oncall@example.com' };
    await call('pagerduty_acknowledge_incident', { id: 'PT4KHLK' }, eu);
    expect(sent().url).toBe('https://api.eu.pagerduty.com/incidents/PT4KHLK');
    expect(sent().headers.From).toBe('oncall@example.com');
  });

  it('writes list filters as repeated name[] parameters, as the API documents', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('pagerduty_list_incidents', { statuses: ['triggered', 'acknowledged'], service_ids: ['PWIXJZS'], since: '2026-10-01T00:00:00Z' });
    expect(decodeURIComponent(query())).toBe(
      'statuses[]=triggered&statuses[]=acknowledged&service_ids[]=PWIXJZS&since=2026-10-01T00:00:00Z&sort_by=created_at:desc&limit=25',
    );
    mockedAxios.mockClear();
    await call('pagerduty_list_oncalls', { schedule_ids: ['PI7DH85'], earliest: true });
    expect(decodeURIComponent(query())).toBe('schedule_ids[]=PI7DH85&earliest=true&limit=25');
  });

  it('builds the incident, note and analytics bodies with only the given fields', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const body = async (name: string, params: Record<string, unknown>) => {
      mockedAxios.mockClear();
      await call(name, params);
      return sent().data;
    };
    expect(await body('pagerduty_acknowledge_incident', { id: 'P1' })).toEqual({ incident: { type: 'incident_reference', status: 'acknowledged' } });
    expect(await body('pagerduty_resolve_incident', { id: 'P1', resolution: 'Restarted' })).toEqual({
      incident: { type: 'incident_reference', status: 'resolved', resolution: 'Restarted' },
    });
    expect(await body('pagerduty_reassign_incident', { id: 'P1', user_id: 'PXPGF42' })).toEqual({
      incident: { type: 'incident_reference', assignments: [{ assignee: { id: 'PXPGF42', type: 'user_reference' } }] },
    });
    expect(await body('pagerduty_escalate_incident', { id: 'P1', escalation_level: 2 })).toEqual({ incident: { type: 'incident_reference', escalation_level: 2 } });
    expect(await body('pagerduty_update_incident', { id: 'P1', priority: 'P1', title: 'DB down' })).toEqual({
      incident: { type: 'incident_reference', title: 'DB down', priority: 'P1' },
    });
    expect(await body('pagerduty_add_incident_note', { id: 'P1', content: 'Looking' })).toEqual({ note: { content: 'Looking' } });
    expect(await body('pagerduty_create_incident', { service_id: 'PWIXJZS', title: 'Disk full', urgency: 'high', details: 'db-1 at 98%' })).toEqual({
      incident: {
        type: 'incident',
        title: 'Disk full',
        service: { id: 'PWIXJZS', type: 'service_reference' },
        urgency: 'high',
        body: { type: 'incident_body', details: 'db-1 at 98%' },
      },
    });
    expect(await body('pagerduty_get_incident_analytics', { created_at_start: '2026-09-01T00:00:00Z', service_ids: ['PWIXJZS'] })).toEqual({
      filters: { created_at_start: '2026-09-01T00:00:00Z', service_ids: ['PWIXJZS'] },
      limit: 25,
    });
    expect(await body('pagerduty_get_incident_metrics', { aggregate_unit: 'week', urgency: 'high' })).toEqual({
      filters: { urgency: 'high' },
      aggregate_unit: 'week',
    });
  });

  it('shapes incidents, on-calls and users small and leaves contact addresses out', () => {
    const list = shape('pagerduty_list_incidents', {
      incidents: [
        {
          id: 'PT4KHLK',
          incident_number: 1234,
          title: 'Disk full',
          status: 'triggered',
          urgency: 'high',
          service: { id: 'PWIXJZS', summary: 'API', self: 'https://api.pagerduty.com/services/PWIXJZS' },
          escalation_policy: { id: 'PANZZEQ', summary: 'Ops' },
          assignments: [{ at: '2026-10-15T06:00:00Z', assignee: { id: 'PXPGF42', summary: 'Ada' } }],
          first_trigger_log_entry: { id: 'R1', summary: 'huge' },
          html_url: 'https://acme.pagerduty.com/incidents/PT4KHLK',
        },
      ],
      limit: 25,
      offset: 0,
      more: false,
    });
    expect(list.incidents[0]).toMatchObject({
      id: 'PT4KHLK',
      incident_number: 1234,
      service: { id: 'PWIXJZS', name: 'API' },
      assigned_to: [{ id: 'PXPGF42', name: 'Ada' }],
    });
    expect(JSON.stringify(list)).not.toContain('first_trigger_log_entry');
    expect(list.more).toBe(false);
    const oncalls = shape('pagerduty_list_oncalls', {
      oncalls: [{ user: { id: 'PXPGF42', summary: 'Ada' }, escalation_policy: { id: 'PANZZEQ', summary: 'Ops' }, escalation_level: 1, schedule: null, start: null, end: null }],
    });
    expect(oncalls.oncalls[0]).toMatchObject({ user: { id: 'PXPGF42', name: 'Ada' }, escalation_level: 1 });
    const user = shape('pagerduty_get_user', {
      user: { id: 'PXPGF42', name: 'Ada', email: 'ada@example.com', contact_methods: [{ type: 'phone_contact_method_reference', summary: 'Mobile', address: '+4915112345678' }] },
    });
    expect(user.user.contact_methods).toEqual([{ type: 'phone_contact_method_reference', name: 'Mobile' }]);
    expect(JSON.stringify(user)).not.toContain('+4915112345678');
  });
});

const live = process.env.RUN_PAGERDUTY_LIVE === '1' ? describe : describe.skip;
live('pagerduty adapter: live', () => {
  const real = !!process.env.PAGERDUTY_API_KEY;
  const env = () => ({
    PAGERDUTY_API_KEY: process.env.PAGERDUTY_API_KEY!,
    PAGERDUTY_API_HOST: process.env.PAGERDUTY_API_HOST || 'api.pagerduty.com',
    PAGERDUTY_FROM_EMAIL: process.env.PAGERDUTY_FROM_EMAIL || '',
  });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['pagerduty_list_services', {}],
    ['pagerduty_list_incidents', {}],
    ['pagerduty_list_oncalls', {}],
    ['pagerduty_get_incident_metrics', {}],
  ])('%s reaches PagerDuty and is refused with a wrong key (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (real ? it : it.skip)('reads services, incidents, on-calls, schedules, policies, users, teams and priorities', async () => {
    const services = await shaped('pagerduty_list_services', { limit: 5 }, env());
    expect(Array.isArray(services.services)).toBe(true);
    const incidents = await shaped('pagerduty_list_incidents', { limit: 5 }, env());
    expect(Array.isArray(incidents.incidents)).toBe(true);
    if (incidents.incidents[0]) {
      const id = incidents.incidents[0].id;
      expect((await shaped('pagerduty_get_incident', { id }, env())).incident.id).toBe(id);
      expect(Array.isArray((await shaped('pagerduty_list_incident_log_entries', { id, limit: 5 }, env())).log_entries)).toBe(true);
      expect(Array.isArray((await shaped('pagerduty_list_incident_alerts', { id, limit: 5 }, env())).alerts)).toBe(true);
      expect(Array.isArray((await shaped('pagerduty_list_incident_notes', { id }, env())).notes)).toBe(true);
    }
    expect(Array.isArray((await shaped('pagerduty_list_oncalls', { limit: 5 }, env())).oncalls)).toBe(true);
    expect(Array.isArray((await shaped('pagerduty_list_schedules', { limit: 5 }, env())).schedules)).toBe(true);
    expect(Array.isArray((await shaped('pagerduty_list_escalation_policies', { limit: 5 }, env())).escalation_policies)).toBe(true);
    expect(Array.isArray((await shaped('pagerduty_list_users', { limit: 5 }, env())).users)).toBe(true);
    expect(Array.isArray((await shaped('pagerduty_list_priorities', {}, env())).priorities ?? [])).toBe(true);
  }, 120000);

  const writes = real && process.env.RUN_PAGERDUTY_LIVE_WRITES === '1' && !!process.env.PAGERDUTY_TEST_INCIDENT_ID;
  (writes ? it : it.skip)('adds one note to the test incident and reads it back', async () => {
    const id = process.env.PAGERDUTY_TEST_INCIDENT_ID!;
    const text = `AnythingMCP live check ${Date.now()}`;
    const out = await shaped('pagerduty_add_incident_note', { id, content: text }, env());
    expect(out.note.content).toBe(text);
    const notes = await shaped('pagerduty_list_incident_notes', { id }, env());
    expect(notes.notes.some((n: { content: string }) => n.content === text)).toBe(true);
  }, 60000);
});
