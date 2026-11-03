import * as adapter from './apaleo.json';

/**
 * apaleo API (Swagger at https://api.apaleo.com/swagger/index.html, one spec per module:
 * inventory, rateplan, booking, finance, availability, operations, reports):
 * OAuth 2.0 client credentials at https://identity.apaleo.com/connect/token (HTTP Basic client auth),
 * Bearer token on https://api.apaleo.com/<module>/v1/...
 * Live part (reads only: properties, unit groups, rate plans, today's reservations):
 *   APALEO_CLIENT_ID=... APALEO_CLIENT_SECRET=... RUN_APALEO_LIVE=1 npx jest src/adapters/de/apaleo
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: string[]; type?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown> };
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
const P = 'apaleo_';
const RA = '/booking/v1/reservation-actions/{reservation_id}';
const WRITES = [
  'apaleo_create_booking',
  'apaleo_update_booking',
  'apaleo_update_reservation',
  'apaleo_amend_reservation',
  'apaleo_assign_unit',
  'apaleo_assign_specific_unit',
  'apaleo_unassign_units',
  'apaleo_check_in_reservation',
  'apaleo_revert_check_in',
  'apaleo_check_out_reservation',
  'apaleo_cancel_reservation',
  'apaleo_set_reservation_no_show',
  'apaleo_create_maintenance',
  'apaleo_set_unit_conditions',
].sort();
const OFF = ['apaleo_cancel_reservation', 'apaleo_set_reservation_no_show'];

describe('apaleo adapter: static spec conformance', () => {
  it('gets a token with the client credentials grant at identity.apaleo.com', () => {
    expect(a.slug).toBe('apaleo');
    expect(a.region).toBe('de');
    expect(a.icon).toBe('apaleo');
    expect(a.requiredEnvVars).toEqual(['APALEO_CLIENT_ID', 'APALEO_CLIENT_SECRET']);
    expect(a.connector.baseUrl).toBe('https://api.apaleo.com');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{APALEO_CLIENT_ID}}',
      clientSecret: '{{APALEO_CLIENT_SECRET}}',
      tokenUrl: 'https://identity.apaleo.com/connect/token',
      tokenAuthMethod: 'client_secret_basic',
    });
    expect(a.envVarMeta?.APALEO_CLIENT_SECRET.secret).toBe(true);
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/(inventory|rateplan|booking|finance|availability|operations|reports)\/v1\//);
  });

  it('maps inventory, rate plan and availability reads to the documented routes and query names', () => {
    expect(tool('apaleo_list_properties').endpointMapping).toEqual({
      method: 'GET',
      path: '/inventory/v1/properties',
      queryParams: { status: '$status', includeArchived: '$include_archived', countryCode: '$country_code', pageNumber: '$page_number', pageSize: '$page_size' },
    });
    expect(tool('apaleo_list_units').endpointMapping).toMatchObject({ path: '/inventory/v1/units', queryParams: { propertyId: '$property_id', unitGroupIds: '$unit_group_ids', isOccupied: '$is_occupied', condition: '$condition' } });
    expect(tool('apaleo_get_unit_group').endpointMapping.path).toBe('/inventory/v1/unit-groups/{unit_group_id}');
    expect(tool('apaleo_list_rates').endpointMapping).toEqual({ method: 'GET', path: '/rateplan/v1/rate-plans/{rate_plan_id}/rates', queryParams: { from: '$from', to: '$to', pageNumber: '$page_number', pageSize: '$page_size' } });
    expect(tool('apaleo_list_rates').parameters?.required).toEqual(['rate_plan_id', 'from', 'to']);
    expect(tool('apaleo_get_unit_group_availability').endpointMapping).toMatchObject({ path: '/availability/v1/unit-groups', queryParams: { propertyId: '$property_id', from: '$from', to: '$to', adults: '$adults', childrenAges: '$children_ages' } });
    expect(tool('apaleo_get_unit_availability').parameters?.required).toEqual(['property_id', 'from', 'to']);
    expect(tool('apaleo_list_available_units_for_reservation').endpointMapping.path).toBe('/availability/v1/reservations/{reservation_id}/units');
    expect(tool('apaleo_get_offers').endpointMapping).toMatchObject({ path: '/booking/v1/offers', queryParams: { propertyId: '$property_id', arrival: '$arrival', departure: '$departure', adults: '$adults', channelCode: '$channel_code' } });
    expect(tool('apaleo_get_offers').parameters?.required).toEqual(['property_id', 'arrival', 'departure', 'adults']);
  });

  it('maps bookings, reservations, finance and reports', () => {
    expect(tool('apaleo_list_reservations').endpointMapping).toMatchObject({
      path: '/booking/v1/reservations',
      queryParams: { bookingId: '$booking_id', status: '$status', dateFilter: '$date_filter', from: '$from', to: '$to', textSearch: '$text_search', sort: '$sort', expand: '$expand' },
    });
    expect(tool('apaleo_count_reservations').endpointMapping.path).toBe('/booking/v1/reservations/$count');
    expect(tool('apaleo_list_reservations').parameters?.properties?.date_filter.enum).toEqual(['Arrival', 'Departure', 'Stay', 'Creation', 'Modification', 'Cancellation', 'ArrivalAndCheckIn', 'DepartureAndCheckOut']);
    expect(tool('apaleo_get_reservation').endpointMapping.path).toBe('/booking/v1/reservations/{reservation_id}');
    expect(tool('apaleo_get_booking').endpointMapping.path).toBe('/booking/v1/bookings/{booking_id}');
    expect(tool('apaleo_list_folios').endpointMapping).toMatchObject({ path: '/finance/v1/folios', queryParams: { reservationIds: '$reservation_ids', status: '$status' } });
    expect(tool('apaleo_list_folio_payments').endpointMapping.path).toBe('/finance/v1/folios/{folio_id}/payments');
    expect(tool('apaleo_get_invoice').endpointMapping.path).toBe('/finance/v1/invoices/{invoice_id}');
    expect(tool('apaleo_get_property_performance_report').endpointMapping.path).toBe('/reports/v1/reports/property-performance');
    expect(tool('apaleo_get_arrivals_report').endpointMapping.queryParams).toEqual({ propertyId: '$property_id', month: '$month', year: '$year' });
  });

  it('maps the writes: booking body, JSON Patch, reservation actions and housekeeping', () => {
    expect(tool('apaleo_create_booking').endpointMapping).toEqual({
      method: 'POST',
      path: '/booking/v1/bookings',
      bodyMapping: { booker: '$booker', reservations: '$reservations', comment: '$comment', bookerComment: '$booker_comment' },
      headers: { 'Idempotency-Key': '$idempotency_key' },
    });
    for (const n of ['apaleo_update_booking', 'apaleo_update_reservation']) {
      expect(tool(n).endpointMapping.method).toBe('PATCH');
      expect(tool(n).endpointMapping.bodyMapping).toEqual({ __raw: '$operations' });
      expect(tool(n).endpointMapping.headers).toEqual({ 'Content-Type': 'application/json-patch+json' });
    }
    expect(tool('apaleo_amend_reservation').endpointMapping).toMatchObject({ method: 'PUT', path: `${RA}/amend`, bodyMapping: { arrival: '$arrival', departure: '$departure', adults: '$adults', timeSlices: '$time_slices' } });
    expect(tool('apaleo_check_in_reservation').endpointMapping).toEqual({ method: 'PUT', path: `${RA}/checkin`, queryParams: { withCityTax: '$with_city_tax' } });
    expect(tool('apaleo_revert_check_in').endpointMapping).toEqual({ method: 'PUT', path: `${RA}/revert-checkin` });
    expect(tool('apaleo_check_out_reservation').endpointMapping).toEqual({ method: 'PUT', path: `${RA}/checkout` });
    expect(tool('apaleo_cancel_reservation').endpointMapping).toEqual({ method: 'PUT', path: `${RA}/cancel` });
    expect(tool('apaleo_set_reservation_no_show').endpointMapping).toEqual({ method: 'PUT', path: `${RA}/noshow` });
    expect(tool('apaleo_assign_unit').endpointMapping.path).toBe(`${RA}/assign-unit`);
    expect(tool('apaleo_assign_specific_unit').endpointMapping.path).toBe(`${RA}/assign-unit/{unit_id}`);
    expect(tool('apaleo_unassign_units').endpointMapping.path).toBe(`${RA}/unassign-units`);
    expect(tool('apaleo_create_maintenance').endpointMapping.bodyMapping).toEqual({ unitId: '$unit_id', from: '$from', to: '$to', type: '$type', description: '$description' });
    expect(tool('apaleo_set_unit_conditions').endpointMapping).toEqual({ method: 'PUT', path: '/operations/v1/units-condition', bodyMapping: { unitsConditions: '$units_conditions' } });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(P)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('reads are GET, the writes are the expected set and only cancel and no-show are switched off', () => {
    const writes = a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(OFF);
    for (const n of OFF) expect(tool(n).annotations?.destructiveHint).toBe(true);
    expect(a.instructions).toContain('**Switched off at install**: `apaleo_cancel_reservation` and `apaleo_set_reservation_no_show`; they cannot be undone');
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_APALEO_LIVE === '1' && process.env.APALEO_CLIENT_ID && process.env.APALEO_CLIENT_SECRET ? describe : describe.skip;
live('apaleo adapter: live (read-only)', () => {
  let token = '';
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    expect([200, 204]).toContain(res.status);
    return res.status === 204 ? {} : ((await res.json()) as Record<string, unknown>);
  };
  beforeAll(async () => {
    const basic = Buffer.from(`${process.env.APALEO_CLIENT_ID}:${process.env.APALEO_CLIENT_SECRET}`).toString('base64');
    const res = await fetch('https://identity.apaleo.com/connect/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    expect(res.status).toBe(200);
    token = ((await res.json()) as { access_token: string }).access_token;
  });
  it('reads properties, unit groups, rate plans and today\'s arrivals', async () => {
    const props = (await get('/inventory/v1/properties?pageSize=5')) as { properties?: Array<{ id: string }> };
    const id = props.properties?.[0]?.id;
    if (!id) return;
    await get(`/inventory/v1/unit-groups?propertyId=${id}`);
    await get(`/rateplan/v1/rate-plans?propertyId=${id}&pageSize=5`);
    const today = new Date().toISOString().slice(0, 10);
    await get(`/booking/v1/reservations?propertyIds=${id}&dateFilter=Arrival&from=${today}&to=${today}&pageSize=5`);
  }, 60_000);
});
