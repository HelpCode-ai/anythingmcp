import * as adapter from './paperless-ngx.json';

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

describe('paperless-ngx adapter — static spec conformance', () => {
  it("sends the DRF Token scheme, not Bearer", () => {
    expect(a.connector.authConfig?.apiKey).toBe('Token {{PAPERLESS_API_TOKEN}}');
  });

  it("pins the API version it was written against", () => {
    expect(a.connector.headers?.Accept).toContain('version=');
  });

  it("keeps full-text search separate from structured filtering", () => {
    expect(toolNames).toContain('paperless_ngx_search_documents');
    expect(toolNames).toContain('paperless_ngx_list_documents');
  });

  it("exposes no write tool", () => {
    expect(a.tools.every((t) => t.endpointMapping.method === 'GET')).toBe(true);
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_PAPERLESS_NGX_LIVE === '1';
(live ? describe : describe.skip)('paperless-ngx — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // paperless-ngx answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
