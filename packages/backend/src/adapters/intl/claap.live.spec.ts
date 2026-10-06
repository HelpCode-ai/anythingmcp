import * as adapter from './claap.json';

type Tool = {
  name: string;
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
};
const a = adapter as unknown as {
  probe: { tool: string };
  envVarMeta: Record<string, { pattern?: string }>;
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;

describe('claap adapter: static spec conformance', () => {
  it('api.claap.io with the key in X-Claap-Key (the MCP server uses Bearer, the REST API does not)', () => {
    expect(a.connector.baseUrl).toBe('https://api.claap.io');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Claap-Key', apiKey: '{{CLAAP_API_KEY}}' });
  });

  it('keys start with cla_', () => {
    const re = new RegExp(a.envVarMeta.CLAAP_API_KEY.pattern!);
    expect(re.test('cla_abcdefghijkl')).toBe(true);
    expect(re.test('abcdefghijkl')).toBe(false);
  });

  it('read-only: every tool is a GET under /v1', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(t.endpointMapping.path.startsWith('/v1/')).toBe(true);
    }
  });

  it('folder filter maps to the API name channelId', () => {
    expect(tool('claap_list_recordings').endpointMapping.queryParams).toMatchObject({ channelId: '$folder_id', cursor: '$cursor' });
  });

  it('probe is the workspace', () => expect(tool(a.probe.tool).endpointMapping.path).toBe('/v1/workspaces/mine'));
});
