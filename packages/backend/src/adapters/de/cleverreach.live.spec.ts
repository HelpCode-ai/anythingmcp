import * as adapter from './cleverreach.json';

/**
 * CleverReach REST API v3 (developers.cleverreach.com, Swagger at rest.cleverreach.com/v3/explorer/swagger.json):
 * base https://rest.cleverreach.com/v3, OAuth2 authorization code with the user's own OAuth app
 * (authorize.php / token.php), Bearer access token.
 * Live part (reads only: whoami, groups): needs an access token from an authorized app:
 *   CLEVERREACH_ACCESS_TOKEN=... RUN_CLEVERREACH_LIVE=1 npx jest src/adapters/de/cleverreach
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string; advanced?: boolean }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const ENV = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings (connector variables excluded).
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  for (const e of ENV) out.delete(e);
  return out;
};
const PREFIX = 'cleverreach_';

describe('cleverreach adapter: static spec conformance', () => {

  it('signs in with OAuth2 authorization code at CleverReach and renews with the refresh token', () => {
    expect(a.requiredEnvVars).toEqual(['CLEVERREACH_CLIENT_ID', 'CLEVERREACH_CLIENT_SECRET']);
    expect(a.optionalEnvVars).toEqual(['CLEVERREACH_REFRESH_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://rest.cleverreach.com/v3');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toMatchObject({
      clientId: '{{CLEVERREACH_CLIENT_ID}}', clientSecret: '{{CLEVERREACH_CLIENT_SECRET}}', refreshToken: '{{CLEVERREACH_REFRESH_TOKEN}}',
      authorizationUrl: 'https://rest.cleverreach.com/oauth/authorize.php', tokenUrl: 'https://rest.cleverreach.com/oauth/token.php',
    });
    expect(a.connector.authConfig?.grant).toBeUndefined();
    expect(a.envVarMeta?.CLEVERREACH_CLIENT_SECRET.secret).toBe(true);
    expect(a.envVarMeta?.CLEVERREACH_REFRESH_TOKEN.advanced).toBe(true);
    expect(a.region).toBe('de');
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith('/v3')).toBe(false);
  });

  it('maps groups, receivers and the receiver lifecycle', () => {
    expect(tool('cleverreach_list_group_receivers').endpointMapping).toMatchObject({ method: 'GET', path: '/groups/{group_id}/receivers', queryParams: { type: '$type', pagesize: '$pagesize', page: '$page', detail: '$detail' } });
    expect(tool('cleverreach_get_receiver').endpointMapping).toEqual({ method: 'GET', path: '/receivers/{receiver}', queryParams: { group_id: '$group_id' } });
    expect(tool('cleverreach_find_receivers').endpointMapping).toMatchObject({ method: 'POST', path: '/receivers/filter', bodyMapping: { rules: '$rules', groups: '$groups', operator: '$operator' } });
    expect(tool('cleverreach_create_receiver').endpointMapping).toMatchObject({ method: 'POST', path: '/groups/{group_id}/receivers', bodyMapping: { email: '$email', registered: '$registered', activated: '$activated', global_attributes: '$global_attributes', tags: '$tags' } });
    expect(tool('cleverreach_update_receiver').endpointMapping).toMatchObject({ method: 'PUT', path: '/groups/{group_id}/receivers/{receiver}' });
    expect(tool('cleverreach_upsert_receivers').endpointMapping).toEqual({ method: 'POST', path: '/groups/{group_id}/receivers/upsert', bodyMapping: { __raw: '$receivers' } });
    expect(tool('cleverreach_activate_receiver').endpointMapping).toEqual({ method: 'PUT', path: '/groups/{group_id}/receivers/{receiver}/activate' });
    expect(tool('cleverreach_deactivate_receiver').endpointMapping).toEqual({ method: 'PUT', path: '/groups/{group_id}/receivers/{receiver}/deactivate' });
    expect(tool('cleverreach_remove_receiver_tags').endpointMapping).toEqual({ method: 'DELETE', path: '/receivers/{receiver}/tags/{tags}' });
    expect(tool('cleverreach_send_form_mail').endpointMapping).toMatchObject({ method: 'POST', path: '/forms/{form_id}/send/{type}', bodyMapping: { email: '$email', doidata: '$doidata' } });
  });

  it('maps mailings, reports, blacklist and bounces', () => {
    expect(tool('cleverreach_list_mailings').endpointMapping.queryParams).toMatchObject({ state: '$state', omit_body: '$omit_body' });
    expect(tool('cleverreach_create_mailing').endpointMapping).toMatchObject({ method: 'POST', path: '/mailings', bodyMapping: { name: '$name', subject: '$subject', sender_name: '$sender_name', sender_email: '$sender_email', content: '$content', receivers: '$receivers' } });
    expect(tool('cleverreach_send_mailing_preview').endpointMapping).toEqual({ method: 'POST', path: '/mailings/{mailing_id}/sendpreview', bodyMapping: { receivers: '$receivers', previewText: '$previewText' } });
    expect(tool('cleverreach_get_report_stats').endpointMapping.path).toBe('/reports/{report_id}/stats/{mode}');
    expect(tool('cleverreach_list_report_receivers').parameters?.properties?.state.enum).toEqual(['sent', 'opened', 'clicked', 'notopened', 'notclicked', 'bounced', 'unsubscribed']);
    expect(tool('cleverreach_add_to_blacklist').endpointMapping).toEqual({ method: 'POST', path: '/blacklist', bodyMapping: { email: '$email', comment: '$comment' } });
    expect(tool('cleverreach_list_bounces').endpointMapping).toEqual({ method: 'GET', path: '/bounces', queryParams: { pagesize: '$pagesize', page: '$page' } });
  });

  it('installs the receiver delete switched off and has no tool that sends a mailing to a list', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['cleverreach_delete_receiver']);
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/release|\/send$|group.*clear/);
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
      for (const r of t.parameters?.required ?? []) expect(`${t.name}:${r}:${props.includes(r)}`).toBe(`${t.name}:${r}:true`);
    }
  });

  it('marks reads over POST or PATCH read-only and deletes destructive', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping.method;
      if (m === 'DELETE') expect(`${t.name}:${t.annotations?.destructiveHint}`).toBe(`${t.name}:true`);
      if (m !== 'GET' && /_(search|find|preview|validate)_|_list_/.test(t.name)) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
      if (m === 'GET') expect(t.annotations?.readOnlyHint === false).toBe(false);
    }
  });

  it('probes with a read tool without required parameters and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const live = process.env.RUN_CLEVERREACH_LIVE === '1' && process.env.CLEVERREACH_ACCESS_TOKEN ? describe : describe.skip;
live('cleverreach adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Bearer ${process.env.CLEVERREACH_ACCESS_TOKEN}`, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as unknown;
  };
  it('reads the account and its groups', async () => {
    expect(await get('/debug/whoami')).toBeTruthy();
    expect(Array.isArray(await get('/groups'))).toBe(true);
  }, 60_000);
});
