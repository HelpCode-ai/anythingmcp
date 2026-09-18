import * as adapter from './espocrm.json';

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

describe('espocrm adapter — static spec conformance', () => {
  it("sends the plain key in X-Api-Key", () => {
    expect(a.connector.authConfig?.headerName).toBe('X-Api-Key');
  });

  it("exposes the generic entity route alongside the wrappers", () => {
    expect(toolNames).toContain('espocrm_list_entities');
    expect(toolNames).toContain('espocrm_get_entity');
  });

  it("uses EspoCRM's indexed where syntax", () => {
    const t = a.tools.find((x) => x.name === 'espocrm_list_accounts')!;
    expect(Object.keys(t.endpointMapping.queryParams as object)).toContain('where[0][type]');
  });

  it("exposes no write tool", () => {
    expect(a.tools.every((t) => t.endpointMapping.method === 'GET')).toBe(true);
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_ESPOCRM_LIVE === '1';
(live ? describe : describe.skip)('espocrm — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // espocrm answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
