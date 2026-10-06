import * as adapter from './mangools.json';

type Tool = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  parameters?: { properties?: Record<string, { default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
};
const a = adapter as unknown as {
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;

describe('mangools adapter: static spec conformance', () => {
  it('api.mangools.com/v3 with the key in x-access-token (not Authorization: Bearer)', () => {
    expect(a.connector.baseUrl).toBe('https://api.mangools.com/v3');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'x-access-token', apiKey: '{{MANGOOLS_API_KEY}}' });
  });

  it('probe needs a valid key (limits answers 200 even without one, so it is not the probe)', () => {
    expect(a.probe.tool).not.toBe('mangools_get_limits');
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
  });

  it('no tool writes: GETs, and POST lookups marked read-only', () => {
    for (const t of a.tools) {
      if (t.endpointMapping.method !== 'GET') expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('LinkMiner required query parameters always have a value', () => {
    const props = tool('mangools_get_backlinks').parameters!.properties!;
    expect(props.source.default).toBe(0);
    expect(props.page.default).toBe(0);
    expect(props.links_per_domain.default).toBe(1);
  });
});
