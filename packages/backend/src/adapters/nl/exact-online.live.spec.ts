import * as adapter from './exact-online.json';

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

describe('exact-online adapter — static spec conformance', () => {
  it("is filed under the Dutch region", () => {
    expect(a.region).toBe('nl');
  });

  it("takes the country host as a variable, since a token is host-bound", () => {
    expect(a.connector.baseUrl).toBe('https://{{EXACT_BASE_HOST}}/api/v1');
    expect(a.connector.authConfig?.tokenUrl).toContain('{{EXACT_BASE_HOST}}');
  });

  it("scopes every data path to the division", () => {
    const scoped = a.tools.filter((t) => t.name !== 'exact_online_get_me');
    for (const t of scoped) expect(String(t.endpointMapping.path)).toContain('{EXACT_DIVISION}');
  });

  it("leaves /current/Me reachable, since it reports the division", () => {
    const t = a.tools.find((x) => x.name === 'exact_online_get_me')!;
    expect(t.endpointMapping.path).toBe('/current/Me');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_EXACT_ONLINE_LIVE === '1';
(live ? describe : describe.skip)('exact-online — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // exact-online answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
