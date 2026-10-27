import axios from 'axios';
import * as adapter from './interakt.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Interakt adapter (public API v1):
 *
 *   1. Static: always runs. Pins the Basic header with the pasted secret key,
 *      every tool's method and URL through the real RestEngine against
 *      Interakt's published Postman collection, the customer search filters,
 *      the template body (bodyValues in order, the cause of the "Missing
 *      variable values" refusals), traits sent
 *      as an object, and the result:false error rule.
 *
 *   2. Live: skipped unless RUN_INTERAKT_LIVE=1 and INTERAKT_API_KEY are set.
 *      Reads only: templates and one page of customers. Nothing is sent.
 *
 *        RUN_INTERAKT_LIVE=1 INTERAKT_API_KEY=... npx jest src/adapters/in/interakt.live.spec.ts
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
const KEY = ['QWJjRGVmR2hp', 'SmtsTW5vUHFyU3R1dnd4eXo='].join('');
const BASE = 'https://api.interakt.ai';
const ENV = { INTERAKT_API_KEY: KEY };
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

const WRITES: string[] = ["interakt_upsert_customer", "interakt_track_event", "interakt_assign_chat", "interakt_send_template", "interakt_send_text"];
const SWITCHED_OFF: string[] = ["interakt_send_template", "interakt_send_text"];
const READ_POSTS: string[] = ["interakt_list_customers"];

describe('interakt adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed under in/messaging with its own icon', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('interakt');
    expect(a.region).toBe('in');
    expect(a.icon).toBe('interakt');
    expect(a.category).toBe('messaging');
    expect(getAdapter('interakt')).toBeDefined();
  });

  it('sends the key as Authorization: Basic <key> to api.interakt.ai', async () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'Basic {{INTERAKT_API_KEY}}' });
    expect(a.probe.tool).toBe('interakt_list_templates');
    mockedAxios.mockResolvedValue({ data: { count: 0, results: { templates: [] } } });
    await call('interakt_list_templates');
    expect(sent().headers.Authorization).toBe(`Basic ${KEY}`);
  });

  it('asks for credentials as secrets with a pattern that refuses pasted prefixes', () => {
    for (const [name, meta] of Object.entries(a.envVarMeta)) {
      if (meta.kind === 'credential') expect(`${name}:${meta.secret}`).toBe(`${name}:true`);
      expect(meta.pattern).toBeDefined();
    }
    const described = describeAdapterEnvVars(a as never);
    for (const name of a.requiredEnvVars) expect(described.find((d) => d.name === name)).toBeDefined();
    const re = new RegExp(a.envVarMeta.INTERAKT_API_KEY.pattern!);
    expect(re.test(KEY)).toBe(true);
    for (const bad of [`Basic ${KEY}`, 'short', `${KEY} x`]) expect(re.test(bad)).toBe(false);
  });

  it('prefixes every tool with interakt_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^interakt_[a-z0-9_]+$/);
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
      ...a.instructions.matchAll(/\binterakt_[a-z0-9_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\binterakt_[a-z0-9_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(3);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Interakt\n')).toBe(true);
    expect(a.instructions).toContain('Out of scope');
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  // [tool, args, method, url]
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ["interakt_list_templates", {}, "GET", `${BASE}/v1/public/track/organization/templates`],
    ["interakt_list_customers", {}, "POST", `${BASE}/v1/public/apis/users/`],
    ["interakt_get_customer_by_phone", {"phone_number": "9876543210"}, "GET", `${BASE}/v1/public/apis/users/phone_number/9876543210`],
    ["interakt_get_customer", {"customer_id": "abc"}, "GET", `${BASE}/v1/public/apis/users/id/abc`],
    ["interakt_upsert_customer", {"phone_number": "9876543210"}, "POST", `${BASE}/v1/public/track/users/`],
    ["interakt_track_event", {"phone_number": "9876543210", "event": "Order Placed"}, "POST", `${BASE}/v1/public/track/events/`],
    ["interakt_assign_chat", {"full_phone_number": "919876543210", "agent_email": "a@example.com"}, "POST", `${BASE}/v1/public/assignment/`],
    ["interakt_send_template", {"phone_number": "9876543210", "template_name": "order_update", "body_values": ["A", "B"]}, "POST", `${BASE}/v1/public/message/`],
    ["interakt_send_text", {"full_phone_number": "919876543210", "message": "Hi"}, "POST", `${BASE}/v1/public/message/`],
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

  it('lists templates of every language with all auto-submitted ones', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('interakt_list_templates', { approval_status: 'APPROVED' });
    expect(sent().params).toEqual({ approval_status: 'APPROVED', autosubmitted_for: 'all', language: 'all' });
  });

  it('searches customers with a closed time window, so an empty search is not refused', async () => {
    mockedAxios.mockResolvedValue({ data: { result: true, data: { customers: [] } } });
    await call('interakt_list_customers');
    expect(sent().params).toEqual({ offset: 0, limit: 50 });
    expect(sent().data).toEqual({
      filters: [
        { trait: 'created_at_utc', op: 'gte', val: '2015-01-01T00:00:00.000Z' },
        { trait: 'created_at_utc', op: 'lt', val: '2100-01-01T00:00:00.000Z', supr_op: 'and' },
      ],
    });
  });

  it('sends a template with its body values in order and +91 by default', async () => {
    mockedAxios.mockResolvedValue({ data: { result: true, id: 'x' } });
    await call('interakt_send_template', { phone_number: '9876543210', template_name: 'order_update', body_values: ['Asha', '#12'] });
    expect(sent().data).toEqual({
      countryCode: '+91',
      phoneNumber: '9876543210',
      type: 'Template',
      template: { name: 'order_update', languageCode: 'en', bodyValues: ['Asha', '#12'] },
    });
    expect(tool('interakt_send_template').parameters.required).toContain('body_values');
  });

  it('types traits as an object and sends them as one', async () => {
    expect(tool('interakt_upsert_customer').parameters.properties!.traits.type).toBe('object');
    mockedAxios.mockResolvedValue({ data: { result: true } });
    await call('interakt_upsert_customer', { phone_number: '9876543210', traits: { name: 'Asha' }, tags: ['vip'] });
    expect(sent().data).toEqual({ phoneNumber: '9876543210', countryCode: '+91', traits: { name: 'Asha' }, tags: ['vip'] });
  });

  it('turns result:false in a 2xx answer into an error with Interakt\'s message', async () => {
    mockedAxios.mockResolvedValue({ data: { result: false, message: 'Customer has not messaged within last 24 hours' } });
    await expect(call('interakt_get_customer', { customer_id: 'abc' })).rejects.toMatchObject({ status: 400 });
  });
});

const LIVE_KEY = process.env.INTERAKT_API_KEY;
const live = process.env.RUN_INTERAKT_LIVE === '1' && LIVE_KEY ? describe : describe.skip;

live('interakt adapter: live API (reads only)', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, { INTERAKT_API_KEY: LIVE_KEY as string }, params);

  it('reads templates and a page of customers', async () => {
    expect(Array.isArray((await run('interakt_list_templates')).results.templates)).toBe(true);
    expect(Array.isArray((await run('interakt_list_customers', { limit: 2 })).data.customers)).toBe(true);
  }, 60_000);
});
