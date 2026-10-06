import * as adapter from './wildberries.json';

type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: Record<string, unknown> & { method: string; path: string };
  annotations?: Record<string, boolean>;
};
const a = adapter as unknown as {
  slug: string;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;

/**
 * Static checks only: the WB API has no keyless endpoint, so there is no
 * live part. Verified against a seller account with
 * scripts/ops/verify-adapter-with-connector.mjs instead.
 */
describe('wildberries adapter: static spec conformance', () => {
  it('marketplace host as base URL, token in Authorization without Bearer', () => {
    expect(a.connector.baseUrl).toBe('https://marketplace-api.wildberries.ru');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('Authorization');
    expect(a.connector.authConfig.apiKey).toBe('{{WILDBERRIES_API_TOKEN}}');
  });

  it('the probe is the cheap common-api ping', () => {
    expect(a.probe.tool).toBe('wildberries_ping');
    expect(tool('wildberries_ping').endpointMapping.path).toBe('https://common-api.wildberries.ru/ping');
  });

  it('every absolute path points at an official wildberries.ru API host', () => {
    for (const t of a.tools) {
      const p = t.endpointMapping.path;
      if (/^https?:\/\//.test(p)) {
        expect(new URL(p).hostname).toMatch(/^[a-z-]+-api\.wildberries\.ru$/);
      }
    }
  });

  it('each tool is called on the host of its token category', () => {
    expect(tool('wildberries_list_statistics_orders').endpointMapping.path).toBe(
      'https://statistics-api.wildberries.ru/api/v1/supplier/orders',
    );
    expect(tool('wildberries_list_product_cards').endpointMapping.path).toMatch(/^https:\/\/content-api\./);
    expect(tool('wildberries_list_prices').endpointMapping.path).toMatch(/^https:\/\/discounts-prices-api\./);
    expect(tool('wildberries_get_sales_report_detail').endpointMapping.path).toMatch(/^https:\/\/finance-api\./);
    expect(tool('wildberries_list_new_orders').endpointMapping.path).toBe('/api/v3/orders/new');
  });

  it('switched-off endpoints are not used', () => {
    const paths = a.tools.map((t) => t.endpointMapping.path).join(' ');
    expect(paths).not.toContain('/api/v1/supplier/stocks');
    expect(paths).not.toContain('reportDetailByPeriod');
  });

  it('every tool is prefixed and every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('wildberries_')).toBe(true);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      const mapping = JSON.stringify(t.endpointMapping);
      for (const p of Object.keys(t.parameters.properties ?? {})) {
        expect(`${t.name}:${mapping.includes(`$${p}"`) || mapping.includes(`{${p}}`)}`).toBe(`${t.name}:true`);
      }
    }
  });

  it('POST reads are read-only, stock and price updates are destructive', () => {
    for (const name of [
      'wildberries_get_order_statuses',
      'wildberries_get_stocks',
      'wildberries_get_wb_warehouse_stocks',
      'wildberries_get_sales_report_detail',
      'wildberries_list_product_cards',
    ]) {
      expect(tool(name).endpointMapping.method).toBe('POST');
      expect(tool(name).annotations?.readOnlyHint).toBe(true);
    }
    expect(tool('wildberries_update_stocks').endpointMapping.method).toBe('PUT');
    expect(tool('wildberries_update_stocks').annotations?.destructiveHint).toBe(true);
    expect(tool('wildberries_set_prices').annotations?.destructiveHint).toBe(true);
  });

  it('stock bodies use size ids (chrtIds), not the old sku barcodes', () => {
    expect(tool('wildberries_get_stocks').endpointMapping.bodyMapping).toEqual({ chrtIds: '$chrt_ids' });
    expect(tool('wildberries_update_stocks').endpointMapping.bodyMapping).toEqual({ stocks: '$stocks' });
  });
});
