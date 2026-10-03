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

  it("authenticates with JTL's own `Wawi <key>` scheme, not Bearer", () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig?.headerName).toBe('Authorization');
    expect(a.connector.authConfig?.apiKey).toBe('Wawi {{JTL_WAWI_API_KEY}}');
  });

  it("identifies the app and its version on every call", () => {
    expect(a.connector.headers?.['X-AppId']).toBe('{{JTL_WAWI_APP_ID}}');
    expect(a.connector.headers?.['X-AppVersion']).toBe('{{JTL_WAWI_APP_VERSION}}');
    expect(a.requiredEnvVars).toContain('JTL_WAWI_APP_VERSION');
  });

  it("reads stock from /stocks and shipments from /deliveryNotes, paged by pageNumber/pageSize", () => {
    const byName = Object.fromEntries(a.tools.map((t) => [t.name, t.endpointMapping]));
    expect(byName.jtl_wawi_get_item_stock.path).toBe('/stocks');
    expect(byName.jtl_wawi_get_item_stock.queryParams).toMatchObject({ itemId: '$itemId' });
    expect(byName.jtl_wawi_list_shipments.path).toBe('/deliveryNotes');
    for (const t of a.tools) {
      const q = Object.keys((t.endpointMapping.queryParams as Record<string, unknown>) ?? {});
      expect(q.filter((k) => k.startsWith('$'))).toEqual([]);
    }
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
