import * as adapterJson from './sage-200.json';

/**
 * Sage 200 adapter: Sage 200 API on api.columbus.sage.com, Sage ID OAuth 2.0
 * (authorization code), X-Site / X-Company headers per call and the API
 * subscription key on every request.
 *
 * Static only: every endpoint needs a Sage ID token and client credentials
 * that Sage issues on request.
 */

type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, { description?: string }>; required?: string[] };
  endpointMapping: Record<string, any>;
};
const adapter = adapterJson as unknown as {
  probe: { tool: string };
  prerequisites: string;
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => adapter.tools.find((t) => t.name === name)!;

function reaches(t: Tool, param: string): boolean {
  const m = t.endpointMapping;
  if (String(m.path ?? '').includes(`{${param}}`)) return true;
  return Object.values({ ...(m.queryParams ?? {}), ...(m.headers ?? {}) }).includes(`$${param}`);
}

describe('sage-200 adapter (static)', () => {
  it('targets the Sage 200 API with Sage ID OAuth and the subscription key', () => {
    expect(adapter.connector.baseUrl).toBe('https://api.columbus.sage.com/uk/{{SAGE200_PRODUCT}}/accounts/v1');
    expect(adapter.connector.authType).toBe('OAUTH2');
    expect(adapter.connector.authConfig.authorizationUrl).toBe('https://id.sage.com/authorize?audience=s200ukipd/sage200');
    expect(adapter.connector.authConfig.tokenUrl).toBe('https://id.sage.com/oauth/token');
    expect(adapter.connector.authConfig.scopes).toContain('offline_access');
    expect(adapter.connector.headers['Ocp-Apim-Subscription-Key']).toBe('{{SAGE200_SUBSCRIPTION_KEY}}');
  });

  it('says that Sage issues the client credentials', () => {
    expect(adapter.prerequisites).toMatch(/developers\.programme@sage\.com/);
  });

  it('every tool is a prefixed, described GET that sends every parameter', () => {
    for (const t of adapter.tools) {
      expect(t.name.startsWith('sage_200_')).toBe(true);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      expect(t.endpointMapping.method).toBe('GET');
      for (const [p, def] of Object.entries(t.parameters.properties ?? {})) {
        expect(def.description).toBeTruthy();
        expect({ tool: t.name, param: p, reaches: reaches(t, p) }).toEqual({ tool: t.name, param: p, reaches: true });
      }
    }
  });

  it('sends X-Site and X-Company on everything but the site list', () => {
    for (const t of adapter.tools) {
      if (t.name === 'sage_200_list_sites') continue;
      expect(t.parameters.required).toEqual(expect.arrayContaining(['site_id', 'company_id']));
      expect(t.endpointMapping.headers).toEqual({ 'X-Site': '$site_id', 'X-Company': '$company_id' });
    }
  });

  it('probe lists sites without arguments', () => {
    expect(adapter.probe.tool).toBe('sage_200_list_sites');
    expect(tool('sage_200_list_sites').parameters.required ?? []).toEqual([]);
  });
});
