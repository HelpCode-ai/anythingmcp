import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as adapterJson from './kommo.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { interpolateDeep } from '../../common/env-interpolation.util';

/**
 * Static checks and request-shape checks against a local server always run.
 * The live block runs read-only calls through the real RestEngine with a
 * long-lived token (Kommo allows 7 requests per second):
 *   KOMMO_SUBDOMAIN=acme KOMMO_ACCESS_TOKEN=eyJ... npx jest src/adapters/intl/kommo.live.spec.ts
 * KOMMO_LIVE_WRITE=1 also creates a lead named "AnythingMCP test" with a note
 * and a task. The API cannot delete leads, so at the end the task is closed
 * and the lead is moved to Closed-lost (143).
 */

type Mapping = {
  method: string;
  path: string;
  queryParams?: Record<string, unknown>;
  // An array for the create tools: Kommo takes a list of entities.
  bodyMapping?: Record<string, unknown>;
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { default?: unknown; maximum?: number }>; required?: string[] };
  endpointMapping: Mapping;
};
const a = adapterJson as unknown as {
  unlisted?: boolean;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind: string; secret?: boolean }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
const WRITES = ['kommo_add_note', 'kommo_create_contact', 'kommo_create_lead', 'kommo_create_task', 'kommo_update_lead'];

describe('kommo adapter: static spec conformance', () => {
  it('is listed (verified live on 10 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('calls API v4 on the account subdomain with the long-lived token as Bearer', () => {
    expect(a.connector.baseUrl).toBe('https://{{KOMMO_SUBDOMAIN}}.kommo.com/api/v4');
    expect(interpolateDeep(a.connector.baseUrl, { KOMMO_SUBDOMAIN: 'acme' })).toBe('https://acme.kommo.com/api/v4');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{KOMMO_ACCESS_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['KOMMO_SUBDOMAIN', 'KOMMO_ACCESS_TOKEN']);
    expect(a.envVarMeta.KOMMO_SUBDOMAIN.kind).toBe('address');
    expect(a.envVarMeta.KOMMO_ACCESS_TOKEN.secret).toBe(true);
  });

  it('probes with the account, which needs no argument', () => {
    expect(a.probe.tool).toBe('kommo_get_account');
    expect(tool('kommo_get_account').endpointMapping).toMatchObject({ method: 'GET', path: '/account' });
  });

  it('prefixes every tool, writes only through the expected tools and never deletes', () => {
    for (const t of a.tools) expect(t.name.startsWith('kommo_')).toBe(true);
    const writes = a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of WRITES) expect(tool(name).description).toMatch(/confirm/i);
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
    expect(a.tools.filter((t) => t.enabled === false)).toEqual([]);
  });

  it('creates entities with the array body the API expects', () => {
    for (const name of ['kommo_create_lead', 'kommo_create_contact', 'kommo_create_task', 'kommo_add_note']) {
      expect(Array.isArray(tool(name).endpointMapping.bodyMapping)).toBe(true);
    }
    expect(Array.isArray(tool('kommo_update_lead').endpointMapping.bodyMapping)).toBe(false);
  });

  it('pages lists with page and limit up to 250 (100 for the event log)', () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'GET' && x.parameters.properties?.limit)) {
      expect(t.parameters.properties!.limit.maximum).toBe(t.name === 'kommo_list_events' ? 100 : 250);
      expect(t.endpointMapping.queryParams).toMatchObject({ page: '$page', limit: '$limit' });
    }
    expect(a.instructions).toMatch(/HTTP 204/);
  });

  it('reads the event log with the documented filters', () => {
    const t = tool('kommo_list_events');
    expect(t.endpointMapping).toMatchObject({ method: 'GET', path: '/events' });
    expect(t.endpointMapping.queryParams).toEqual({
      'filter[type][]': '$types',
      'filter[entity][]': '$entity',
      'filter[entity_id][]': '$entity_ids',
      'filter[created_by][]': '$created_by',
      'filter[created_at][from]': '$created_from',
      'filter[created_at][to]': '$created_to',
      'filter[id][]': '$ids',
      with: '$with',
      page: '$page',
      limit: '$limit',
    });
    expect(t.parameters.required).toBeUndefined();
    expect(t.description).toContain('lead_status_changed');
  });

  it('reads the notes of a whole entity type, separate from one record\'s notes', () => {
    const t = tool('kommo_list_notes_by_type');
    expect(t.endpointMapping).toMatchObject({ method: 'GET', path: '/{entity_type}/notes' });
    expect(t.parameters.required).toEqual(['entity_type']);
    expect(t.endpointMapping.queryParams).toMatchObject({
      'filter[note_type][]': '$note_types',
      'filter[entity_id][]': '$entity_ids',
      'filter[id][]': '$ids',
      'filter[updated_at][from]': '$updated_from',
      'filter[updated_at][to]': '$updated_to',
      'order[updated_at]': '$order_by_updated_at',
      'order[id]': '$order_by_id',
    });
    expect(tool('kommo_list_notes').endpointMapping.path).toBe('/{entity_type}/{entity_id}/notes');
  });

  it('sends amocrm.ru accounts to the amoCRM connector', () => {
    expect(a.instructions).toContain('.amocrm.ru');
    expect(a.instructions).toContain('**amoCRM** connector');
  });

  it('documents setup, rate limit, closed stages and the read-only setup', () => {
    expect(a.instructions).toContain('Settings → Integrations');
    expect(a.instructions).toContain('Generate long-lived token');
    expect(a.instructions).toContain('7 requests per second');
    expect(a.instructions).toMatch(/142 is Closed-won and 143 Closed-lost/);
    expect(a.instructions).toContain('Read-only setup');
    expect(JSON.stringify(adapterJson)).not.toContain('—');
  });
});

describe('kommo adapter: requests through the real engine', () => {
  let server: http.Server;
  let origin: string;
  const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.setHeader('Content-Type', 'application/hal+json');
        res.end(JSON.stringify({ _embedded: { leads: [{ id: 1 }] } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => (seen.length = 0));

  const run = (name: string, params: Record<string, unknown>) =>
    engine().execute(
      { baseUrl: `${origin}/api/v4`, authType: 'BEARER_TOKEN', authConfig: { token: 'tok' }, headers: a.connector.headers },
      tool(name).endpointMapping,
      params,
    );

  it('serializes lead filters in the bracket form Kommo reads, arrays as repeated keys', async () => {
    await run('kommo_list_leads', { query: 'acme', pipeline_id: 7, status_pipeline_id: 7, status_id: 70, responsible_user_ids: [1, 2], ids: [5], limit: 50 });
    const url = new URL(seen[0].url!, origin);
    expect(url.pathname).toBe('/api/v4/leads');
    expect(seen[0].headers.authorization).toBe('Bearer tok');
    expect(url.searchParams.get('query')).toBe('acme');
    expect(url.searchParams.getAll('filter[pipeline_id][]')).toEqual(['7']);
    expect(url.searchParams.get('filter[statuses][0][pipeline_id]')).toBe('7');
    expect(url.searchParams.get('filter[statuses][0][status_id]')).toBe('70');
    expect(url.searchParams.getAll('filter[responsible_user_id][]')).toEqual(['1', '2']);
    expect(url.searchParams.getAll('filter[id][]')).toEqual(['5']);
    expect(url.searchParams.get('limit')).toBe('50');
  });

  it('creates a lead as a one-element array with linked contacts', async () => {
    await run('kommo_create_lead', { name: 'AnythingMCP test', price: 100, contact_ids: [{ id: 3 }] });
    expect(seen[0].method).toBe('POST');
    expect(JSON.parse(seen[0].body)).toEqual([{ name: 'AnythingMCP test', price: 100, _embedded: { contacts: [{ id: 3 }] } }]);
  });

  it('adds a common note to the entity type in the path', async () => {
    await run('kommo_add_note', { entity_type: 'leads', entity_id: 9, text: 'Called back' });
    expect(seen[0].url).toBe('/api/v4/leads/notes');
    expect(JSON.parse(seen[0].body)).toEqual([{ entity_id: 9, note_type: 'common', params: { text: 'Called back' } }]);
  });

  it('lists events with repeated array filters and a created_at range', async () => {
    await run('kommo_list_events', { types: ['lead_status_changed', 'lead_added'], entity: ['lead'], entity_ids: [9], created_from: 1700000000, limit: 100 });
    const url = new URL(seen[0].url!, origin);
    expect(url.pathname).toBe('/api/v4/events');
    expect(url.searchParams.getAll('filter[type][]')).toEqual(['lead_status_changed', 'lead_added']);
    expect(url.searchParams.getAll('filter[entity][]')).toEqual(['lead']);
    expect(url.searchParams.getAll('filter[entity_id][]')).toEqual(['9']);
    expect(url.searchParams.get('filter[created_at][from]')).toBe('1700000000');
    expect(url.searchParams.has('filter[created_at][to]')).toBe(false);
    expect(url.searchParams.get('limit')).toBe('100');
  });

  it('lists the notes of all leads, filtered by type and update time', async () => {
    await run('kommo_list_notes_by_type', { entity_type: 'leads', note_types: ['call_in', 'call_out'], updated_from: 1700000000 });
    const url = new URL(seen[0].url!, origin);
    expect(url.pathname).toBe('/api/v4/leads/notes');
    expect(url.searchParams.getAll('filter[note_type][]')).toEqual(['call_in', 'call_out']);
    expect(url.searchParams.get('filter[updated_at][from]')).toBe('1700000000');
    expect(url.searchParams.has('filter[entity_id][]')).toBe(false);
  });

  it('updates one lead with a PATCH object', async () => {
    await run('kommo_update_lead', { lead_id: 9, status_id: 143 });
    expect(seen[0].method).toBe('PATCH');
    expect(seen[0].url).toBe('/api/v4/leads/9');
    expect(JSON.parse(seen[0].body)).toEqual({ status_id: 143 });
  });
});

const SUBDOMAIN = process.env.KOMMO_SUBDOMAIN;
const TOKEN = process.env.KOMMO_ACCESS_TOKEN;
const live = SUBDOMAIN && TOKEN ? describe : describe.skip;

live('kommo adapter: live calls', () => {
  const config = () => ({
    baseUrl: interpolateDeep(a.connector.baseUrl, { KOMMO_SUBDOMAIN: SUBDOMAIN as string }),
    authType: 'BEARER_TOKEN',
    authConfig: { token: TOKEN as string },
    headers: a.connector.headers,
  });
  const run = (name: string, params: Record<string, unknown> = {}, mapping?: Mapping): Promise<any> =>
    engine().execute(config(), mapping ?? tool(name).endpointMapping, params);

  it('reads the account (the probe), users and pipelines', async () => {
    const account = await run('kommo_get_account', { with: 'task_types' });
    expect(account.subdomain).toBe(SUBDOMAIN);
    const users = await run('kommo_list_users', { limit: 5 });
    expect(Array.isArray(users._embedded.users)).toBe(true);
    const pipelines = await run('kommo_list_pipelines');
    expect(Array.isArray(pipelines._embedded.pipelines)).toBe(true);
  }, 30000);

  it('lists leads, contacts, companies, custom fields and tasks', async () => {
    // An empty list is HTTP 204 with no body.
    const leads = await run('kommo_list_leads', { limit: 2, with: 'contacts' });
    const leadId = leads?._embedded?.leads?.[0]?.id;
    if (leadId) expect((await run('kommo_get_lead', { lead_id: leadId })).id).toBe(leadId);
    const contacts = await run('kommo_list_contacts', { limit: 2 });
    const contactId = contacts?._embedded?.contacts?.[0]?.id;
    if (contactId) expect((await run('kommo_get_contact', { contact_id: contactId })).id).toBe(contactId);
    await run('kommo_list_companies', { limit: 2 });
    const fields = await run('kommo_list_custom_fields', { entity_type: 'contacts' });
    expect(Array.isArray(fields._embedded.custom_fields)).toBe(true);
    await run('kommo_list_tasks', { limit: 2, is_completed: 0 });
  }, 60000);

  it('reads notes across all leads and the event log', async () => {
    // Either may be empty (HTTP 204) on a fresh account.
    const notes = await run('kommo_list_notes_by_type', { entity_type: 'leads', limit: 5 });
    if (notes) expect(Array.isArray(notes._embedded.notes)).toBe(true);
    const events = await run('kommo_list_events', { limit: 5, entity: ['lead'] });
    if (events) expect(Array.isArray(events._embedded.events)).toBe(true);
  }, 30000);

  (process.env.KOMMO_LIVE_WRITE === '1' ? it : it.skip)(
    'creates an "AnythingMCP test" lead with a note and a task, then closes both',
    async () => {
      let leadId: number | undefined;
      let taskId: number | undefined;
      try {
        const created = await run('kommo_create_lead', { name: 'AnythingMCP test', price: 1, tags: [{ name: 'anythingmcp-test' }] });
        leadId = created._embedded.leads[0].id;
        await run('kommo_add_note', { entity_type: 'leads', entity_id: leadId, text: 'AnythingMCP test note' });
        const notes = await run('kommo_list_notes', { entity_type: 'leads', entity_id: leadId });
        expect(JSON.stringify(notes)).toContain('AnythingMCP test note');
        const task = await run('kommo_create_task', {
          text: 'AnythingMCP test task',
          complete_till: Math.floor(Date.now() / 1000) + 86400,
          entity_type: 'leads',
          entity_id: leadId,
        });
        taskId = task._embedded.tasks[0].id;
        const renamed = await run('kommo_update_lead', { lead_id: leadId, name: 'AnythingMCP test (updated)' });
        expect(renamed.id).toBe(leadId);
      } finally {
        if (taskId) {
          await run('', {}, { method: 'PATCH', path: `/tasks/${taskId}`, bodyMapping: { is_completed: true, result: { text: 'AnythingMCP test cleanup' } } }).catch(() => undefined);
        }
        if (leadId) await run('kommo_update_lead', { lead_id: leadId, status_id: 143 });
      }
    },
    60000,
  );
});
