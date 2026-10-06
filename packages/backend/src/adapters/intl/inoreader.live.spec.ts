import * as adapter from './inoreader.json';
type Tool = {
  name: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: unknown;
    bodyTemplate?: string;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, boolean>;
};
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string> };
  probe: { tool: string; params?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const refs = (v: unknown, out: Set<string>) => {
  if (typeof v === 'string') {
    if (/^\$\w+$/.test(v)) out.add(v.slice(1));
    for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
  } else if (v && typeof v === 'object') for (const x of Object.values(v)) refs(x, out);
};

describe('inoreader adapter: static spec conformance', () => {
  it('uses OAuth 2.0 against the reader API and also sends AppId and AppKey', () => {
    expect(a.connector.baseUrl).toBe('https://www.inoreader.com/reader/api/0');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toMatchObject({
      clientId: '{{INOREADER_APP_ID}}',
      clientSecret: '{{INOREADER_APP_KEY}}',
      authorizationUrl: 'https://www.inoreader.com/oauth2/auth',
      tokenUrl: 'https://www.inoreader.com/oauth2/token',
      scopes: 'read write',
      extraHeaders: { AppId: '{{INOREADER_APP_ID}}', AppKey: '{{INOREADER_APP_KEY}}' },
    });
  });

  it('stream contents encodes the stream id in the path; item ids sends it as s', () => {
    expect(tool('inoreader_get_stream_contents').endpointMapping).toMatchObject({ path: '/stream/contents/{stream_id}', encodePathParams: true });
    expect(tool('inoreader_list_item_ids').endpointMapping.queryParams).toMatchObject({ s: '$stream_id', output: 'json' });
  });

  it('edit-tag sends i, a and r; mark-all-as-read is destructive', () => {
    expect(tool('inoreader_edit_item_tags').endpointMapping).toMatchObject({ method: 'POST', path: '/edit-tag', queryParams: { i: '$item_ids', a: '$add', r: '$remove' } });
    expect(tool('inoreader_mark_all_as_read').annotations?.destructiveHint).toBe(true);
  });

  it('writes are only the two zone 2 calls', () => {
    expect(a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name).sort()).toEqual(['inoreader_edit_item_tags', 'inoreader_mark_all_as_read']);
  });

  it('every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = new Set<string>();
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      refs(m.queryParams, used);
      refs(m.bodyMapping, used);
      refs(m.headers, used);
      if (m.bodyTemplate) refs(m.bodyTemplate, used);
      for (const p of Object.keys(t.parameters?.properties ?? {})) expect(`${t.name}:${p}:${used.has(p)}`).toBe(`${t.name}:${p}:true`);
    }
  });

  it('tool names carry the adapter prefix and are unique', () => {
    const names = a.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n.startsWith('inoreader_')).toBe(true);
  });
});
