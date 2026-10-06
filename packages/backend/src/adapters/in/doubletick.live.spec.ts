import * as adapter from './doubletick.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  probe: { tool: string };
  tools: Array<{
    name: string;
    parameters?: { properties?: Record<string, unknown> };
    endpointMapping: { method: string; path: string; queryParams?: Record<string, string>; bodyMapping?: unknown };
    annotations?: Record<string, boolean>;
  }>;
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const refs = (v: unknown, out: Set<string>) => {
  if (typeof v === 'string' && v.startsWith('$')) out.add(v.slice(1));
  else if (Array.isArray(v)) v.forEach((x) => refs(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => refs(x, out));
  return out;
};

describe('doubletick adapter: static spec conformance', () => {
  it('sends the raw key in the Authorization header, without Bearer', () => {
    expect(a.connector.baseUrl).toBe('https://public.doubletick.io');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: '{{DOUBLETICK_API_KEY}}' });
  });

  it('probes with the channel list', () => {
    expect(a.probe.tool).toBe('doubletick_list_channels');
  });

  it('every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = refs([m.queryParams, m.bodyMapping], new Set<string>());
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      for (const p of Object.keys(t.parameters?.properties ?? {})) expect(`${t.name}:${used.has(p)}`).toBe(`${t.name}:true`);
    }
  });

  it('lists templates on /v2/templates with the documented WABA selectors', () => {
    const m = tool('doubletick_list_templates').endpointMapping;
    expect(m.path).toBe('/v2/templates');
    expect(m.queryParams).toMatchObject({ wabaPhoneNumbers: '$waba_phone_numbers', allWabaPhoneNumbers: '$all_waba_phone_numbers' });
  });

  it('wraps a template send in the messages array of the v2 endpoint', () => {
    const m = tool('doubletick_send_template_message').endpointMapping as { path: string; bodyMapping: { messages: unknown[] } };
    expect(m.path).toBe('/v2/whatsapp/message/template');
    expect(Array.isArray(m.bodyMapping.messages)).toBe(true);
  });

  it('every send tool is marked destructive', () => {
    for (const t of a.tools.filter((x) => x.name.startsWith('doubletick_send_'))) {
      expect(`${t.name}:${t.annotations?.destructiveHint}`).toBe(`${t.name}:true`);
    }
  });
});
