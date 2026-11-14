import * as adapter from './aurora-inbox.json';

/**
 * Aurora Inbox Platform API v1 (developers.aurorainbox.com, OpenAPI at /swagger/v1-en/swagger.json):
 * X-Api-Key header. Every tool was checked read-only
 * against a live account on 22 Oct 2026.
 * Live part: AURORA_INBOX_API_KEY=ak_live_... RUN_AURORA_INBOX_LIVE=1 npx jest src/adapters/intl/aurora-inbox
 * (reads only: teams, one funnel report, contacts).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  unlisted?: boolean;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
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
const PREFIX = 'aurora_inbox_';
const WRITES: string[] = [];

describe('aurora-inbox adapter: static spec conformance', () => {

  it('sends the API key in X-Api-Key to the Platform API v1', () => {
    expect(a.requiredEnvVars).toEqual(['AURORA_INBOX_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://developers.aurorainbox.com/Platform/V1');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Api-Key', apiKey: '{{AURORA_INBOX_API_KEY}}' });
    expect(a.envVarMeta?.AURORA_INBOX_API_KEY.secret).toBe(true);
  });

  it('maps the documented routes', () => {
    expect(tool('aurora_inbox_get_funnel_report').endpointMapping).toMatchObject({ path: '/Teams/{team_id}/FunnelReport', queryParams: { from: '$from', to: '$to', userId: '$user_id' } });
    expect(tool('aurora_inbox_search_chats').endpointMapping).toMatchObject({ method: 'POST', path: '/Chats/Search', bodyMapping: { page: '$page', searchTerm: '$search_term', teamId: '$team_id' } });
    expect(tool('aurora_inbox_list_bookings').endpointMapping.queryParams).toMatchObject({ roomId: '$chat_id', status: '$status' });
    expect(tool('aurora_inbox_list_channels').endpointMapping.path).toBe('/Channels/{channel_type}');
  });

  it('sends no messages and changes nothing', () => {
    for (const t of a.tools) {
      if (t.endpointMapping.method === 'GET') continue;
      expect(t.name).toBe('aurora_inbox_search_chats');
    }
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/Messages|TemplateMessage|Media|Upsert|Webhooks/);
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('writes are annotated, the risky ones installed switched off; reads are GET or marked read-only', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...WRITES].sort());
    for (const t of a.tools) {
      if (t.annotations?.readOnlyHint === false) continue;
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      if (t.endpointMapping.method !== 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
    }
    for (const n of WRITES) expect(tool(n).annotations?.readOnlyHint).toBe(false);
  });


  it('probes with a read tool and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.annotations?.readOnlyHint === false).toBe(false);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const live = process.env.RUN_AURORA_INBOX_LIVE === '1' && process.env.AURORA_INBOX_API_KEY ? describe : describe.skip;
live('aurora-inbox adapter: live (read-only)', () => {
  const headers = { 'X-Api-Key': process.env.AURORA_INBOX_API_KEY ?? '', Accept: 'application/json' };
  it('reads teams, a funnel report and contacts', async () => {
    const teams = (await (await fetch(`${a.connector.baseUrl}/Teams`, { headers })).json()) as Array<{ id: string }>;
    expect(teams.length).toBeGreaterThan(0);
    const funnel = (await (await fetch(`${a.connector.baseUrl}/Teams/${teams[0].id}/FunnelReport`, { headers })).json()) as { stages: unknown[] };
    expect(Array.isArray(funnel.stages)).toBe(true);
    const contacts = (await (await fetch(`${a.connector.baseUrl}/Contacts?pageSize=1`, { headers })).json()) as { totalCount: number };
    expect(typeof contacts.totalCount).toBe('number');
  }, 60_000);
});
