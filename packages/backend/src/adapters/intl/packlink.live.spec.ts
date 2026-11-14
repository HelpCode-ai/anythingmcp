import * as adapter from './packlink.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Packlink PRO API (base https://api.packlink.com/v1, the API key from
 * Settings > Packlink PRO API key sent as the raw Authorization header).
 * Packlink publishes no public API reference; the endpoints follow Packlink's
 * own Apache-2.0 plugin core, github.com/packlink-dev/ecommerce_module_core:
 * src/BusinessLogic/Http/Proxy.php (paths and methods),
 * src/BusinessLogic/Http/DTO/ShippingServiceSearch.php (quote query keys),
 * src/BusinessLogic/Http/DTO/Draft.php, Draft/Address.php and Package.php (draft body),
 * tests/BusinessLogic/Common/ApiResponses/*.json (response shapes).
 * Live part (reads only: account, warehouses, parcel presets, a quote from the
 * default warehouse, a service and a postal code; a shipment, its labels and
 * tracking when PACKLINK_TEST_REFERENCE is set):
 *   PACKLINK_API_KEY=... RUN_PACKLINK_LIVE=1 npx jest src/adapters/intl/packlink
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { type?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
const PREFIX = 'packlink_';

describe('packlink adapter: static spec conformance', () => {
  it('sends the API key as the raw Authorization header to api.packlink.com/v1', () => {
    expect(a.requiredEnvVars).toEqual(['PACKLINK_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.packlink.com/v1');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: '{{PACKLINK_API_KEY}}' });
    expect(a.envVarMeta?.PACKLINK_API_KEY.secret).toBe(true);
    expect(a.connector.healthcheckPath).toBe('/clients');
  });

  it('maps the account, warehouse, parcel, service, drop-off and postal code endpoints of the plugin core', () => {
    expect(tool('packlink_get_account').endpointMapping).toEqual({ method: 'GET', path: '/clients' });
    expect(tool('packlink_list_warehouses').endpointMapping).toEqual({ method: 'GET', path: '/clients/warehouses' });
    expect(tool('packlink_list_parcel_presets').endpointMapping).toEqual({ method: 'GET', path: '/users/parcels' });
    expect(tool('packlink_search_services').endpointMapping).toEqual({
      method: 'GET',
      path: '/services',
      queryParams: {
        'from[country]': '$from_country',
        'from[zip]': '$from_zip',
        'to[country]': '$to_country',
        'to[zip]': '$to_zip',
        'packages[0][weight]': '$weight',
        'packages[0][length]': '$length',
        'packages[0][width]': '$width',
        'packages[0][height]': '$height',
        source: 'PRO',
      },
    });
    expect(tool('packlink_search_services').annotations?.readOnlyHint).toBe(true);
    expect(tool('packlink_get_service').endpointMapping).toEqual({ method: 'GET', path: '/services/available/{service_id}/details' });
    expect(tool('packlink_list_dropoffs').endpointMapping).toEqual({ method: 'GET', path: '/dropoffs/{service_id}/{country}/{zip}' });
    expect(tool('packlink_get_postal_codes').endpointMapping).toEqual({ method: 'GET', path: '/locations/postalcodes/{country}/{zip}' });
  });

  it('maps the shipment endpoints and the draft body with the field names of Draft.php', () => {
    expect(tool('packlink_get_shipment').endpointMapping).toEqual({ method: 'GET', path: '/shipments/{reference}' });
    expect(tool('packlink_get_shipment_labels').endpointMapping).toEqual({ method: 'GET', path: '/shipments/{reference}/labels' });
    expect(tool('packlink_get_shipment_tracking').endpointMapping).toEqual({ method: 'GET', path: '/shipments/{reference}/track' });
    const draft = tool('packlink_create_draft_shipment');
    expect(draft.endpointMapping).toEqual({
      method: 'POST',
      path: '/shipments',
      bodyMapping: {
        from: '$from',
        to: '$to',
        packages: '$packages',
        service_id: '$service_id',
        dropoff_point_id: '$dropoff_point_id',
        content: '$content',
        contentvalue: '$content_value',
        contentValue_currency: '$currency',
        content_second_hand: '$second_hand',
        shipment_custom_reference: '$custom_reference',
      },
    });
    const addr = (draft.parameters?.properties?.from as unknown as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(addr).sort()).toEqual(['city', 'company', 'country', 'email', 'name', 'phone', 'street1', 'street2', 'surname', 'zip_code']);
    expect(draft.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('drops the collection-date calendar from quotes and keeps prices', () => {
    const out = applyResponseTransform(
      [{ id: 20615, carrier_name: 'UPS', price: { total_price: 10.13 }, available_dates: { '2019/01/02': '[09:00 , 18:00]' }, url_terms_and_conditions: null }],
      tool('packlink_search_services').responseMapping as never,
    ).value;
    expect(out).toEqual([{ id: 20615, carrier_name: 'UPS', price: { total_price: 10.13 } }]);
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('has a single write (the draft), no paid orders, deletes or webhooks', () => {
    const writes = a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name);
    expect(writes).toEqual(['packlink_create_draft_shipment']);
    for (const t of a.tools) {
      expect(t.endpointMapping.path).not.toMatch(/orders|callback|integrations|register|api\/keys/);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_PACKLINK_LIVE === '1' && process.env.PACKLINK_API_KEY ? describe : describe.skip;
live('packlink adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, {
      headers: { Authorization: String(process.env.PACKLINK_API_KEY), Accept: 'application/json' },
    });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return (await res.json()) as unknown;
  };
  it('reads the account, warehouses, parcel presets, a quote, a service and a postal code', async () => {
    expect(await get('/clients')).toHaveProperty('email');
    const warehouses = (await get('/clients/warehouses')) as Array<{ country: string; postal_code: string; default_selection: boolean }>;
    expect(Array.isArray(warehouses)).toBe(true);
    expect(Array.isArray(await get('/users/parcels'))).toBe(true);
    const wh = warehouses.find((w) => w.default_selection) ?? warehouses[0];
    if (!wh) return;
    const q = new URLSearchParams({
      'from[country]': wh.country,
      'from[zip]': wh.postal_code,
      'to[country]': wh.country,
      'to[zip]': wh.postal_code,
      'packages[0][weight]': '1',
      'packages[0][length]': '20',
      'packages[0][width]': '15',
      'packages[0][height]': '10',
      source: 'PRO',
    });
    const services = (await get(`/services?${q.toString()}`)) as Array<{ id: number; price: { total_price: number } }>;
    expect(Array.isArray(services)).toBe(true);
    if (services[0]) expect(await get(`/services/available/${services[0].id}/details`)).toHaveProperty('carrier_name');
    expect(Array.isArray(await get(`/locations/postalcodes/${wh.country}/${encodeURIComponent(wh.postal_code)}`))).toBe(true);
  }, 60_000);

  const ref = process.env.PACKLINK_TEST_REFERENCE;
  (ref ? it : it.skip)('reads a shipment, its labels and its tracking', async () => {
    expect(await get(`/shipments/${ref}`)).toHaveProperty('state');
    await get(`/shipments/${ref}/labels`);
    await get(`/shipments/${ref}/track`);
  }, 60_000);
});
