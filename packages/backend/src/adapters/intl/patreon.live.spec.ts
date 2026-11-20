import axios from 'axios';
import * as adapter from './patreon.json';
import { serializeRepeatedParams } from '../../connectors/engines/rest.engine';

/**
 * Patreon API v2 adapter (https://www.patreon.com/api/oauth2/v2).
 *
 * OAuth 2.0 authorization code with the creator's own Patreon client: authorize
 * at www.patreon.com/oauth2/authorize, token and refresh at
 * www.patreon.com/api/oauth2/token with the client id and secret in the form
 * body. A Creator's Access Token expires like any other token and nothing
 * renews it, so the adapter signs in instead of taking a pasted token.
 * Endpoints, scopes and attributes come from https://docs.patreon.com/.
 *
 * Patreon speaks JSON:API: query parameters are named fields[member],
 * page[count] and so on, and their brackets must be percent-encoded. Static
 * checks always run, including how the engine writes those names. Live checks
 * run only with RUN_PATREON_LIVE=1: without a token they confirm the API
 * refuses the call; with PATREON_ACCESS_TOKEN they read the identity.
 *
 *   RUN_PATREON_LIVE=1 PATREON_ACCESS_TOKEN=... npx jest src/adapters/intl/patreon.live.spec.ts
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: {
    properties?: Record<string, { type?: string; description?: string; default?: unknown; enum?: unknown[]; pattern?: string }>;
    required?: string[];
  };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    bodyEncoding?: string;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  aliases?: string[];
  instructions: string;
  prerequisites?: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<
    string,
    { label?: string; kind?: string; secret?: boolean; pattern?: string; options?: Array<{ value: string; label: string }> }
  >;
  verifyHints: Record<string, unknown>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
    headers?: Record<string, string>;
    config?: Record<string, unknown>;
  };
  tools: Tool[];
};
const tool = (name: string): Tool => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
/** Tool arguments a mapping reads: {x} in the path, "$x" and "${x}" in query, body and headers. */
const used = (entry: Tool): Set<string> => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) out.add(p);
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (/^\$\w+$/.test(v)) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
/** Text outside `code spans`: the website renders descriptions and instructions as MDX. */
const outsideCode = (text: string): string => text.replace(/`[^`]*`/g, '');

// name, HTTP method, path below the base URL
const TOOLS: Array<[string, string, string]> = [
  ['patreon_get_identity', 'GET', '/identity'],
  ['patreon_list_campaigns', 'GET', '/campaigns'],
  ['patreon_get_campaign', 'GET', '/campaigns/{campaign_id}'],
  ['patreon_list_campaign_tiers', 'GET', '/campaigns/{campaign_id}'],
  ['patreon_list_campaign_members', 'GET', '/campaigns/{campaign_id}/members'],
  ['patreon_get_member', 'GET', '/members/{member_id}'],
  ['patreon_get_member_pledge_history', 'GET', '/members/{member_id}'],
  ['patreon_list_campaign_posts', 'GET', '/campaigns/{campaign_id}/posts'],
  ['patreon_get_post', 'GET', '/posts/{post_id}'],
  ['patreon_list_webhooks', 'GET', '/webhooks'],
];
const REQUIRED: Record<string, string[]> = {
  patreon_get_campaign: ['campaign_id'],
  patreon_list_campaign_tiers: ['campaign_id'],
  patreon_list_campaign_members: ['campaign_id'],
  patreon_get_member: ['member_id'],
  patreon_get_member_pledge_history: ['member_id'],
  patreon_list_campaign_posts: ['campaign_id'],
  patreon_get_post: ['post_id'],
};
const SWITCHED_OFF: string[] = [];

describe('patreon adapter: static contract', () => {
  it('is filed where the catalog expects it', () => {
    expect(a.slug).toBe('patreon');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('publishing');
    expect(a.icon).toBe('patreon');
    expect(a.docsUrl).toBe('https://docs.patreon.com/');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://www.patreon.com/api/oauth2/v2');
  });

  it('authenticates as the vendor documents', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      'clientId': '{{PATREON_CLIENT_ID}}',
      'clientSecret': '{{PATREON_CLIENT_SECRET}}',
      'authorizationUrl': 'https://www.patreon.com/oauth2/authorize',
      'tokenUrl': 'https://www.patreon.com/api/oauth2/token',
      'tokenAuthMethod': 'client_secret_post',
      'pkce': false,
      'scopes': 'identity identity[email] campaigns campaigns.members campaigns.members[email] campaigns.posts w:campaigns.webhook'
    });
    expect(a.requiredEnvVars).toEqual(['PATREON_CLIENT_ID', 'PATREON_CLIENT_SECRET']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    for (const name of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) {
      expect(a.envVarMeta[name]?.label).toBeTruthy();
    }
    for (const name of ['PATREON_CLIENT_SECRET']) {
      expect(a.envVarMeta[name]).toMatchObject({ kind: 'credential', secret: true });
    }
  });

  it('maps every tool to the documented method and path', () => {
    expect(a.tools.map((entry) => entry.name)).toEqual(TOOLS.map(([name]) => name));
    for (const [name, method, path] of TOOLS) {
      const m = tool(name).endpointMapping;
      expect(`${name}: ${m.method} ${m.path}`).toBe(`${name}: ${method} ${path}`);
    }
  });

  it('prefixes every tool, declares every argument it reads and requires what the API requires', () => {
    const names = new Set(a.tools.map((entry) => entry.name));
    expect(names.size).toBe(a.tools.length);
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      expect(entry.name).toMatch(/^patreon_[a-z0-9_]+$/);
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect([entry.name, arg, declared.has(arg) || envNames.has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect([entry.name, entry.parameters.required ?? []]).toEqual([entry.name, REQUIRED[entry.name] ?? []]);
      for (const [param, schema] of Object.entries(entry.parameters.properties ?? {})) {
        expect([entry.name, param, Boolean(schema.description)]).toEqual([entry.name, param, true]);
      }
      expect(entry.description.length).toBeGreaterThanOrEqual(60);
    }
  });

  it('installs the risky tools switched off and marks every GET read-only', () => {
    const offNow = a.tools.filter((entry) => entry.enabled === false).map((entry) => entry.name);
    expect(offNow.sort()).toEqual(SWITCHED_OFF);
    for (const entry of a.tools) {
      const method = entry.endpointMapping.method;
      if (method === 'GET') expect([entry.name, entry.annotations?.readOnlyHint]).toEqual([entry.name, true]);
      if (method === 'DELETE') expect([entry.name, entry.enabled]).toEqual([entry.name, false]);
    }
  });

  it('names every tool in the instructions and keeps the texts MDX-safe', () => {
    expect(a.instructions.startsWith('## ')).toBe(true);
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    const texts = [a.instructions, a.prerequisites ?? '', ...a.tools.map((entry) => entry.description)];
    for (const entry of a.tools) {
      for (const schema of Object.values(entry.parameters.properties ?? {})) texts.push(schema.description ?? '');
    }
    for (const text of texts) {
      expect(outsideCode(text)).not.toMatch(/[{}<]/);
      expect(text).not.toMatch(/\u2014/);
    }
  });

  it('probes with a cheap read and explains the usual refusals', () => {
    expect(a.probe).toEqual({
      'tool': 'patreon_get_identity',
      'params': {}
    });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const key of ['401', '403', '404', 'rate_limited', 'invalid_client', 'invalid_grant']) expect(a.verifyHints[key]).toBeTruthy();
  });


  it('is read-only: every tool is a GET and none installs switched off', () => {
    for (const entry of a.tools) {
      expect([entry.name, entry.endpointMapping.method]).toEqual([entry.name, 'GET']);
      expect(entry.enabled).not.toBe(false);
      expect(entry.endpointMapping.bodyMapping).toBeUndefined();
    }
  });

  it('names the JSON:API parameters with brackets and gives each one a default', () => {
    for (const entry of a.tools) {
      const query = entry.endpointMapping.queryParams ?? {};
      for (const [key, value] of Object.entries(query)) {
        expect(key).toMatch(/^(include|fields\[[a-z-]+\]|page\[(count|cursor)\])$/);
        const param = String(value).slice(1);
        const schema = entry.parameters.properties?.[param];
        expect([entry.name, key, Boolean(schema)]).toEqual([entry.name, key, true]);
        // The fields and include lists are verbose: the caller never has to write them.
        // Only the cursor and the address fields (an extra scope) are left to the caller.
        const optional = key === 'page[cursor]' || key === 'fields[address]';
        expect([entry.name, key, schema?.default !== undefined]).toEqual([entry.name, key, !optional]);
        if (key.startsWith('fields[')) {
          expect(param).toBe(`fields_${key.slice(7, -1).replace(/-/g, '_')}`);
          if (!optional) expect(new RegExp(schema!.pattern!).test(String(schema!.default))).toBe(true);
        }
      }
    }
    expect(tool('patreon_list_campaign_members').endpointMapping.queryParams).toEqual({
      include: '$include',
      'fields[member]': '$fields_member',
      'fields[tier]': '$fields_tier',
      'fields[user]': '$fields_user',
      'fields[address]': '$fields_address',
      'fields[pledge-event]': '$fields_pledge_event',
      'page[count]': '$page_count',
      'page[cursor]': '$page_cursor',
    });
  });

  it('percent-encodes the brackets of the parameter names, as Patreon requires', () => {
    expect(
      serializeRepeatedParams({
        include: 'currently_entitled_tiers,user',
        'fields[member]': 'full_name,email,patron_status',
        'fields[pledge-event]': 'date,type',
        'page[count]': 100,
        'page[cursor]': '03:eyJ2IjoxfQ:1v2d',
      }),
    ).toBe(
      'include=currently_entitled_tiers,user' +
        '&fields%5Bmember%5D=full_name,email,patron_status' +
        '&fields%5Bpledge-event%5D=date,type' +
        '&page%5Bcount%5D=100' +
        '&page%5Bcursor%5D=03:eyJ2IjoxfQ:1v2d',
    );
  });

  it('asks for documented member attributes by default and never for the shipping address', () => {
    const members = tool('patreon_list_campaign_members').parameters.properties ?? {};
    const documented = new Set([
      'campaign_lifetime_support_cents',
      'currently_entitled_amount_cents',
      'email',
      'full_name',
      'is_follower',
      'is_free_trial',
      'is_gifted',
      'last_charge_date',
      'last_charge_status',
      'lifetime_support_cents',
      'next_charge_date',
      'note',
      'patron_status',
      'pledge_cadence',
      'pledge_relationship_start',
      'will_pay_amount_cents',
    ]);
    for (const field of String(members.fields_member.default).split(',')) expect([field, documented.has(field)]).toEqual([field, true]);
    expect(String(members.include.default).split(',')).toEqual(['currently_entitled_tiers', 'user']);
    expect(String(a.connector.authConfig?.scopes).split(' ')).not.toContain('campaigns.members.address');
    expect(members.fields_address.default).toBeUndefined();
    expect(new RegExp(members.fields_address.pattern!).test('addressee,line_1,line_2,city,postal_code')).toBe(true);
    expect(members.page_count).toMatchObject({ default: 100, maximum: 1000 });
  });

  it('cannot be asked for the signing secret of a webhook', () => {
    const schema = tool('patreon_list_webhooks').parameters.properties?.fields_webhook;
    const pattern = new RegExp(schema!.pattern!);
    expect(pattern.test(String(schema!.default))).toBe(true);
    expect(String(schema!.default).split(',')).not.toContain('secret');
    expect(pattern.test('uri,secret')).toBe(false);
    expect(pattern.test('secret')).toBe(false);
  });
});


// Opt-in: RUN_PATREON_LIVE=1. The refusal check needs no account; the read
// needs PATREON_ACCESS_TOKEN (for a quick check, the Creator's Access Token of
// your client). Nothing is written.
const live = process.env.RUN_PATREON_LIVE === '1';
(live ? describe : describe.skip)('patreon: live', () => {
  const identity = (token: string) =>
    axios.get(`${a.connector.baseUrl}/identity`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'AnythingMCP' },
      params: { 'fields[user]': 'full_name,is_creator', include: 'campaign' },
      paramsSerializer: (params: Record<string, unknown>) => serializeRepeatedParams(params),
      validateStatus: () => true,
    });

  it('refuses an invalid token with a JSON:API error', async () => {
    const response = await identity('not-a-token');
    expect(response.status).toBe(401);
    expect(Array.isArray(response.data.errors)).toBe(true);
  });

  it('reads the identity of the token', async () => {
    const token = process.env.PATREON_ACCESS_TOKEN;
    if (!token) throw new Error('Set PATREON_ACCESS_TOKEN for the live check');
    const response = await identity(token);
    expect(response.status).toBe(200);
    expect(response.data.data.type).toBe('user');
  });
});
