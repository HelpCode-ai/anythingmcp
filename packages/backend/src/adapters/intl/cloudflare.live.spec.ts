import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as adapterJson from './cloudflare.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { assertNoResponseBodyError, describeErrorWhenProblems, ResponseBodyError } from '../../connectors/engines/response-error.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Static checks and request-shape checks against a local server always run.
 * The live block runs every read tool through the real RestEngine:
 *   CLOUDFLARE_API_TOKEN=... [CLOUDFLARE_ZONE_ID=...] [CLOUDFLARE_ACCOUNT_ID=...] \
 *     npx jest src/adapters/intl/cloudflare.live.spec.ts
 * Without CLOUDFLARE_ZONE_ID the first zone the token sees is read, and its
 * account unless CLOUDFLARE_ACCOUNT_ID is set. CLOUDFLARE_LIVE_WRITE=1 (needs
 * CLOUDFLARE_ZONE_ID and DNS Edit + Cache Purge) also creates a TXT record
 * anythingmcp-test-<time>.<zone>, changes it, purges one URL of the zone from
 * the cache, and deletes the record in `finally`.
 */

type Mapping = { method: string; path: string; encodePathParams?: boolean; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
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
  envVarMeta: Record<string, { kind: string; secret?: boolean; pattern?: string }>;
  probe: { tool: string; params: Record<string, unknown> };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath: string; config: { errorWhen: unknown } };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
const rules = a.connector.config.errorWhen;
const statusOf = (body: unknown): number | null => {
  try {
    assertNoResponseBodyError(body, rules);
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(ResponseBodyError);
    return (e as ResponseBodyError).status;
  }
};
const OFF = ['cloudflare_delete_dns_record', 'cloudflare_purge_everything'];
const WRITES = [...OFF, 'cloudflare_create_dns_record', 'cloudflare_purge_cache', 'cloudflare_update_dns_record'].sort();

describe('cloudflare adapter: static spec conformance', () => {
  it('is unlisted until verified against a real account', () => {
    expect(a.unlisted).toBe(true);
  });

  it('calls API v4 with the API token as Bearer', () => {
    expect(a.connector.baseUrl).toBe('https://api.cloudflare.com/client/v4');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{CLOUDFLARE_API_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['CLOUDFLARE_API_TOKEN']);
    expect(a.envVarMeta.CLOUDFLARE_API_TOKEN.secret).toBe(true);
    const token = new RegExp(a.envVarMeta.CLOUDFLARE_API_TOKEN.pattern!);
    expect(token.test('Xy3_abcdefghijklmnopqrstuvwxyz0123456789AB')).toBe(true);
    expect(token.test('cfut_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF')).toBe(true);
    // A Global API Key is 37 hex characters and is sent differently.
    expect(token.test('0123456789abcdef0123456789abcdef01234')).toBe(false);
  });

  it('probes by listing zones, which a token with Zone Read can always do', () => {
    expect(a.probe).toEqual({ tool: 'cloudflare_list_zones', params: { per_page: 5 } });
    expect(tool('cloudflare_list_zones').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/zones?per_page=5');
  });

  it('prefixes every tool with cloudflare_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^cloudflare_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads and both GraphQL tools read-only, and installs deletion and full purge switched off', () => {
    const writes = a.tools.filter((t) => !annotationsOf(t).readOnlyHint).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    for (const name of ['cloudflare_get_zone_traffic', 'cloudflare_graphql_analytics']) {
      expect(tool(name).endpointMapping).toMatchObject({ method: 'POST', path: '/graphql' });
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(OFF);
    for (const name of [...OFF, 'cloudflare_update_dns_record', 'cloudflare_purge_cache']) expect(annotationsOf(tool(name)).destructiveHint).toBe(true);
    expect(annotationsOf(tool('cloudflare_create_dns_record')).destructiveHint).toBe(false);
    for (const name of ['cloudflare_create_dns_record', 'cloudflare_update_dns_record']) expect(tool(name).description).toMatch(/confirm/i);
  });

  it('turns GraphQL and envelope errors in a 200 answer into failures', () => {
    expect(describeErrorWhenProblems(rules)).toEqual([]);
    expect(statusOf({ success: true, errors: [], messages: [], result: [] })).toBeNull();
    expect(statusOf({ data: { viewer: { zones: [] } }, errors: null })).toBeNull();
    expect(statusOf({ data: null, errors: [{ message: 'zone \'abc\' does not have access to the path', path: ['viewer'] }] })).toBe(400);
    expect(statusOf({ data: null, errors: [{ message: 'not authorized for that account' }] })).toBe(403);
    expect(statusOf({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] })).toBe(403);
  });

  it('declares GraphQL variables that match the traffic query', () => {
    const m = tool('cloudflare_get_zone_traffic').endpointMapping.bodyMapping as { query: string; variables: Record<string, string> };
    for (const v of Object.keys(m.variables)) expect(m.query).toContain(`$${v}:`);
    expect(m.query).toContain('httpRequests1dGroups');
  });

  it('only points the model at tools that exist, documents setup and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bcloudflare_[a-z0-9_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bcloudflare_[a-z0-9_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions).toContain('https://dash.cloudflare.com/profile/api-tokens');
    expect(a.instructions).toContain('Read-only setup');
    expect(a.instructions).toContain('1,200 requests per 5 minutes');
    expect(JSON.stringify(adapterJson)).not.toMatch(/[–—]/);
  });
});

describe('cloudflare adapter: requests through the real engine', () => {
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
        res.end(JSON.stringify({ success: true, errors: [], messages: [], result: [] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => (seen.length = 0));

  const run = (name: string, params: Record<string, unknown>) =>
    engine().execute(
      { baseUrl: `${origin}/client/v4`, authType: 'BEARER_TOKEN', authConfig: { token: 'cf-test' }, headers: a.connector.headers, errorWhen: rules } as never,
      tool(name).endpointMapping,
      applySchemaDefaults(tool(name).parameters, params),
    );

  it('filters zones by account with the dotted parameter name', async () => {
    await run('cloudflare_list_zones', { name: 'example.com', account_id: 'acc1' });
    const url = new URL(seen[0].url!, origin);
    expect(url.pathname).toBe('/client/v4/zones');
    expect(url.searchParams.get('account.id')).toBe('acc1');
    expect(url.searchParams.get('name')).toBe('example.com');
    expect(seen[0].headers.authorization).toBe('Bearer cf-test');
  });

  it('maps DNS filters to the operator parameters and pages 100 at a time', async () => {
    await run('cloudflare_list_dns_records', { zone_id: 'z1', type: 'MX', name: 'example.com', content_contains: 'google' });
    const url = new URL(seen[0].url!, origin);
    expect(url.pathname).toBe('/client/v4/zones/z1/dns_records');
    expect(url.searchParams.get('type')).toBe('MX');
    expect(url.searchParams.get('name.exact')).toBe('example.com');
    expect(url.searchParams.get('content.contains')).toBe('google');
    expect(url.searchParams.get('per_page')).toBe('100');
  });

  it('creates a record with only the given fields and patches one', async () => {
    await run('cloudflare_create_dns_record', { zone_id: 'z1', type: 'A', name: 'www.example.com', content: '192.0.2.1', proxied: true, ttl: 1 });
    expect(seen[0].method).toBe('POST');
    expect(JSON.parse(seen[0].body)).toEqual({ type: 'A', name: 'www.example.com', content: '192.0.2.1', ttl: 1, proxied: true });
    await run('cloudflare_update_dns_record', { zone_id: 'z1', dns_record_id: 'r1', proxied: false });
    expect(seen[1].method).toBe('PATCH');
    expect(seen[1].url).toBe('/client/v4/zones/z1/dns_records/r1');
    expect(JSON.parse(seen[1].body)).toEqual({ proxied: false });
  });

  it('purges by URL, or everything with the one-field body', async () => {
    await run('cloudflare_purge_cache', { zone_id: 'z1', files: ['https://www.example.com/a.css'] });
    expect(JSON.parse(seen[0].body)).toEqual({ files: ['https://www.example.com/a.css'] });
    await run('cloudflare_purge_everything', { zone_id: 'z1' });
    expect(JSON.parse(seen[1].body)).toEqual({ purge_everything: true });
  });

  it('asks GraphQL for daily traffic with the zone and dates as variables', async () => {
    await run('cloudflare_get_zone_traffic', { zone_id: 'z1', since: '2026-10-01', until: '2026-10-07' });
    expect(seen[0].url).toBe('/client/v4/graphql');
    const sent = JSON.parse(seen[0].body);
    expect(sent.variables).toEqual({ zoneTag: 'z1', start: '2026-10-01', end: '2026-10-07', limit: 31 });
  });

  it('reads a phase entry point', async () => {
    await run('cloudflare_get_phase_rules', { zone_id: 'z1', phase: 'http_request_dynamic_redirect' });
    expect(seen[0].url).toBe('/client/v4/zones/z1/rulesets/phases/http_request_dynamic_redirect/entrypoint');
  });
});

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('cloudflare adapter: live calls', () => {
  const config = () => ({ baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: TOKEN as string }, headers: a.connector.headers, errorWhen: rules });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    engine().execute(config() as never, tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params));
  const status = (e: any) => e?.response?.status ?? e?.status;

  let zone: { id: string; name: string; account: { id: string } } | undefined;
  let accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  beforeAll(async () => {
    zone = process.env.CLOUDFLARE_ZONE_ID
      ? (await run('cloudflare_get_zone', { zone_id: process.env.CLOUDFLARE_ZONE_ID })).result
      : (await run('cloudflare_list_zones', { per_page: 5 })).result[0];
    accountId = accountId ?? zone?.account.id;
  }, 30000);

  it('reads zones, the zone, accounts and zone settings', async () => {
    const zones = await run('cloudflare_list_zones', { per_page: 5 });
    expect(zones.success).toBe(true);
    expect(zone).toBeDefined();
    expect((await run('cloudflare_get_zone', { zone_id: zone!.id })).result.name).toBe(zone!.name);
    expect(Array.isArray((await run('cloudflare_list_accounts')).result)).toBe(true);
    const settings = await run('cloudflare_list_zone_settings', { zone_id: zone!.id });
    expect(settings.result.some((s: { id: string }) => s.id === 'ssl')).toBe(true);
    expect((await run('cloudflare_get_zone_setting', { zone_id: zone!.id, setting_id: 'ssl' })).result.id).toBe('ssl');
  }, 60000);

  it('reads DNS records, one record and the BIND export', async () => {
    const records = await run('cloudflare_list_dns_records', { zone_id: zone!.id, per_page: 5 });
    expect(Array.isArray(records.result)).toBe(true);
    if (records.result[0]) {
      expect((await run('cloudflare_get_dns_record', { zone_id: zone!.id, dns_record_id: records.result[0].id })).result.id).toBe(records.result[0].id);
    }
    const bind = await run('cloudflare_export_dns_records', { zone_id: zone!.id });
    expect(typeof bind).toBe('string');
    expect(bind).toContain(zone!.name);
  }, 60000);

  it('reads rulesets, a phase entry point and page rules', async () => {
    const rulesets = await run('cloudflare_list_rulesets', { zone_id: zone!.id });
    expect(Array.isArray(rulesets.result)).toBe(true);
    const own = rulesets.result.find((r: { kind: string }) => r.kind === 'zone');
    if (own) {
      expect((await run('cloudflare_get_ruleset', { zone_id: zone!.id, ruleset_id: own.id })).result.id).toBe(own.id);
      const entry = await run('cloudflare_get_phase_rules', { zone_id: zone!.id, phase: own.phase });
      expect(entry.result.phase).toBe(own.phase);
    }
    const missing = await run('cloudflare_get_phase_rules', { zone_id: zone!.id, phase: 'http_custom_errors' }).catch((e) => e);
    expect(missing?.result !== undefined || [403, 404].includes(status(missing))).toBe(true);
    const pageRules = await run('cloudflare_list_page_rules', { zone_id: zone!.id }).catch((e) => e);
    expect(Array.isArray(pageRules?.result) || status(pageRules) === 403).toBe(true);
  }, 60000);

  it('reads daily traffic and runs a GraphQL query', async () => {
    const day = (offset: number) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
    const traffic = await run('cloudflare_get_zone_traffic', { zone_id: zone!.id, since: day(7), until: day(0) });
    expect(Array.isArray(traffic.data.viewer.zones[0].httpRequests1dGroups)).toBe(true);
    const gql = await run('cloudflare_graphql_analytics', {
      query: 'query($zoneTag: string, $since: Time) { viewer { zones(filter: {zoneTag: $zoneTag}) { httpRequestsAdaptiveGroups(limit: 5, filter: {datetime_geq: $since}, orderBy: [count_DESC]) { count dimensions { clientRequestHTTPHost } } } } }',
      variables: { zoneTag: zone!.id, since: new Date(Date.now() - 3600000).toISOString().replace(/\.\d+Z$/, 'Z') },
    });
    expect(Array.isArray(gql.data.viewer.zones)).toBe(true);
  }, 60000);

  it('reads Workers, their routes and domains, and R2 buckets', async () => {
    expect(accountId).toBeDefined();
    const workers = await run('cloudflare_list_workers', { account_id: accountId });
    expect(Array.isArray(workers.result)).toBe(true);
    if (workers.result[0]) {
      const name = workers.result[0].id;
      expect((await run('cloudflare_get_worker_settings', { account_id: accountId, script_name: name })).success).toBe(true);
      const code = await run('cloudflare_get_worker_content', { account_id: accountId, script_name: name });
      expect(typeof code === 'string' || typeof code === 'object').toBe(true);
    }
    expect(Array.isArray((await run('cloudflare_list_worker_routes', { zone_id: zone!.id })).result)).toBe(true);
    expect(Array.isArray((await run('cloudflare_list_worker_domains', { account_id: accountId })).result)).toBe(true);
    const buckets = await run('cloudflare_list_r2_buckets', { account_id: accountId }).catch((e) => e);
    if (Array.isArray(buckets?.result?.buckets)) {
      if (buckets.result.buckets[0]) {
        const b = buckets.result.buckets[0].name;
        expect((await run('cloudflare_get_r2_bucket', { account_id: accountId, bucket_name: b })).result.name).toBe(b);
      }
    } else {
      // R2 not enabled on the account (10042 NotEntitled) or no R2 permission.
      expect([403]).toContain(status(buckets));
    }
  }, 60000);

  it('a wrong token is refused', async () => {
    const res = await engine()
      .execute({ ...config(), authConfig: { token: 'wrong-token-wrong-token-wrong-token-wrong' } } as never, tool('cloudflare_list_zones').endpointMapping, {})
      .catch((e) => e);
    expect([400, 401, 403]).toContain(status(res));
  }, 30000);

  (process.env.CLOUDFLARE_LIVE_WRITE === '1' && process.env.CLOUDFLARE_ZONE_ID ? it : it.skip)(
    'creates a test TXT record, changes it, purges one URL, and deletes the record',
    async () => {
      const name = `anythingmcp-test-${Date.now()}.${zone!.name}`;
      let recordId: string | undefined;
      try {
        const created = await run('cloudflare_create_dns_record', { zone_id: zone!.id, type: 'TXT', name, content: '"AnythingMCP test"', ttl: 60, comment: 'AnythingMCP live spec; safe to delete' });
        recordId = created.result.id;
        expect(created.result.name).toBe(name);
        const updated = await run('cloudflare_update_dns_record', { zone_id: zone!.id, dns_record_id: recordId, content: '"AnythingMCP test (updated)"' });
        expect(updated.result.content).toBe('"AnythingMCP test (updated)"');
        expect((await run('cloudflare_get_dns_record', { zone_id: zone!.id, dns_record_id: recordId })).result.content).toBe('"AnythingMCP test (updated)"');
        const purged = await run('cloudflare_purge_cache', { zone_id: zone!.id, files: [`https://${zone!.name}/anythingmcp-test-${Date.now()}`] });
        expect(purged.success).toBe(true);
      } finally {
        if (recordId) {
          const deleted = await run('cloudflare_delete_dns_record', { zone_id: zone!.id, dns_record_id: recordId });
          expect(deleted.result.id).toBe(recordId);
        }
      }
    },
    120000,
  );
});
