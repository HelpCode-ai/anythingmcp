import axios from 'axios';
import * as adapter from './digisac.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the DIGISAC adapter (REST API v1):
 *
 *   1. Static: always runs. Pins the Bearer token on <DIGISAC_URL>/api/v1,
 *      every tool's method and URL through the real RestEngine against the
 *      official DIGISAC Postman collection, the bracket filters and JSON
 *      `query` text, the message, template, ticket and schedule bodies, and
 *      which tools write or install switched off.
 *
 *   2. Live: skipped unless RUN_DIGISAC_LIVE=1, DIGISAC_URL and
 *      DIGISAC_API_TOKEN are set. Reads only: the user, connections,
 *      departments, contacts, tickets and the live overview. Nothing here
 *      sends a message or touches a ticket.
 *
 *        RUN_DIGISAC_LIVE=1 DIGISAC_URL=https://<account>.digisac.co DIGISAC_API_TOKEN=... \
 *          npx jest src/adapters/br/digisac.live.spec.ts
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
  endpointMapping: { method: string; path: string; encodePathParams?: boolean; headers?: Record<string, string>; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
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
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath?: string; config?: { errorWhen?: unknown } };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

// Built at run time so no literal here looks like a real credential.
const TOKEN = ['9f3a1c2e', '7b6d5a4c3b2a19f8e7d6c5b4'].join('');
const ORIGIN = 'https://empresa.digisac.co';
const BASE = `${ORIGIN}/api/v1`;
const ENV = { DIGISAC_URL: ORIGIN, DIGISAC_API_TOKEN: TOKEN };
const ID = '5a2e6a4c-1b2c-4d3e-8f90-123456789abc';
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
  const c = interpolateDeep(a.connector, env) as typeof a.connector;
  return engine().execute(
    { baseUrl: c.baseUrl, authType: c.authType, authConfig: c.authConfig, headers: c.headers, errorWhen: c.config?.errorWhen },
    interpolateDeep(tool(name).endpointMapping, env) as Tool['endpointMapping'],
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown> = {}) => execute(name, ENV, params);
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES: string[] = ["digisac_create_contact", "digisac_update_contact", "digisac_send_message", "digisac_send_template", "digisac_transfer_ticket", "digisac_close_ticket", "digisac_schedule_message", "digisac_cancel_schedule"];
const SWITCHED_OFF: string[] = ["digisac_send_message", "digisac_send_template", "digisac_transfer_ticket", "digisac_close_ticket", "digisac_schedule_message", "digisac_cancel_schedule"];
const READ_POSTS: string[] = [];

describe('digisac adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed under br/messaging with its own icon', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('digisac');
    expect(a.region).toBe('br');
    expect(a.icon).toBe('digisac');
    expect(a.category).toBe('messaging');
    expect(getAdapter('digisac')).toBeDefined();
  });

  it('sends the token as Bearer to the account address plus /api/v1', async () => {
    expect(a.connector.baseUrl).toBe('{{DIGISAC_URL}}/api/v1');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{DIGISAC_API_TOKEN}}' });
    expect(a.probe.tool).toBe('digisac_get_me');
    mockedAxios.mockResolvedValue({ data: { id: ID } });
    await call('digisac_get_me');
    expect(sent().headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent().url).toBe(`${BASE}/me`);
  });

  it('asks for credentials as secrets with a pattern that refuses pasted prefixes', () => {
    for (const [name, meta] of Object.entries(a.envVarMeta)) {
      if (meta.kind === 'credential') expect(`${name}:${meta.secret}`).toBe(`${name}:true`);
      expect(meta.pattern).toBeDefined();
    }
    const described = describeAdapterEnvVars(a as never);
    for (const name of a.requiredEnvVars) expect(described.find((d) => d.name === name)).toBeDefined();
    const url = new RegExp(a.envVarMeta.DIGISAC_URL.pattern!);
    for (const ok of ['https://empresa.digisac.co', 'https://empresa.digisac.app', 'https://empresa-api.digisac.com.br']) expect(url.test(ok)).toBe(true);
    for (const bad of ['http://empresa.digisac.co', 'https://empresa.digisac.co/api/v1', 'https://evil.example.com', 'https://digisac.co.evil.com']) expect(url.test(bad)).toBe(false);
    const tok = new RegExp(a.envVarMeta.DIGISAC_API_TOKEN.pattern!);
    expect(tok.test(TOKEN)).toBe(true);
    for (const bad of [`Bearer ${TOKEN}`, 'short', `${TOKEN} x`]) expect(tok.test(bad)).toBe(false);
  });

  it('prefixes every tool with digisac_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^digisac_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
    expect(mine.has(a.probe.tool)).toBe(true);
  });

  it('marks reads read-only, every write as a write with a confirmation, and installs the risky ones switched off', () => {
    for (const t of a.tools) {
      const read = t.endpointMapping.method === 'GET' || READ_POSTS.includes(t.name);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${read}`);
    }
    expect(a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort()).toEqual([...WRITES].sort());
    for (const name of WRITES) expect(`${name}:${/confirm|wait for a yes/i.test(tool(name).description)}`).toBe(`${name}:true`);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...SWITCHED_OFF].sort());
    expect(annotationsOf(tool(a.probe.tool)).readOnlyHint).toBe(true);
  });

  it('URL-encodes path parameters, so an id cannot reach another route', () => {
    for (const t of a.tools.filter((x) => /\{[a-z_]+\}/.test(x.endpointMapping.path))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bdigisac_[a-z0-9_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bdigisac_[a-z0-9_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(3);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## DIGISAC\n')).toBe(true);
    expect(a.instructions).toContain('Out of scope');
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  // [tool, args, method, url]
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ["digisac_get_me", {}, "GET", `${BASE}/me`],
    ["digisac_list_connections", {}, "GET", `${BASE}/services`],
    ["digisac_list_departments", {}, "GET", `${BASE}/departments`],
    ["digisac_list_users", {}, "GET", `${BASE}/users`],
    ["digisac_list_tags", {}, "GET", `${BASE}/tags`],
    ["digisac_list_contacts", {}, "GET", `${BASE}/contacts`],
    ["digisac_find_contact_by_number", {"number": "5511987654321"}, "GET", `${BASE}/contacts`],
    ["digisac_get_contact", {"contact_id": "C1"}, "GET", `${BASE}/contacts/C1`],
    ["digisac_list_tickets", {}, "GET", `${BASE}/tickets`],
    ["digisac_list_contact_tickets", {"contact_id": "C1"}, "GET", `${BASE}/tickets`],
    ["digisac_get_ticket", {"ticket_id": "T1"}, "GET", `${BASE}/tickets/T1`],
    ["digisac_list_contact_messages", {"contact_id": "C1"}, "GET", `${BASE}/messages`],
    ["digisac_list_messages", {}, "GET", `${BASE}/messages`],
    ["digisac_get_message", {"message_id": "M1"}, "GET", `${BASE}/messages/M1`],
    ["digisac_list_whatsapp_templates", {}, "GET", `${BASE}/whatsapp-business-templates`],
    ["digisac_list_quick_replies", {}, "GET", `${BASE}/quick-replies`],
    ["digisac_list_ticket_topics", {}, "GET", `${BASE}/ticket-topics`],
    ["digisac_list_schedules", {}, "GET", `${BASE}/schedule`],
    ["digisac_list_pipelines", {}, "GET", `${BASE}/pipelines`],
    ["digisac_list_pipeline_cards", {"pipeline_id": "P1"}, "GET", `${BASE}/cards`],
    ["digisac_list_kanban_boards", {}, "GET", `${BASE}/kanban-boards`],
    ["digisac_list_kanban_columns", {"board_id": "B1"}, "GET", `${BASE}/kanban-columns`],
    ["digisac_list_kanban_cards", {"column_id": "K1"}, "GET", `${BASE}/kanban-cards`],
    ["digisac_get_service_stats", {"startPeriod": "2026-10-01T00:00:00.000Z", "endPeriod": "2026-10-31T23:59:59.999Z"}, "GET", `${BASE}/dashboard/general`],
    ["digisac_get_live_overview", {}, "GET", `${BASE}/now/resume`],
    ["digisac_get_departments_live", {}, "GET", `${BASE}/now/departments-resume`],
    ["digisac_create_contact", {"name": "Maria", "number": "5511987654321", "service_id": "S1"}, "POST", `${BASE}/contacts`],
    ["digisac_update_contact", {"contact_id": "C1", "note": "x"}, "PUT", `${BASE}/contacts/C1`],
    ["digisac_send_message", {"contact_id": "C1", "text": "Oi"}, "POST", `${BASE}/messages`],
    ["digisac_send_template", {"number": "5511987654321", "service_id": "S1", "hsm_id": "H1"}, "POST", `${BASE}/messages`],
    ["digisac_transfer_ticket", {"contact_id": "C1", "department_id": "D1"}, "POST", `${BASE}/contacts/C1/ticket/transfer`],
    ["digisac_close_ticket", {"contact_id": "C1"}, "POST", `${BASE}/contacts/C1/ticket/close`],
    ["digisac_schedule_message", {"contact_id": "C1", "department_id": "D1", "user_id": "U1", "message": "Oi", "scheduled_at": "2026-10-20 09:00:00"}, "POST", `${BASE}/schedule`],
    ["digisac_cancel_schedule", {"schedule_id": "S9"}, "DELETE", `${BASE}/schedule/S9`],
  ];

  it('lists every tool in the URL table', () => {
    expect([...new Set(table.map(([name]) => name))].sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s %s', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(sent().method.toUpperCase()).toBe(method);
    expect(sent().url).toBe(url);
  });

  it('passes the JSON filter text through as query, with perPage 20 by default', async () => {
    mockedAxios.mockResolvedValue({ data: { data: [] } });
    const query = '{"where":{"isOpen":true},"include":["contact"],"order":[["updatedAt","DESC"]]}';
    await call('digisac_list_tickets', { query });
    expect(sent().params).toEqual({ query, perPage: 20 });
  });

  it('builds the bracket filters DIGISAC parses: number search, contact history, cards, kanban', async () => {
    mockedAxios.mockResolvedValue({ data: { data: [] } });
    await call('digisac_find_contact_by_number', { number: '987654321', service_id: 'S1' });
    expect(sent().params).toEqual({ 'where[data.number][$iLike]': '%987654321%', 'where[serviceId]': 'S1', perPage: 20 });
    mockedAxios.mockClear();
    await call('digisac_list_contact_messages', { contact_id: 'C1' });
    expect(sent().params).toEqual({ 'where[contactId]': 'C1', 'order[0][0]': 'timestamp', 'order[0][1]': 'DESC', perPage: 30 });
    mockedAxios.mockClear();
    await call('digisac_list_pipeline_cards', { pipeline_id: 'P1' });
    expect(sent().params).toEqual({ 'where[pipelineId]': 'P1', 'include[0]': 'pipelineStage', perPage: 30 });
    mockedAxios.mockClear();
    await call('digisac_list_kanban_columns', { board_id: 'B1' });
    expect(JSON.parse(sent().params.query)).toEqual({ paginate: false, withTotal: false, where: { kanbanBoardId: 'B1' } });
  });

  it('sends texts with type chat and templates by hsmId, never to a hard-coded contact', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('digisac_send_message', { contact_id: 'C1', text: 'Oi', dont_open_ticket: true });
    expect(sent().data).toEqual({ contactId: 'C1', text: 'Oi', type: 'chat', dontOpenTicket: true });
    mockedAxios.mockClear();
    const parameters = [{ type: 'body', parameters: [{ type: 'text', text: 'Maria' }] }];
    await call('digisac_send_template', { number: '5511987654321', service_id: 'S1', hsm_id: 'H1', parameters });
    expect(sent().data).toEqual({ number: '5511987654321', serviceId: 'S1', hsmId: 'H1', parameters, type: 'chat' });
  });

  it('schedules with DIGISAC field names and false defaults for ticket and notification', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('digisac_schedule_message', { contact_id: 'C1', department_id: 'D1', user_id: 'U1', message: 'Oi', scheduled_at: '2026-10-20 09:00:00' });
    expect(sent().data).toEqual({ contactId: 'C1', departmentId: 'D1', userId: 'U1', message: 'Oi', scheduledAt: '2026-10-20 09:00:00', openTicket: false, notificateUser: false });
  });

  it('encodes ids in the path', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('digisac_get_contact', { contact_id: '../me' });
    expect(sent().url).toBe(`${BASE}/contacts/..%2Fme`);
  });
});

const LIVE = process.env.RUN_DIGISAC_LIVE === '1' && process.env.DIGISAC_URL && process.env.DIGISAC_API_TOKEN;
const live = LIVE ? describe : describe.skip;

live('digisac adapter: live API (reads only)', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const env = () => ({ DIGISAC_URL: process.env.DIGISAC_URL as string, DIGISAC_API_TOKEN: process.env.DIGISAC_API_TOKEN as string });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env(), params);

  it('reads the user, connections, departments, contacts, tickets and the live overview', async () => {
    expect((await run('digisac_get_me')).id).toBeDefined();
    for (const name of ['digisac_list_connections', 'digisac_list_departments', 'digisac_list_contacts', 'digisac_list_tickets']) {
      const page = await run(name, { perPage: 2 });
      expect(Array.isArray(page.data)).toBe(true);
    }
    expect((await run('digisac_get_live_overview')).totals).toBeDefined();
  }, 60_000);
});
