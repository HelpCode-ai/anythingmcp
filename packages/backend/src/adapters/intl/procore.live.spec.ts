import * as adapterJson from './procore.json';

/**
 * Procore adapter: REST API at api.procore.com, OAuth 2.0 authorization code
 * (login.procore.com), Procore-Company-Id header on company data.
 *
 * Static only: every Procore endpoint needs a user token.
 */

type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, { description?: string }>; required?: string[] };
  endpointMapping: Record<string, any>;
};
const adapter = adapterJson as unknown as {
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => adapter.tools.find((t) => t.name === name)!;

function reaches(t: Tool, param: string): boolean {
  const m = t.endpointMapping;
  if (String(m.path ?? '').includes(`{${param}}`)) return true;
  return Object.values({ ...(m.queryParams ?? {}), ...(m.headers ?? {}) }).includes(`$${param}`);
}

describe('procore adapter (static)', () => {
  it('uses the production API with the authorization-code OAuth flow', () => {
    expect(adapter.connector.baseUrl).toBe('https://api.procore.com');
    expect(adapter.connector.authType).toBe('OAUTH2');
    expect(adapter.connector.authConfig.authorizationUrl).toBe('https://login.procore.com/oauth/authorize');
    expect(adapter.connector.authConfig.tokenUrl).toBe('https://login.procore.com/oauth/token');
  });

  it('every tool is a prefixed, described GET that sends every parameter', () => {
    for (const t of adapter.tools) {
      expect(t.name.startsWith('procore_')).toBe(true);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      expect(t.endpointMapping.method).toBe('GET');
      expect(t.endpointMapping.path.startsWith('/rest/v1.')).toBe(true);
      for (const [p, def] of Object.entries(t.parameters.properties ?? {})) {
        expect(def.description).toBeTruthy();
        expect({ tool: t.name, param: p, reaches: reaches(t, p) }).toEqual({ tool: t.name, param: p, reaches: true });
      }
    }
  });

  it('sends Procore-Company-Id on every company-scoped tool', () => {
    for (const t of adapter.tools) {
      if (['procore_list_companies', 'procore_get_me'].includes(t.name)) continue;
      expect(t.parameters.required).toContain('company_id');
      expect(t.endpointMapping.headers['Procore-Company-Id']).toBe('$company_id');
    }
  });

  it('probe needs no arguments', () => {
    expect(tool(adapter.probe.tool).parameters.required ?? []).toEqual([]);
  });
});
