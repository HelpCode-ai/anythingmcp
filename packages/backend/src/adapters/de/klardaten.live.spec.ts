import * as adapter from './klardaten.json';

type Tool = {
  name: string;
  enabled?: boolean;
  parameters: { properties: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
};
const a = adapter as unknown as {
  requiredEnvVars: string[];
  instructions: string;
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
  };
  probe: { tool: string };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;

describe('klardaten adapter: static spec conformance', () => {
  it('api.klardaten.com with a Bearer API key', () => {
    expect(a.connector.baseUrl).toBe('https://api.klardaten.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{KLARDATEN_API_KEY}}');
  });

  it('sends the DATEV instance id on every request (required by the DATEV endpoints)', () => {
    expect(a.connector.headers['x-client-instance-id']).toBe('{{KLARDATEN_INSTANCE_ID}}');
    expect(a.requiredEnvVars).toEqual(['KLARDATEN_API_KEY', 'KLARDATEN_INSTANCE_ID']);
  });

  it('warns that the data is client tax and payroll data', () => {
    expect(a.instructions).toMatch(/Sensitive data/);
    expect(a.instructions).toMatch(/servers whose users are allowed to see/);
  });

  it('every tool is a GET except the read-only document search', () => {
    for (const t of a.tools) {
      if (t.name === 'klardaten_search_documents') {
        expect(t.endpointMapping.method).toBe('POST');
        expect(t.enabled).toBe(false);
      } else {
        expect(t.endpointMapping.method).toBe('GET');
      }
    }
  });

  it('monitoring reads the configured instance from the path', () => {
    expect(tool('klardaten_get_datevconnect_health').endpointMapping.path).toBe(
      '/api/monitoring/instance/{{KLARDATEN_INSTANCE_ID}}/datev-connect-health',
    );
  });

  it('the DATEVconnect passthrough forwards its query string verbatim', () => {
    const t = tool('klardaten_datevconnect_get');
    expect(t.endpointMapping.path).toBe('/datevconnect/{path}');
    expect(t.endpointMapping.queryParams).toEqual({ __rawquery: '$query' });
  });

  it('every path placeholder is a declared required parameter', () => {
    for (const t of a.tools) {
      const placeholders = [...t.endpointMapping.path.matchAll(/(?<!\{)\{([a-z_]+)\}(?!\})/g)].map((m) => m[1]);
      for (const p of placeholders) {
        expect(t.parameters.required ?? []).toContain(p);
      }
    }
  });

  it('probe is a cheap list call', () => expect(a.probe.tool).toBe('klardaten_list_clients'));
});
