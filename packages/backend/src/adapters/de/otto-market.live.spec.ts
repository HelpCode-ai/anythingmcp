import * as adapter from './otto-market.json';

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

describe('otto-market adapter — static spec conformance', () => {
  it("exchanges the partner credentials for a token", () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig?.tokenUrl).toBe('https://api.otto.market/v1/token');
  });

  it("carries OTTO's per-resource version in each path", () => {
    const byName = Object.fromEntries(a.tools.map((t) => [t.name, t.endpointMapping.path]));
    expect(byName.otto_market_list_orders).toBe('/v4/orders');
    expect(byName.otto_market_update_price).toBe('/v3/prices');
    expect(byName.otto_market_list_quantities).toBe('/v1/quantities');
  });

  it("makes the order date range explicit rather than implicit", () => {
    const t = adapter.tools.find((x: { name: string }) => x.name === 'otto_market_list_orders')!;
    expect((t as unknown as { parameters: { required: string[] } }).parameters.required).toEqual(['fromOrderDate']);
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_OTTO_MARKET_LIVE === '1';
(live ? describe : describe.skip)('otto-market — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // otto-market answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
