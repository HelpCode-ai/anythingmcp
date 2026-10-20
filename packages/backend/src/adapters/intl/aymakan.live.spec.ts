import * as adapter from './aymakan.json';

/**
 * Aymakan API v2 (developer.aymakan.com.sa/docs/aymakan-v2): the API key goes as is
 * in Authorization, Accept: application/json is required for JSON answers.
 * Live part: AYMAKAN_API_KEY=... RUN_AYMAKAN_LIVE=1 npx jest src/adapters/intl/aymakan
 * (reads only: ping and the city list).
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
const PREFIX = 'aymakan_';
const WRITES: string[] = ["aymakan_create_shipment", "aymakan_cancel_shipment", "aymakan_create_pickup_request", "aymakan_cancel_pickup_request"];
// Tool names of the customers' own connectors for this API on the Cloud (read 19 Oct 2026).
const HAND_BUILT = ["aymakan_shipments_by_reference", "aymakan_track_shipments"];

describe('aymakan adapter: static spec conformance', () => {
  it('sends the raw key in Authorization to api.aymakan.net/v2 and always asks for JSON', () => {
    expect(a.requiredEnvVars).toEqual(['AYMAKAN_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.aymakan.net/v2');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: '{{AYMAKAN_API_KEY}}' });
    expect(a.connector.headers?.Accept).toBe('application/json');
    expect(a.probe.tool).toBe('aymakan_ping');
  });

  it('maps the documented v2 endpoints', () => {
    const paths: Record<string, string> = {
      aymakan_ping: 'GET /ping',
      aymakan_get_tracking: 'GET /shipping/track/{tracking_numbers}',
      aymakan_get_shipments_by_reference: 'GET /shipping/by_reference/{references}',
      aymakan_list_shipments: 'GET /customer/shipments',
      aymakan_get_awb_label: 'GET /shipping/awb/tracking/{tracking_number}',
      aymakan_get_bulk_awb_labels: 'GET /shipping/bulk_awb/trackings/{tracking_numbers}',
      aymakan_list_pickup_requests: 'GET /pickup_request/list',
      aymakan_list_pickup_cities: 'GET /pickup_request/cities',
      aymakan_get_time_slots: 'GET /time_slots/{pickup_date}',
      aymakan_list_cities: 'GET /cities',
      aymakan_list_pudo_locations: 'GET /pudo/locations',
      aymakan_list_dropoff_locations: 'GET /dropoff_locations',
      aymakan_list_addresses: 'GET /address/list',
      aymakan_create_shipment: 'POST /shipping/create',
      aymakan_cancel_shipment: 'POST /shipping/cancel',
      aymakan_create_pickup_request: 'POST /pickup_request/create',
      aymakan_cancel_pickup_request: 'POST /pickup_request/cancel',
    };
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(paths).sort());
    for (const t of a.tools) expect(`${t.name} ${t.endpointMapping.method} ${t.endpointMapping.path}`).toBe(`${t.name} ${paths[t.name]}`);
    expect(tool('aymakan_cancel_shipment').endpointMapping.bodyMapping).toEqual({ tracking: '$tracking_number' });
    expect(tool('aymakan_cancel_pickup_request').endpointMapping.bodyMapping).toEqual({ pickup_request: '$pickup_request_id' });
    expect(tool('aymakan_create_shipment').endpointMapping.bodyMapping).toEqual({ __merge: '$shipment' });
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

  it('never reuses the tool names of hand-built Cloud connectors for the same API', () => {
    const names = new Set(a.tools.map((t) => t.name));
    for (const n of HAND_BUILT) expect(`${n}:${names.has(n)}`).toBe(`${n}:false`);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(WRITES).not.toContain(a.probe.tool);
    tool(a.probe.tool);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).not.toMatch(/—/);
  });
});

const live = process.env.RUN_AYMAKAN_LIVE === '1' && process.env.AYMAKAN_API_KEY ? describe : describe.skip;
live('aymakan adapter: live (read-only)', () => {
  const headers = { Authorization: process.env.AYMAKAN_API_KEY as string, Accept: 'application/json' };
  it('ping reports logged_in Yes and the city list is not empty', async () => {
    const ping = (await (await fetch(`${a.connector.baseUrl}/ping`, { headers })).json()) as { logged_in: string };
    expect(ping.logged_in).toBe('Yes');
    const cities = (await (await fetch(`${a.connector.baseUrl}/cities`, { headers })).json()) as { data: { cities: unknown[] } };
    expect(cities.data.cities.length).toBeGreaterThan(100);
  }, 60_000);
});
