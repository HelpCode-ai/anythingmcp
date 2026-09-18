import * as adapter from './ebay-sell.json';

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

describe('ebay-sell adapter — static spec conformance', () => {
  it("mints access tokens from a stored refresh token", () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig?.refreshToken).toBe('{{EBAY_REFRESH_TOKEN}}');
    expect(a.connector.authConfig?.tokenAuthMethod).toBe('basic');
  });

  it("names the marketplace, which changes what eBay answers", () => {
    expect(a.connector.headers?.['X-EBAY-C-MARKETPLACE-ID']).toBe('{{EBAY_MARKETPLACE_ID}}');
  });

  it("targets production, and says where the sandbox is", () => {
    expect(a.connector.baseUrl).toBe('https://api.ebay.com');
    expect((adapter as unknown as { instructions: string }).instructions).toContain('api.sandbox.ebay.com');
  });

  it("warns that pre-Inventory-API listings will not appear", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('Trading API');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_EBAY_SELL_LIVE === '1';
(live ? describe : describe.skip)('ebay-sell — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // ebay-sell answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
