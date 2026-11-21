import * as adapter from './getyoutubetranscript.json';

/**
 * GetYouTubeTranscript REST API (getyoutubetranscript.com/openapi.json):
 * x-api-key header on https://getyoutubetranscript.com/api/v1/<endpoint>.
 * Live part: RUN_GETYOUTUBETRANSCRIPT_LIVE=1 GETYOUTUBETRANSCRIPT_API_KEY=sk_live_... npx jest src/adapters/intl/getyoutubetranscript
 * (reads only: one free /credits call and one transcript, which costs 1 credit).
 * Without a key, RUN_GETYOUTUBETRANSCRIPT_LIVE=1 only checks that the API asks for the key.
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { type?: string; enum?: unknown[]; pattern?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  verifyHints?: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { type: string; baseUrl: string; authType: string; authConfig?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments and "$arg" values.
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
const PREFIX = 'getyoutubetranscript_';

describe('getyoutubetranscript adapter: static spec conformance', () => {
  it('sends the key in x-api-key to getyoutubetranscript.com/api/v1', () => {
    expect(a.slug).toBe('getyoutubetranscript');
    expect(a.region).toBe('intl');
    expect(a.requiredEnvVars).toEqual(['GETYOUTUBETRANSCRIPT_API_KEY']);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://getyoutubetranscript.com/api/v1');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'x-api-key', apiKey: '{{GETYOUTUBETRANSCRIPT_API_KEY}}' });
    expect(a.envVarMeta?.GETYOUTUBETRANSCRIPT_API_KEY.secret).toBe(true);
  });

  it('accepts real key shapes and refuses a pasted header', () => {
    const re = new RegExp(a.envVarMeta?.GETYOUTUBETRANSCRIPT_API_KEY.pattern as string);
    // Built from parts so secret scanners do not mistake the fixture for a real key.
    const prefix = ['sk', 'live', ''].join('_');
    const body = 'x'.repeat(43);
    expect(re.test(prefix + body)).toBe(true);
    expect(re.test(`Bearer ${prefix}${body}`)).toBe(false);
    expect(re.test(`${prefix}short`)).toBe(false);
  });

  it('maps the documented endpoints', () => {
    const routes: Record<string, [string, string]> = {
      getyoutubetranscript_get_transcript: ['GET', '/transcript'],
      getyoutubetranscript_list_languages: ['GET', '/transcript/languages'],
      getyoutubetranscript_search: ['GET', '/search'],
      getyoutubetranscript_get_channel_latest: ['GET', '/channel/latest'],
      getyoutubetranscript_list_playlist_videos: ['GET', '/playlist'],
      getyoutubetranscript_get_credits: ['GET', '/credits'],
    };
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(routes).sort());
    for (const [name, [method, path]] of Object.entries(routes)) expect(tool(name).endpointMapping).toMatchObject({ method, path });
  });

  it('passes the documented query parameters', () => {
    expect(tool('getyoutubetranscript_get_transcript').endpointMapping.queryParams).toEqual({ v: '$v', language: '$language', timestamps: '$timestamps', translate: '$translate' });
    expect(tool('getyoutubetranscript_get_transcript').parameters?.required).toEqual(['v']);
    expect(tool('getyoutubetranscript_get_transcript').parameters?.properties?.timestamps.type).toBe('boolean');
    expect(tool('getyoutubetranscript_search').parameters?.properties?.type.enum).toEqual(['video', 'channel']);
    expect(tool('getyoutubetranscript_search').endpointMapping.queryParams).toMatchObject({ q: '$q', page_token: '$page_token' });
    expect(tool('getyoutubetranscript_list_playlist_videos').endpointMapping.queryParams).toEqual({ list: '$list', continuation: '$continuation' });
    expect(tool('getyoutubetranscript_get_channel_latest').parameters?.required).toEqual(['channel']);
  });

  it('every tool is prefixed, every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
    }
  });

  it('is read-only: every tool is a GET and installs enabled', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
    }
  });

  it('probes with the free credits call and documents every tool in the instructions', () => {
    expect(a.probe).toEqual({ tool: 'getyoutubetranscript_get_credits', params: {} });
    expect(a.verifyHints?.['401']).toMatch(/sk_live_/);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const liveOn = process.env.RUN_GETYOUTUBETRANSCRIPT_LIVE === '1';
const live = liveOn ? describe : describe.skip;
live('getyoutubetranscript adapter: live (read-only)', () => {
  const base = 'https://getyoutubetranscript.com/api/v1';

  it('asks for the key when none is sent', async () => {
    const res = await fetch(`${base}/credits`, { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('MISSING_API_KEY');
  }, 30_000);

  (process.env.GETYOUTUBETRANSCRIPT_API_KEY ? it : it.skip)('reads the balance and one transcript', async () => {
    const headers = { Accept: 'application/json', 'x-api-key': process.env.GETYOUTUBETRANSCRIPT_API_KEY as string };
    const credits = await fetch(`${base}/credits`, { headers });
    expect(credits.status).toBe(200);
    const balance = (await credits.json()) as { data: { total_credits_left: number } };
    expect(typeof balance.data.total_credits_left).toBe('number');
    const res = await fetch(`${base}/transcript?${new URLSearchParams({ v: 'jNQXAC9IVRw' })}`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { video_id: string; transcript: string } };
    expect(body.data.video_id).toBe('jNQXAC9IVRw');
    expect(body.data.transcript.length).toBeGreaterThan(0);
  }, 60_000);
});
