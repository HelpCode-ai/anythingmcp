import * as adapter from './infomaniak.json';

/**
 * Infomaniak API adapter (read-only).
 *
 * Static checks always run: the bearer token, every tool's method and path
 * against the API reference (https://developer.infomaniak.com/docs/api: paths
 * carry their own version, /1, /2 or /3), the two paging styles (page and
 * per_page, or cursor and limit on kDrive), the bracketed list parameters, and
 * that every tool is a GET.
 *
 * Live checks run only with RUN_INFOMANIAK_LIVE=1. Without a token they confirm
 * that the API refuses a wrong one; with INFOMANIAK_API_TOKEN they read the
 * profile and the accounts. Nothing is written.
 *
 *   RUN_INFOMANIAK_LIVE=1 INFOMANIAK_API_TOKEN=... npx jest src/adapters/ch/infomaniak.live.spec.ts
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { description?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  description: string;
  instructions: string;
  prerequisites?: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string; help?: string; options?: Array<{ value: string; label: string }> }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string>; config?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
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
  return out;
};
// Text outside `code` spans: the website renders descriptions as MDX.
const prose = (text: string) => text.replace(/`[^`]*`/g, '');

const PREFIX = 'infomaniak_';
// Method and path of every tool, as the vendor documents them.
const ROUTES: Record<string, [string, string]> = {
  infomaniak_get_profile: ['GET', '/2/profile'],
  infomaniak_list_accounts: ['GET', '/1/accounts'],
  infomaniak_list_products: ['GET', '/1/products'],
  infomaniak_list_account_users: ['GET', '/2/accounts/{account_id}/users'],
  infomaniak_get_my_ksuite: ['GET', '/1/my_ksuite/current'],
  infomaniak_list_events: ['GET', '/2/events'],
  infomaniak_list_drives: ['GET', '/2/drive'],
  infomaniak_get_drive: ['GET', '/2/drive/{drive_id}'],
  infomaniak_list_drive_users: ['GET', '/3/drive/{drive_id}/users'],
  infomaniak_list_directory_files: ['GET', '/3/drive/{drive_id}/files/{file_id}/files'],
  infomaniak_get_file: ['GET', '/3/drive/{drive_id}/files/{file_id}'],
  infomaniak_search_files: ['GET', '/3/drive/{drive_id}/files/search'],
  infomaniak_list_recent_files: ['GET', '/3/drive/{drive_id}/files/recents'],
  infomaniak_list_last_modified_files: ['GET', '/3/drive/{drive_id}/files/last_modified'],
  infomaniak_list_drive_activities: ['GET', '/3/drive/{drive_id}/activities'],
  infomaniak_get_file_share_link: ['GET', '/2/drive/{drive_id}/files/{file_id}/link'],
  infomaniak_list_file_comments: ['GET', '/2/drive/{drive_id}/files/{file_id}/comments'],
  infomaniak_list_file_versions: ['GET', '/3/drive/{drive_id}/files/{file_id}/versions'],
  infomaniak_list_trash: ['GET', '/3/drive/{drive_id}/trash'],
  infomaniak_list_mailboxes: ['GET', '/1/mail_hostings/{mail_hosting_id}/mailboxes'],
  infomaniak_get_mailbox: ['GET', '/1/mail_hostings/{mail_hosting_id}/mailboxes/{mailbox_name}'],
  infomaniak_list_mailbox_aliases: ['GET', '/2/mail_hostings/{mail_hosting_id}/mailboxes/{mailbox_name}/aliases'],
  infomaniak_list_mailbox_forwarding: ['GET', '/1/mail_hostings/{mail_hosting_id}/mailboxes/{mailbox_name}/forwarding_addresses'],
  infomaniak_list_mail_redirections: ['GET', '/1/mail_hostings/{mail_hosting_id}/redirections'],
  infomaniak_list_mailing_lists: ['GET', '/1/mail_hostings/{mail_hosting_id}/mailing_lists'],
  infomaniak_list_mail_auto_replies: ['GET', '/1/mail_hostings/{mail_hosting_id}/auto_replies'],
  infomaniak_list_domains: ['GET', '/2/domains/domains'],
  infomaniak_get_domain: ['GET', '/2/domains/domains/{domain}'],
  infomaniak_list_domain_zones: ['GET', '/2/domains/domains/{domain}/zones'],
  infomaniak_check_dnssec: ['GET', '/2/domains/domains/{domain}/dnssec/check'],
  infomaniak_get_zone: ['GET', '/2/zones/{zone}'],
  infomaniak_list_dns_records: ['GET', '/2/zones/{zone}/records'],
  infomaniak_get_dns_record: ['GET', '/2/zones/{zone}/records/{record_id}'],
};
const REQUIRED: Record<string, string[]> = {
  infomaniak_list_account_users: ['account_id'],
  infomaniak_list_drives: ['account_id'],
  infomaniak_get_drive: ['drive_id'],
  infomaniak_list_drive_users: ['drive_id'],
  infomaniak_list_directory_files: ['drive_id', 'file_id'],
  infomaniak_get_file: ['drive_id', 'file_id'],
  infomaniak_search_files: ['drive_id'],
  infomaniak_list_recent_files: ['drive_id'],
  infomaniak_list_last_modified_files: ['drive_id'],
  infomaniak_list_drive_activities: ['drive_id'],
  infomaniak_get_file_share_link: ['drive_id', 'file_id'],
  infomaniak_list_file_comments: ['drive_id', 'file_id'],
  infomaniak_list_file_versions: ['drive_id', 'file_id'],
  infomaniak_list_trash: ['drive_id'],
  infomaniak_list_mailboxes: ['mail_hosting_id'],
  infomaniak_get_mailbox: ['mail_hosting_id', 'mailbox_name'],
  infomaniak_list_mailbox_aliases: ['mail_hosting_id', 'mailbox_name'],
  infomaniak_list_mailbox_forwarding: ['mail_hosting_id', 'mailbox_name'],
  infomaniak_list_mail_redirections: ['mail_hosting_id'],
  infomaniak_list_mailing_lists: ['mail_hosting_id'],
  infomaniak_list_mail_auto_replies: ['mail_hosting_id'],
  infomaniak_get_domain: ['domain'],
  infomaniak_list_domain_zones: ['domain'],
  infomaniak_check_dnssec: ['domain'],
  infomaniak_get_zone: ['zone'],
  infomaniak_list_dns_records: ['zone'],
  infomaniak_get_dns_record: ['zone', 'record_id'],
};
// Installed switched off: an administrator turns them on per connector.
const SWITCHED_OFF: string[] = [];
// Writes that are on at install.
const WRITES: string[] = [];
// POST requests that only read (searches and log queries).
const READ_POSTS: string[] = [];

describe('infomaniak adapter: static contract', () => {
  it('declares the catalog envelope, the base URL and the authentication', () => {
    expect(a.slug).toBe('infomaniak');
    expect(a.region).toBe('ch');
    expect(a.category).toBe('infrastructure');
    expect(a.icon).toBe('infomaniak');
    expect(a.requiredEnvVars).toEqual(['INFOMANIAK_API_TOKEN']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://api.infomaniak.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{INFOMANIAK_API_TOKEN}}' });
    for (const name of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) {
      expect(`${name}:${Boolean(a.envVarMeta[name]?.help)}`).toBe(`${name}:true`);
      expect(`${name}:${a.envVarMeta[name]?.secret === true}`).toBe(`${name}:${(['INFOMANIAK_API_TOKEN'] as string[]).includes(name)}`);
    }
    // An optional variable in a connector header would be sent as the literal placeholder.
    for (const name of a.optionalEnvVars ?? []) expect(JSON.stringify(a.connector.headers ?? {})).not.toContain(name);
  });

  it('checks the credentials with a cheap read and explains the usual refusals', () => {
    expect(a.probe).toEqual({ tool: 'infomaniak_get_profile' });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const key of ['401', '403', '404', 'rate_limited']) expect(`${key}:${Boolean(a.verifyHints[key])}`).toBe(`${key}:true`);
  });

  it('maps every tool to its documented method and path', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const t of a.tools) {
      expect(`${t.name} ${t.endpointMapping.method} ${t.endpointMapping.path}`).toBe(`${t.name} ${ROUTES[t.name][0]} ${ROUTES[t.name][1]}`);
      expect(`${t.name}:${JSON.stringify(t.parameters?.required ?? [])}`).toBe(`${t.name}:${JSON.stringify(REQUIRED[t.name] ?? [])}`);
    }
  });

  it('prefixes every tool, sends every declared parameter, declares every argument it reads and requires its path parameters', () => {
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) {
        expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
        expect(`${t.name}:${p}:${Boolean(t.parameters?.properties?.[p]?.description)}`).toBe(`${t.name}:${p}:true`);
      }
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p) || envNames.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required ?? []).toContain(p);
    }
  });

  it('installs deletes and other risky calls switched off and marks reading POSTs read-only', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...SWITCHED_OFF].sort());
    for (const t of a.tools) {
      const method = t.endpointMapping.method;
      if (method === 'DELETE') expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:false`);
      if (READ_POSTS.includes(t.name)) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
      else expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:undefined`);
      const reads = method === 'GET' || READ_POSTS.includes(t.name);
      expect(`${t.name}:${reads || WRITES.includes(t.name) || SWITCHED_OFF.includes(t.name)}`).toBe(`${t.name}:true`);
      if (reads) expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
    }
  });

  it('names every tool in the instructions and keeps the texts MDX-safe', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    const texts = [a.description, a.instructions, a.prerequisites ?? '', ...Object.values(a.verifyHints)];
    for (const t of a.tools) {
      texts.push(t.description);
      for (const p of Object.values(t.parameters?.properties ?? {})) texts.push(p.description ?? '');
    }
    for (const text of texts) expect(prose(text)).not.toMatch(/[{}<]/);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });


  it('is read-only and keeps the API version in each path', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(`${t.name}:${/^\/[123]\//.test(t.endpointMapping.path)}`).toBe(`${t.name}:true`);
      expect(t.endpointMapping.path).not.toMatch(/download|upload|temporary_url|preview|thumbnail|password/);
    }
  });

  it('pages classic lists with page and per_page and kDrive lists with cursor and limit', () => {
    for (const t of a.tools) {
      const props = t.parameters?.properties ?? {};
      if ('cursor' in props) {
        expect(t.endpointMapping.queryParams).toMatchObject({ cursor: '$cursor', limit: '$limit' });
        expect(`${t.name}:${'page' in props}`).toBe(`${t.name}:false`);
        expect(t.endpointMapping.path.startsWith('/3/drive/')).toBe(true);
      }
      if ('per_page' in props) expect(t.endpointMapping.queryParams).toMatchObject({ page: '$page', per_page: '$per_page' });
    }
    expect(tool('infomaniak_list_drives').endpointMapping.queryParams).toEqual({ account_id: '$account_id', page: '$page', per_page: '$per_page' });
    // List filters go out in the bracket form a PHP API reads.
    expect(tool('infomaniak_search_files').endpointMapping.queryParams).toMatchObject({ query: '$query', 'types[]': '$types', 'extensions[]': '$extensions', 'order_by[]': '$order_by' });
    // The activity list refuses a call without a language: the schema default fills it in.
    expect((tool('infomaniak_list_drive_activities').parameters?.properties?.lang as unknown as { default: string }).default).toBe('en');
    expect(tool('infomaniak_list_drive_activities').endpointMapping.queryParams).toMatchObject({ lang: '$lang' });
  });

  it('accepts a bare token and refuses one pasted with Bearer', () => {
    const token = new RegExp(a.envVarMeta.INFOMANIAK_API_TOKEN.pattern ?? '');
    expect(token.test('AbCdEf0123456789-AbCdEf0123456789_xyz')).toBe(true);
    for (const bad of ['', 'Bearer AbCdEf0123456789AbCdEf0123456789', 'has space AbCdEf0123456789', 'short']) expect(`${bad}:${token.test(bad)}`).toBe(`${bad}:false`);
    expect(a.connector.baseUrl).toBe('https://api.infomaniak.com');
  });
});

const env = process.env;
const base = 'https://api.infomaniak.com';
(env.RUN_INFOMANIAK_LIVE === '1' ? describe : describe.skip)('infomaniak adapter: live (read-only)', () => {
  it('refuses a wrong token', async () => {
    const res = await fetch(`${base}/2/profile`, { headers: { Accept: 'application/json', Authorization: 'Bearer not-a-real-token-0123456789' } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { result: string }).result).toBe('error');
  }, 30_000);

  it('reads the profile and the accounts', async () => {
    if (!env.INFOMANIAK_API_TOKEN) throw new Error('Set INFOMANIAK_API_TOKEN for the live check');
    const headers = { Accept: 'application/json', Authorization: `Bearer ${env.INFOMANIAK_API_TOKEN}` };
    for (const path of ['/2/profile', '/1/accounts']) {
      const res = await fetch(`${base}${path}`, { headers });
      expect(`${path}:${res.status}`).toBe(`${path}:200`);
      expect(((await res.json()) as { result: string }).result).toBe('success');
    }
  }, 60_000);
});
