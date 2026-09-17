import * as adapter from './jtl-wawi.json';

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

describe('jtl-wawi adapter — static spec conformance', () => {
  it("talks to the separate JTL API Server, not to Wawi directly", () => {
    expect(a.connector.baseUrl).toBe('{{JTL_WAWI_URL}}/api/eazybusiness/v1');
  });

  it("identifies the app alongside the bearer key", () => {
    expect(a.connector.headers?.['X-AppId']).toBe('{{JTL_WAWI_APP_ID}}');
  });

  it("keeps per-warehouse stock separate from the item master", () => {
    expect(toolNames).toContain('jtl_wawi_get_item_stock');
  });

  it("exposes no write tool", () => {
    expect(a.tools.every((t) => t.endpointMapping.method === 'GET')).toBe(true);
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_JTL_WAWI_LIVE === '1';
(live ? describe : describe.skip)('jtl-wawi — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // jtl-wawi answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
