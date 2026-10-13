import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as adapterJson from './amocrm.json';
import * as kommoJson from './kommo.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { normalizeSubdomainVariable } from '../../common/base-url-variable.util';

/**
 * amoCRM is the amocrm.ru edition of the product Kommo sells internationally:
 * the same API v4 on another domain. Static checks and request-shape checks
 * against a local server always run. The live block runs read-only calls
 * through the real RestEngine with a long-lived token (7 requests per second
 * per integration):
 *   RUN_AMOCRM_LIVE=1 AMOCRM_SUBDOMAIN=acme AMOCRM_ACCESS_TOKEN=eyJ... \
 *     npx jest src/adapters/intl/amocrm.live.spec.ts
 */

type Mapping = {
  method: string;
  path: string;
  queryParams?: Record<string, unknown>;
  // An array for the create tools: amoCRM takes a list of entities.
  bodyMapping?: Record<string, unknown>;
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { default?: unknown; maximum?: number }>; required?: string[] };
  endpointMapping: Mapping;
};
type Adapter = {
  slug: string;
  name: string;
  aliases?: string[];
  unlisted?: boolean;
  icon: string;
  region: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind: string; secret?: boolean }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  tools: Tool[];
};
const a = adapterJson as unknown as Adapter;
const kommo = kommoJson as unknown as Adapter;
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
const WRITES = ['amocrm_add_note', 'amocrm_create_contact', 'amocrm_create_lead', 'amocrm_create_task', 'amocrm_update_lead'];

describe('amocrm adapter: static spec conformance', () => {
  it('is unlisted until verified against a live account', () => {
    expect(a.unlisted).toBe(true);
    expect(a.slug).toBe('amocrm');
    expect(a.name).toBe('amoCRM');
    expect(a.region).toBe('intl');
    expect(a.icon).toBe('amocrm');
    expect(a.aliases).toEqual(expect.arrayContaining(['amo', 'amo CRM', 'амоЦРМ']));
  });

  it('calls API v4 on the amocrm.ru subdomain with the long-lived token as Bearer', () => {
    expect(a.connector.baseUrl).toBe('https://{{AMOCRM_SUBDOMAIN}}.amocrm.ru/api/v4');
    expect(interpolateDeep(a.connector.baseUrl, { AMOCRM_SUBDOMAIN: 'acme' })).toBe('https://acme.amocrm.ru/api/v4');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{AMOCRM_ACCESS_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['AMOCRM_SUBDOMAIN', 'AMOCRM_ACCESS_TOKEN']);
    expect(a.envVarMeta.AMOCRM_SUBDOMAIN.kind).toBe('address');
    expect(a.envVarMeta.AMOCRM_ACCESS_TOKEN.secret).toBe(true);
  });

  it('shortens a pasted account address to the subdomain and refuses a kommo.com one', () => {
    expect(normalizeSubdomainVariable('AMOCRM_SUBDOMAIN', 'https://acme.amocrm.ru/leads/', '.amocrm.ru', { singleLabel: true })).toBe('acme');
    expect(() => normalizeSubdomainVariable('AMOCRM_SUBDOMAIN', 'acme.kommo.com', '.amocrm.ru', { singleLabel: true })).toThrow(/AMOCRM_SUBDOMAIN/);
  });

  it('offers the same tools as the Kommo adapter, under the amocrm_ prefix', () => {
    expect(a.tools.map((t) => t.name)).toEqual(kommo.tools.map((t) => t.name.replace(/^kommo_/, 'amocrm_')));
    for (const t of a.tools) {
      const twin = kommo.tools.find((k) => k.name === t.name.replace(/^amocrm_/, 'kommo_'))!;
      expect(t.endpointMapping).toEqual(twin.endpointMapping);
      expect(Object.keys(t.parameters.properties ?? {})).toEqual(Object.keys(twin.parameters.properties ?? {}));
    }
    expect(JSON.stringify(a.tools)).not.toMatch(/kommo/i);
  });

  it('probes with the account, which needs no argument', () => {
    expect(a.probe.tool).toBe('amocrm_get_account');
    expect(tool('amocrm_get_account').endpointMapping).toMatchObject({ method: 'GET', path: '/account' });
  });

  it('writes only through the expected tools and never deletes', () => {
    const writes = a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of WRITES) expect(tool(name).description).toMatch(/confirm/i);
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
    expect(a.tools.filter((t) => t.enabled === false)).toEqual([]);
  });

  it('pages lists with page and limit up to 250 (100 for the event log)', () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'GET' && x.parameters.properties?.limit)) {
      expect(t.parameters.properties!.limit.maximum).toBe(t.name === 'amocrm_list_events' ? 100 : 250);
      expect(t.endpointMapping.queryParams).toMatchObject({ page: '$page', limit: '$limit' });
    }
    expect(a.instructions).toMatch(/HTTP 204/);
  });

  it('reads the event log and the notes of a whole entity type', () => {
    expect(tool('amocrm_list_events').endpointMapping).toMatchObject({ method: 'GET', path: '/events' });
    expect(tool('amocrm_list_notes_by_type').endpointMapping).toMatchObject({ method: 'GET', path: '/{entity_type}/notes' });
    expect(tool('amocrm_list_notes_by_type').parameters.required).toEqual(['entity_type']);
    expect(tool('amocrm_list_notes').endpointMapping.path).toBe('/{entity_type}/{entity_id}/notes');
  });

  it('documents the amoCRM setup, rate limits, errors and the Kommo split', () => {
    for (const label of ['амоМаркет', 'Создать интеграцию', 'Ключи и доступы', 'Сгенерировать токен', 'Отозвать доступ']) {
      expect(a.instructions).toContain(label);
    }
    expect(a.instructions).toContain('7 requests per second per integration and 50 per account');
    expect(a.instructions).toMatch(/142 is Closed-won/);
    expect(a.instructions).toContain('Read-only setup');
    expect(a.instructions).toContain('**Kommo** connector');
    expect(a.instructions).not.toContain('kommo_');
    expect(JSON.stringify(adapterJson)).not.toContain('—');
  });
});

describe('amocrm adapter: requests through the real engine', () => {
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
        res.end(JSON.stringify({ _embedded: { events: [{ id: '01pz58t6p04ymgsgfbmfyfy1mf' }] } }));
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

  it('lists events with repeated array filters and a created_at range', async () => {
    await run('amocrm_list_events', {
      types: ['lead_status_changed'],
      entity: ['lead'],
      entity_ids: [648533],
      created_by: [956328, 504141],
      created_from: 1700000000,
      created_to: 1700086400,
      with: 'lead_name',
    });
    const url = new URL(seen[0].url!, origin);
    expect(url.pathname).toBe('/api/v4/events');
    expect(seen[0].headers.authorization).toBe('Bearer tok');
    expect(url.searchParams.getAll('filter[type][]')).toEqual(['lead_status_changed']);
    expect(url.searchParams.getAll('filter[entity][]')).toEqual(['lead']);
    expect(url.searchParams.getAll('filter[entity_id][]')).toEqual(['648533']);
    expect(url.searchParams.getAll('filter[created_by][]')).toEqual(['956328', '504141']);
    expect(url.searchParams.get('filter[created_at][from]')).toBe('1700000000');
    expect(url.searchParams.get('filter[created_at][to]')).toBe('1700086400');
    expect(url.searchParams.get('with')).toBe('lead_name');
  });

  it('lists the notes of all leads, filtered by record, type and update time', async () => {
    await run('amocrm_list_notes_by_type', {
      entity_type: 'leads',
      entity_ids: [1, 2],
      note_types: ['common'],
      updated_from: 1700000000,
      order_by_updated_at: 'desc',
      limit: 250,
    });
    const url = new URL(seen[0].url!, origin);
    expect(url.pathname).toBe('/api/v4/leads/notes');
    expect(url.searchParams.getAll('filter[entity_id][]')).toEqual(['1', '2']);
    expect(url.searchParams.getAll('filter[note_type][]')).toEqual(['common']);
    expect(url.searchParams.get('filter[updated_at][from]')).toBe('1700000000');
    expect(url.searchParams.get('order[updated_at]')).toBe('desc');
    expect(url.searchParams.get('limit')).toBe('250');
  });

  it('serializes lead filters in the bracket form amoCRM reads', async () => {
    await run('amocrm_list_leads', { query: 'acme', status_pipeline_id: 7, status_id: 70, responsible_user_ids: [1, 2] });
    const url = new URL(seen[0].url!, origin);
    expect(url.pathname).toBe('/api/v4/leads');
    expect(url.searchParams.get('filter[statuses][0][pipeline_id]')).toBe('7');
    expect(url.searchParams.get('filter[statuses][0][status_id]')).toBe('70');
    expect(url.searchParams.getAll('filter[responsible_user_id][]')).toEqual(['1', '2']);
  });

  it('adds a common note as a one-element array', async () => {
    await run('amocrm_add_note', { entity_type: 'contacts', entity_id: 9, text: 'Called back' });
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/api/v4/contacts/notes');
    expect(JSON.parse(seen[0].body)).toEqual([{ entity_id: 9, note_type: 'common', params: { text: 'Called back' } }]);
  });
});

const SUBDOMAIN = process.env.AMOCRM_SUBDOMAIN;
const TOKEN = process.env.AMOCRM_ACCESS_TOKEN;
const live = process.env.RUN_AMOCRM_LIVE === '1' && SUBDOMAIN && TOKEN ? describe : describe.skip;

live('amocrm adapter: live calls (read-only)', () => {
  const config = () => ({
    baseUrl: interpolateDeep(a.connector.baseUrl, { AMOCRM_SUBDOMAIN: SUBDOMAIN as string }),
    authType: 'BEARER_TOKEN',
    authConfig: { token: TOKEN as string },
    headers: a.connector.headers,
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    engine().execute(config(), tool(name).endpointMapping, params);

  it('reads the account (the probe), users and pipelines', async () => {
    const account = await run('amocrm_get_account', { with: 'task_types' });
    expect(account.subdomain).toBe(SUBDOMAIN);
    const users = await run('amocrm_list_users', { limit: 5 });
    expect(Array.isArray(users._embedded.users)).toBe(true);
    const pipelines = await run('amocrm_list_pipelines');
    expect(Array.isArray(pipelines._embedded.pipelines)).toBe(true);
  }, 30000);

  it('lists leads, contacts and lead custom fields', async () => {
    // An empty list is HTTP 204 with no body.
    const leads = await run('amocrm_list_leads', { limit: 2, with: 'contacts' });
    const leadId = leads?._embedded?.leads?.[0]?.id;
    if (leadId) expect((await run('amocrm_get_lead', { lead_id: leadId })).id).toBe(leadId);
    await run('amocrm_list_contacts', { limit: 2 });
    const fields = await run('amocrm_list_custom_fields', { entity_type: 'leads' });
    expect(Array.isArray(fields._embedded.custom_fields)).toBe(true);
  }, 60000);

  it('reads notes across all leads and the event log', async () => {
    const notes = await run('amocrm_list_notes_by_type', { entity_type: 'leads', limit: 5 });
    if (notes) expect(Array.isArray(notes._embedded.notes)).toBe(true);
    const events = await run('amocrm_list_events', { limit: 5 });
    if (events) expect(Array.isArray(events._embedded.events)).toBe(true);
  }, 30000);
});
