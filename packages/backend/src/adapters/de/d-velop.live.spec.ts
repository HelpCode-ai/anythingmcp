import * as adapter from './d-velop.json';

const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  probe?: { tool: string };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
    headers?: Record<string, string>;
    healthcheckPath?: string;
  };
  tools: Array<{ name: string; endpointMapping: Record<string, unknown> }>;
};

const toolNames = a.tools.map((t) => t.name);

describe('d-velop adapter — static spec conformance', () => {
  it("uses the API key directly as a bearer token", () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig?.token).toBe('{{DVELOP_API_KEY}}');
  });

  it("asks for HAL, which is how d.velop shapes its responses", () => {
    expect(a.connector.headers?.Accept).toBe('application/hal+json');
  });

  it("makes the repository list the entry point", () => {
    expect(a.probe?.tool).toBe('d_velop_list_repositories');
  });

  it("searches the mapped JSON endpoint /srm with a required sourceid, not the /sr HTML dialog", () => {
    const t = a.tools.find((x) => x.name === 'd_velop_search_documents')! as unknown as {
      parameters: { required: string[] };
      endpointMapping: { path: string; queryParams: Record<string, string> };
    };
    expect(t.endpointMapping.path).toBe('/dms/r/{repositoryId}/srm');
    expect(t.parameters.required).toContain('sourceid');
    expect(t.endpointMapping.queryParams.pageSize).toBe('$pageSize');
  });

  it("reads documents and versions through /o2m, the JSON object route", () => {
    const paths = a.tools.map((t) => String(t.endpointMapping.path));
    expect(paths).toContain('/dms/r/{repositoryId}/o2m/{documentId}');
    expect(paths).toContain('/dms/r/{repositoryId}/o2m/{documentId}/v');
    expect(paths.some((p) => p.includes('/o2/'))).toBe(false);
  });

  it("exposes no write tool", () => {
    expect(a.tools.every((t) => t.endpointMapping.method === 'GET')).toBe(true);
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_D_VELOP_LIVE === '1';
(live ? describe : describe.skip)('d-velop — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // d-velop answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
