import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as adapterJson from './hubspot.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Static checks and request-shape checks against a local server always run.
 * The live block runs read-only calls through the real RestEngine when a key
 * is set:
 *   HUBSPOT_ACCESS_TOKEN=pat-eu1-... npx jest src/adapters/intl/hubspot.live.spec.ts
 * HUBSPOT_LIVE_WRITE=1 also creates a contact named "AnythingMCP test" with a
 * note and a task, updates it, and archives all three at the end.
 */

type Mapping = {
  method: string;
  path: string;
  queryParams?: Record<string, string>;
  bodyMapping?: Record<string, unknown>;
  encodePathParams?: boolean;
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  annotations?: Record<string, boolean>;
  parameters: { properties?: Record<string, { default?: unknown }>; required?: string[] };
  endpointMapping: Mapping;
};
const a = adapterJson as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern: string; secret?: boolean }>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
const WRITES = [
  'hubspot_archive_object',
  'hubspot_associate_records',
  'hubspot_create_note',
  'hubspot_create_object',
  'hubspot_create_task',
  'hubspot_update_object',
];

describe('hubspot adapter: static spec conformance', () => {
  it('is unlisted until verified against a real account', () => {
    expect(a.unlisted).toBe(true);
  });

  it('sends the service key as a Bearer token to api.hubapi.com', () => {
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://api.hubapi.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{HUBSPOT_ACCESS_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['HUBSPOT_ACCESS_TOKEN']);
    expect(a.envVarMeta.HUBSPOT_ACCESS_TOKEN.secret).toBe(true);
    const pattern = new RegExp(a.envVarMeta.HUBSPOT_ACCESS_TOKEN.pattern);
    // Built at runtime so secret scanners do not take the sample for a real key.
    expect(pattern.test(['pat', 'eu1', 'x'.repeat(8), 'y'.repeat(4)].join('-'))).toBe(true);
    expect(pattern.test('Bearer pat-eu1-123')).toBe(false);
  });

  it('probes with one owner, a cheap read', () => {
    expect(a.probe).toEqual({ tool: 'hubspot_list_owners', params: { limit: 1 } });
    expect(tool('hubspot_list_owners').endpointMapping).toMatchObject({ method: 'GET', path: '/crm/owners/2026-09' });
  });

  it('uses the 2026-09 date-versioned paths everywhere', () => {
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.path}`).toMatch(/:\/[a-z-]+\/(?:[a-z]+\/)?2026-09(\/|$)/);
  });

  it('prefixes every tool and keeps writes to the expected set', () => {
    for (const t of a.tools) expect(t.name.startsWith('hubspot_')).toBe(true);
    const writes = a.tools
      .filter((t) => t.endpointMapping.method !== 'GET' && !t.annotations?.readOnlyHint)
      .map((t) => t.name)
      .sort();
    expect(writes).toEqual(WRITES);
    for (const name of WRITES.filter((n) => n !== 'hubspot_archive_object')) {
      expect(tool(name).description).toMatch(/confirm/i);
    }
  });

  it('marks the POST-based reads read-only', () => {
    expect(tool('hubspot_search_objects').annotations).toEqual({ readOnlyHint: true });
    expect(tool('hubspot_get_associations').annotations).toEqual({ readOnlyHint: true });
  });

  it('installs only the archive tool switched off', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['hubspot_archive_object']);
    expect(tool('hubspot_archive_object').endpointMapping.method).toBe('DELETE');
    expect(a.tools.filter((t) => t.endpointMapping.method === 'DELETE')).toHaveLength(1);
  });

  it('pages with after and caps limits at the documented maxima', () => {
    const caps: Record<string, number> = { hubspot_search_objects: 200, hubspot_list_objects: 100, hubspot_list_owners: 500 };
    for (const [name, max] of Object.entries(caps)) {
      const props = tool(name).parameters.properties as Record<string, { maximum?: number }>;
      expect(props.limit.maximum).toBe(max);
      expect(props.after).toBeDefined();
    }
    expect(a.instructions).toContain('paging.next.after');
  });

  it('documents scopes, the read-only setup and the association type ids', () => {
    for (const scope of ['crm.objects.contacts.read', 'crm.objects.owners.read', 'crm.objects.deals.write', 'crm.objects.tickets.read']) {
      expect(a.instructions).toContain(scope);
    }
    expect(a.instructions).toContain('Read-only setup');
    expect(a.instructions).toMatch(/note to contact 202/);
    expect(a.instructions).toMatch(/Development.*Keys → Service keys/);
  });

  it('has no em dash in anything a user or model reads', () => {
    expect(JSON.stringify(adapterJson)).not.toContain('—');
  });
});

describe('hubspot adapter: requests through the real engine', () => {
  let server: http.Server;
  let origin: string;
  const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ results: [], id: '1' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => (seen.length = 0));

  const run = (name: string, params: Record<string, unknown>) =>
    engine().execute(
      { baseUrl: origin, authType: 'BEARER_TOKEN', authConfig: { token: 'pat-eu1-test' }, headers: a.connector.headers },
      tool(name).endpointMapping,
      params,
    );

  it('search posts filter groups, properties, sorts and paging as JSON', async () => {
    await run('hubspot_search_objects', {
      object_type: 'deals',
      filter_groups: [{ filters: [{ propertyName: 'dealstage', operator: 'EQ', value: 'closedwon' }] }],
      properties: ['dealname', 'amount'],
      sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      limit: 50,
      after: '50',
    });
    const [req] = seen;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/crm/objects/2026-09/deals/search');
    expect(req.headers.authorization).toBe('Bearer pat-eu1-test');
    expect(req.headers['user-agent']).toBe('AnythingMCP');
    expect(JSON.parse(req.body)).toEqual({
      filterGroups: [{ filters: [{ propertyName: 'dealstage', operator: 'EQ', value: 'closedwon' }] }],
      properties: ['dealname', 'amount'],
      sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      limit: 50,
      after: '50',
    });
  });

  it('reads a contact by email with idProperty, percent-encoding the id', async () => {
    await run('hubspot_get_object', { object_type: 'contacts', object_id: 'ana@example.com', id_property: 'email', associations: 'companies' });
    expect(seen[0].url).toBe('/crm/objects/2026-09/contacts/ana%40example.com?idProperty=email&associations=companies');
  });

  it('creates a note with its timestamp and an association', async () => {
    const associations = [{ to: { id: '51' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }];
    await run('hubspot_create_note', { body: 'Called, wants an offer', timestamp: '2026-10-10T09:30:00Z', associations });
    expect(seen[0].url).toBe('/crm/objects/2026-09/notes');
    expect(JSON.parse(seen[0].body)).toEqual({
      properties: { hs_note_body: 'Called, wants an offer', hs_timestamp: '2026-10-10T09:30:00Z' },
      associations,
    });
  });

  it('reads associations with a batch input of one id', async () => {
    await run('hubspot_get_associations', { from_object_type: 'companies', object_id: '9', to_object_type: 'deals' });
    expect(seen[0].url).toBe('/crm/associations/2026-09/companies/deals/batch/read');
    expect(JSON.parse(seen[0].body)).toEqual({ inputs: [{ id: '9' }] });
  });

  it('links two records with the default association and no body', async () => {
    await run('hubspot_associate_records', { from_object_type: 'contacts', from_object_id: '1', to_object_type: 'companies', to_object_id: '2' });
    expect(seen[0].method).toBe('PUT');
    expect(seen[0].url).toBe('/crm/objects/2026-09/contacts/1/associations/default/companies/2');
  });
});

const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('hubspot adapter: live calls', () => {
  const run = (name: string, params: Record<string, unknown> = {}, mapping?: Mapping): Promise<any> =>
    engine().execute(
      { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: TOKEN as string }, headers: a.connector.headers },
      mapping ?? tool(name).endpointMapping,
      params,
    );

  it('lists owners (the probe) and reads the account', async () => {
    const owners = await run('hubspot_list_owners', { limit: 1 });
    expect(Array.isArray(owners.results)).toBe(true);
    const account = await run('hubspot_get_account');
    expect(account.portalId).toBeTruthy();
  }, 30000);

  it('lists and searches contacts and reads one with associations', async () => {
    const list = await run('hubspot_list_objects', { object_type: 'contacts', limit: 2, properties: 'email,firstname' });
    expect(Array.isArray(list.results)).toBe(true);
    const search = await run('hubspot_search_objects', {
      object_type: 'contacts',
      limit: 2,
      sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
    });
    expect(typeof search.total).toBe('number');
    const id = list.results[0]?.id;
    if (!id) return;
    const one = await run('hubspot_get_object', { object_type: 'contacts', object_id: id, associations: 'companies' });
    expect(one.id).toBe(id);
  }, 30000);

  it('lists deal pipelines and contact properties', async () => {
    const pipelines = await run('hubspot_list_pipelines', { object_type: 'deals' });
    expect(Array.isArray(pipelines.results)).toBe(true);
    const props = await run('hubspot_list_properties', { object_type: 'contacts', properties: 'email,lifecyclestage' });
    expect(props.results.map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining(['email']));
  }, 30000);

  (process.env.HUBSPOT_LIVE_WRITE === '1' ? it : it.skip)(
    'creates, updates and archives an "AnythingMCP test" contact with a note and a task',
    async () => {
      const archive = (type: string, id: string) =>
        run('hubspot_archive_object', { object_type: type, object_id: id });
      const created: Array<[string, string]> = [];
      try {
        const contact = await run('hubspot_create_object', {
          object_type: 'contacts',
          properties: { firstname: 'AnythingMCP', lastname: 'test', email: `anythingmcp-test-${Date.now()}@example.com` },
        });
        created.push(['contacts', contact.id]);
        const updated = await run('hubspot_update_object', { object_type: 'contacts', object_id: contact.id, properties: { jobtitle: 'AnythingMCP test' } });
        expect(updated.properties.jobtitle).toBe('AnythingMCP test');
        const to = [{ to: { id: contact.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }];
        const note = await run('hubspot_create_note', { body: 'AnythingMCP test note', timestamp: new Date().toISOString(), associations: to });
        created.push(['notes', note.id]);
        const task = await run('hubspot_create_task', {
          subject: 'AnythingMCP test task',
          due: new Date(Date.now() + 86400000).toISOString(),
          associations: [{ to: { id: contact.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 }] }],
        });
        created.push(['tasks', task.id]);
        const assoc = await run('hubspot_get_associations', { from_object_type: 'contacts', object_id: contact.id, to_object_type: 'notes' });
        expect(JSON.stringify(assoc)).toContain(String(note.id));
      } finally {
        for (const [type, id] of created.reverse()) await archive(type, id).catch(() => undefined);
      }
    },
    60000,
  );
});
