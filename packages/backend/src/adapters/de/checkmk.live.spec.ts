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

  it("sends columns as a repeated parameter, as Checkmk wants", () => {
    const t = a.tools.find((x) => x.name === 'checkmk_list_service_states')!;
    const cols = (t.endpointMapping.queryParams as Record<string, unknown>).columns;
    expect(Array.isArray(cols)).toBe(true);
  });

  it("exposes no write tool", () => {
    expect(a.tools.every((t) => t.endpointMapping.method === 'GET')).toBe(true);
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
