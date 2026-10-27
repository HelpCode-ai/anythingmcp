import * as adapter from './bex-express.json';

/**
 * BEX Express (bexexpress.rs/DevDocumentation): X-AUTH-TOKEN header, lookups and
 * tracking on integrations.bexexpress.rs, shipments on api.bex.rs:62503.
 * Live part: BEX_API_TOKEN=... RUN_BEX_LIVE=1 npx jest src/adapters/intl/bex-express
 * (reads only: municipalities, places, streets, parcel shops).
 */

type Tool = {
  name: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; bodyEncoding?: string };
  annotations?: { readOnlyHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string' && v.startsWith('$')) out.add(v.slice(1));
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  return out;
};
const PREFIX = 'bex_express_';
const WRITES: string[] = ["bex_express_create_shipments", "bex_express_cancel_shipment"];

describe('bex-express adapter: static spec conformance', () => {
  it('sends the key in X-AUTH-TOKEN to integrations.bexexpress.rs/api', () => {
    expect(a.requiredEnvVars).toEqual(['BEX_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://integrations.bexexpress.rs/api');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-AUTH-TOKEN', apiKey: '{{BEX_API_TOKEN}}' });
    expect(a.envVarMeta.BEX_API_TOKEN.secret).toBe(true);
    expect(a.category).toBe('logistics');
  });

  it('maps the documented methods and hosts', () => {
    const SHIP = 'https://api.bex.rs:62503/ship/api/Ship';
    expect(tool('bex_express_get_shipment_history').endpointMapping).toMatchObject({ method: 'GET', path: '/Shipments/shipmentHistory', queryParams: { trackingValue: '$shipment_number' } });
    expect(tool('bex_express_get_label').endpointMapping).toMatchObject({ method: 'GET', path: '/Shipments/getLabelWithProperties', queryParams: { shipmentId: '$shipment_id', pageSize: '$page_size', pagePosition: '$page_position', parcelNo: '$parcel_no' } });
    expect(tool('bex_express_list_municipalities').endpointMapping.path).toBe('/Addresses/Municipalities');
    expect(tool('bex_express_list_settlements').endpointMapping.queryParams).toEqual({ municipalityId: '$municipality_id' });
    expect(tool('bex_express_list_streets').endpointMapping.queryParams).toEqual({ settlementId: '$settlement_id' });
    expect(tool('bex_express_list_parcel_shops').endpointMapping).toMatchObject({ method: 'POST', path: `${SHIP}/listParcelShop`, bodyMapping: { regionId: '$region_id' } });
    expect(tool('bex_express_create_shipments').endpointMapping).toMatchObject({ method: 'POST', path: `${SHIP}/postShipments`, bodyMapping: { shipmentslist: '$shipments' } });
    expect(tool('bex_express_cancel_shipment').endpointMapping).toMatchObject({ method: 'POST', path: `${SHIP}/deleteShipments`, bodyMapping: { shipmentid: '$shipment_id', mtype: 1, lang: 1 } });
  });

  it('never asks for every place or street of Serbia (id 0 answers about 7 MB)', () => {
    expect((tool('bex_express_list_settlements').parameters?.properties?.municipality_id as { minimum: number }).minimum).toBe(1);
    expect((tool('bex_express_list_streets').parameters?.properties?.settlement_id as { minimum: number }).minimum).toBe(1);
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('writes are installed switched off and annotated; reads are not switched off', () => {
    const writes = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(writes).toEqual([...WRITES].sort());
    for (const t of a.tools) {
      if (WRITES.includes(t.name)) expect(t.annotations?.readOnlyHint).toBe(false);
      else {
        expect(t.enabled).toBeUndefined();
        if (t.endpointMapping.method !== 'GET') expect(t.annotations?.readOnlyHint).toBe(true);
      }
    }
  });


  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(WRITES).not.toContain(a.probe.tool);
    tool(a.probe.tool);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).not.toMatch(/—/);
  });
});

const live = process.env.RUN_BEX_LIVE === '1' && process.env.BEX_API_TOKEN ? describe : describe.skip;
live('bex-express adapter: live (read-only)', () => {
  const headers = { 'X-AUTH-TOKEN': process.env.BEX_API_TOKEN as string, Accept: 'application/json' };
  it('lists municipalities, places and streets', async () => {
    const m = (await (await fetch(`${a.connector.baseUrl}/Addresses/Municipalities`, { headers })).json()) as Array<{ id: number }>;
    expect(m.length).toBeGreaterThan(100);
    let places: Array<{ id: number }> = [];
    for (const x of m.slice(1, 6)) {
      places = (await (await fetch(`${a.connector.baseUrl}/Addresses/Settlements?municipalityId=${x.id}`, { headers })).json()) as Array<{ id: number }>;
      if (places.length) break;
    }
    expect(places.length).toBeGreaterThan(0);
    const streets = (await (await fetch(`${a.connector.baseUrl}/Addresses/Streets?settlementId=${places[0].id}`, { headers })).json()) as unknown[];
    expect(Array.isArray(streets)).toBe(true);
  }, 60_000);
});
