import * as adapter from './uzum-market.json';

type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: Record<string, unknown> & { method: string; path: string };
  annotations?: Record<string, boolean>;
};
const a = adapter as unknown as {
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;

/**
 * Static checks only: the Uzum seller OpenAPI has no keyless endpoint, so
 * there is no live part.
 */
describe('uzum-market adapter: static spec conformance', () => {
  it('seller OpenAPI base URL, token in Authorization without Bearer', () => {
    expect(a.connector.baseUrl).toBe('https://api-seller.uzum.uz/api/seller-openapi');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('Authorization');
    expect(a.connector.authConfig.apiKey).toBe('{{UZUM_API_TOKEN}}');
  });

  it('probes with the shop list, which needs no arguments', () => {
    expect(a.probe.tool).toBe('uzum_market_list_shops');
    expect(tool('uzum_market_list_shops').parameters.required ?? []).toEqual([]);
  });

  it('uses the current versions of the order and stock endpoints', () => {
    expect(tool('uzum_market_list_orders').endpointMapping.path).toBe('/v2/fbs/orders');
    expect(tool('uzum_market_list_stocks').endpointMapping.path).toBe('/v3/fbs/sku/stocks');
    expect(tool('uzum_market_update_stocks').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/v2/fbs/sku/stocks',
      bodyMapping: { skuAmountList: '$items' },
    });
  });

  it('every tool is prefixed and every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('uzum_market_')).toBe(true);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      const mapping = JSON.stringify(t.endpointMapping);
      for (const p of Object.keys(t.parameters.properties ?? {})) {
        expect(`${t.name}:${mapping.includes(`$${p}"`) || mapping.includes(`{${p}}`)}`).toBe(`${t.name}:true`);
      }
    }
  });

  it('reads are GETs; cancelling, stock and price updates are destructive', () => {
    const writes = new Set([
      'uzum_market_confirm_order',
      'uzum_market_cancel_order',
      'uzum_market_update_stocks',
      'uzum_market_update_prices',
    ]);
    for (const t of a.tools) {
      if (!writes.has(t.name)) expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
    }
    for (const name of ['uzum_market_cancel_order', 'uzum_market_update_stocks', 'uzum_market_update_prices']) {
      expect(tool(name).annotations?.destructiveHint).toBe(true);
    }
  });
});
