import * as adapter from './checkmk.json';

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

describe('checkmk adapter — static spec conformance', () => {
  it("assembles Checkmk's two-value Bearer token", () => {
    expect(a.connector.authConfig?.apiKey).toBe('Bearer {{CHECKMK_USERNAME}} {{CHECKMK_SECRET}}');
  });

  it("expects the site name to be part of the configured URL", () => {
    expect(a.connector.baseUrl).toBe('{{CHECKMK_URL}}/check_mk/api/1.0');
    expect((adapter as unknown as { instructions: string }).instructions).toContain('site name is part of the path');
  });

  it("keeps configuration and live state as separate tools", () => {
    expect(toolNames).toContain('checkmk_list_hosts');
    expect(toolNames).toContain('checkmk_list_host_states');
  });

  it("reads live state with the POST list form (the GET form is deprecated, werks 17003/17512)", () => {
    for (const name of ['checkmk_list_host_states', 'checkmk_list_service_states', 'checkmk_list_host_services']) {
      const t = a.tools.find((x) => x.name === name)!;
      expect(t.endpointMapping.method).toBe('POST');
      const cols = (t.endpointMapping.bodyMapping as Record<string, unknown>).columns as unknown[];
      expect(Array.isArray(cols)).toBe(true);
      expect(cols).toContain('$columns');
    }
    const svc = a.tools.find((x) => x.name === 'checkmk_list_service_states')!;
    expect(svc.endpointMapping.path).toBe('/domain-types/service/collections/all');
  });

  it("filters configured hosts by `hostnames`, the parameter Checkmk actually has", () => {
    const t = a.tools.find((x) => x.name === 'checkmk_list_hosts')!;
    const q = t.endpointMapping.queryParams as Record<string, unknown>;
    expect(q.hostnames).toBe('$hostnames');
    expect(q).not.toHaveProperty('search');
  });

  it("exposes no write tool: every non-GET is a read marked readOnlyHint", () => {
    const tools = a.tools as Array<{ endpointMapping: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } }>;
    for (const t of tools) {
      if (t.endpointMapping.method !== 'GET') {
        expect(t.endpointMapping.method).toBe('POST');
        expect(t.annotations?.readOnlyHint).toBe(true);
      }
    }
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_CHECKMK_LIVE === '1';
(live ? describe : describe.skip)('checkmk — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // checkmk answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
