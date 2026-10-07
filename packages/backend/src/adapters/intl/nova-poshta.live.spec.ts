import * as adapter from './nova-poshta.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

type Tool = {
  name: string;
  parameters: { properties?: Record<string, { default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyTemplate: string };
  annotations?: { readOnlyHint?: boolean };
};

const a = adapter as unknown as {
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { baseUrl: string; authType: string };
  tools: Tool[];
};
const byName = Object.fromEntries(a.tools.map((tool) => [tool.name, tool]));

/** The model and method a tool calls, read from its body template. */
function call(tool: Tool): { modelName: string; calledMethod: string; apiKey: string } {
  const sample = tool.endpointMapping.bodyTemplate.replace('${documents}', '[]');
  return JSON.parse(sample);
}

describe('Nova Poshta adapter — static contract', () => {
  it('posts every call to the single JSON endpoint, with the key optional', () => {
    expect(a.connector.baseUrl).toBe('https://api.novaposhta.ua/v2.0');
    expect(a.connector.authType).toBe('NONE');
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.optionalEnvVars).toEqual(['NOVA_POSHTA_API_KEY']);
    for (const tool of a.tools) {
      expect(tool.endpointMapping.method).toBe('POST');
      // Without the trailing slash Nova Poshta answers 301, which drops a POST body.
      expect(tool.endpointMapping.path).toBe('/json/');
      // Quoted, so an unset key renders as "" and the keyless methods still work.
      expect(call(tool).apiKey).toBe('${NOVA_POSHTA_API_KEY}');
      // Every method here only reads; POST is just the transport.
      expect(tool.annotations).toEqual({ readOnlyHint: true });
    }
  });

  it('maps each tool to the documented model and method', () => {
    const methods = Object.fromEntries(
      a.tools.map((tool) => [tool.name, `${call(tool).modelName}.${call(tool).calledMethod}`]),
    );
    expect(methods).toEqual({
      nova_poshta_track_parcels: 'TrackingDocument.getStatusDocuments',
      nova_poshta_search_settlements: 'Address.searchSettlements',
      nova_poshta_list_warehouses: 'Address.getWarehouses',
      nova_poshta_list_warehouse_types: 'Address.getWarehouseTypes',
      nova_poshta_get_delivery_price: 'InternetDocument.getDocumentPrice',
      nova_poshta_get_delivery_date: 'InternetDocument.getDocumentDeliveryDate',
      nova_poshta_list_shipments: 'InternetDocument.getDocumentList',
    });
    expect(a.tools.every((tool) => tool.name.startsWith('nova_poshta_'))).toBe(true);
  });

  it('passes tracking documents as a JSON array and pages with defaults', () => {
    expect(byName.nova_poshta_track_parcels.endpointMapping.bodyTemplate).toContain('"Documents":${documents}');
    expect(byName.nova_poshta_track_parcels.parameters.required).toEqual(['documents']);
    expect(byName.nova_poshta_search_settlements.parameters.properties?.limit.default).toBe(20);
    expect(byName.nova_poshta_list_warehouses.parameters.properties?.limit.default).toBe(50);
    expect(byName.nova_poshta_list_shipments.parameters.required).toEqual(['date_from', 'date_to']);
    expect(a.probe).toEqual({ tool: 'nova_poshta_search_settlements', params: { city_name: 'Київ', limit: 1 } });
  });
});

// Opt-in: RUN_NOVA_POSHTA_LIVE=1. Uses only methods that work without a key.
const live = process.env.RUN_NOVA_POSHTA_LIVE === '1';
(live ? describe : describe.skip)('Nova Poshta — live keyless calls through the REST engine', () => {
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  const config = { baseUrl: a.connector.baseUrl, authType: 'NONE' };
  const run = (name: string, params: Record<string, unknown>) => {
    const tool = byName[name];
    const defaults = Object.fromEntries(
      Object.entries(tool.parameters.properties ?? {})
        .filter(([, p]) => p.default !== undefined)
        .map(([k, p]) => [k, p.default]),
    );
    return engine.execute(config, tool.endpointMapping, { ...defaults, ...params }) as Promise<{
      success: boolean;
      data: Array<Record<string, any>>;
      errors: string[];
    }>;
  };

  it('finds Kyiv and returns its DeliveryCity reference', async () => {
    const out = await run('nova_poshta_search_settlements', { city_name: 'Київ', limit: 1 });
    expect(out.success).toBe(true);
    expect(out.data[0].Addresses[0].DeliveryCity).toBe('8d5a980d-391c-11dd-90d9-001a92567626');
  }, 30000);

  it('reports an unknown waybill as "number not found" (StatusCode 3), not as an error', async () => {
    const out = await run('nova_poshta_track_parcels', { documents: [{ DocumentNumber: '20400048799000' }] });
    expect(out.success).toBe(true);
    expect(out.data[0].StatusCode).toBe('3');
  }, 30000);

  it('lists Kyiv branches and prices a parcel to Lviv', async () => {
    const branches = await run('nova_poshta_list_warehouses', { city_ref: '8d5a980d-391c-11dd-90d9-001a92567626', limit: 2 });
    expect(branches.success).toBe(true);
    expect(branches.data.length).toBe(2);

    const price = await run('nova_poshta_get_delivery_price', {
      city_sender: '8d5a980d-391c-11dd-90d9-001a92567626',
      city_recipient: 'db5c88f5-391c-11dd-90d9-001a92567626',
      weight: 1,
      cost: 500,
    });
    expect(price.success).toBe(true);
    expect(typeof price.data[0].Cost).toBe('number');
  }, 30000);

  it('answers HTTP 200 with success:false when listing shipments without a key', async () => {
    const out = await run('nova_poshta_list_shipments', { date_from: '01.10.2026', date_to: '07.10.2026' });
    expect(out.success).toBe(false);
    expect(out.errors.length).toBeGreaterThan(0);
  }, 30000);
});
