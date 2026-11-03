import * as adapter from './lodgify.json';

/**
 * Lodgify Public API (docs.lodgify.com; each reference page embeds its OpenAPI definition,
 * "Lodgify Public API v2" and "Lodgify Public API v1"): base https://api.lodgify.com,
 * API key in the X-ApiKey header. v2 for properties, availability, rates, quotes, bookings and
 * threads; v1 for the inbox, enquiries, booking creation, status changes and messages.
 * Live part (reads only: properties, room types, upcoming bookings, unread count):
 *   LODGIFY_API_KEY=... RUN_LODGIFY_LIVE=1 npx jest src/adapters/intl/lodgify
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
const P = 'lodgify_';
const B = '/v1/reservation/booking/{booking_id}';
const WRITES = [
  'lodgify_add_booking_messages',
  'lodgify_add_enquiry_messages',
  'lodgify_check_in_booking',
  'lodgify_check_out_booking',
  'lodgify_create_booking',
  'lodgify_decline_booking',
  'lodgify_mark_booking_not_replied',
  'lodgify_mark_booking_replied',
  'lodgify_reopen_booking',
  'lodgify_request_payment',
  'lodgify_set_booking_booked',
  'lodgify_set_booking_tentative',
  'lodgify_update_key_codes',
];

describe('lodgify adapter: static spec conformance', () => {
  it('authenticates with the API key in the X-ApiKey header', () => {
    expect(a.slug).toBe('lodgify');
    expect(a.region).toBe('intl');
    expect(a.icon).toBe('lodgify');
    expect(a.requiredEnvVars).toEqual(['LODGIFY_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.lodgify.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-ApiKey', apiKey: '{{LODGIFY_API_KEY}}' });
    expect(a.envVarMeta?.LODGIFY_API_KEY.secret).toBe(true);
    const sample = ['a1B2c3D4e5F6g7H8i9J0', 'k1L2m3N4o5P6q7R8s9T0'].join('');
    expect(new RegExp(a.envVarMeta?.LODGIFY_API_KEY.pattern as string).test(sample)).toBe(true);
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/v[12]\//);
  });

  it('maps properties, availability, rates and quotes to the documented v2 routes', () => {
    expect(tool('lodgify_list_properties').endpointMapping).toEqual({
      method: 'GET',
      path: '/v2/properties',
      queryParams: { page: '$page', size: '$size', includeCount: '$include_count', includeInOut: '$include_in_out', updatedSince: '$updated_since', wid: '$wid' },
    });
    expect(tool('lodgify_get_property').endpointMapping.path).toBe('/v2/properties/{property_id}');
    expect(tool('lodgify_list_property_rooms').endpointMapping.path).toBe('/v2/properties/{property_id}/rooms');
    expect(tool('lodgify_list_deleted_properties').endpointMapping).toEqual({ method: 'GET', path: '/v2/deletedproperties', queryParams: { deletedSince: '$deleted_since' } });
    expect(tool('lodgify_get_availability').endpointMapping).toEqual({ method: 'GET', path: '/v2/availability', queryParams: { start: '$start', end: '$end', includeDetails: '$include_details' } });
    expect(tool('lodgify_get_room_type_availability').endpointMapping.path).toBe('/v2/availability/{property_id}/{room_type_id}');
    expect(tool('lodgify_get_rates_calendar').endpointMapping.queryParams).toEqual({ houseId: '$property_id', roomTypeId: '$room_type_id', startDate: '$start_date', endDate: '$end_date' });
    expect(tool('lodgify_get_rate_settings').endpointMapping).toEqual({ method: 'GET', path: '/v2/rates/settings', queryParams: { houseId: '$property_id' } });
    expect(tool('lodgify_get_quote').endpointMapping).toMatchObject({
      path: '/v2/quote/{property_id}',
      queryParams: { arrival: '$arrival', departure: '$departure', 'roomTypes[0].Id': '$room_type_id', 'roomTypes[0].guest_breakdown.adults': '$adults', 'addOns[0].Id': '$addon_id', 'addOns[0].Units': '$addon_units', promotionCode: '$promotion_code' },
    });
  });

  it('maps bookings, the v1 inbox, enquiries and threads', () => {
    expect(tool('lodgify_list_bookings').endpointMapping).toMatchObject({ path: '/v2/reservations/bookings', queryParams: { stayFilter: '$stay_filter', stayFilterDate: '$stay_filter_date', trash: '$trash', includeExternal: '$include_external' } });
    expect(tool('lodgify_list_bookings').parameters?.properties?.stay_filter.enum).toEqual(['Upcoming', 'Current', 'Historic', 'All', 'ArrivalDate', 'DepartureDate']);
    expect(tool('lodgify_list_bookings').parameters?.properties?.trash.enum).toEqual(['False', 'True', 'All']);
    expect(tool('lodgify_get_booking').endpointMapping).toEqual({ method: 'GET', path: '/v2/reservations/bookings/{booking_id}' });
    expect(tool('lodgify_list_external_bookings').endpointMapping.path).toBe('/v2/reservations/bookings/{booking_id}/externalBookings');
    expect(tool('lodgify_get_booking_payment_link').endpointMapping.path).toBe('/v2/reservations/bookings/{booking_id}/quote/paymentLink');
    expect(tool('lodgify_get_booking_quote').endpointMapping.path).toBe(`${B}/quote`);
    expect(tool('lodgify_list_inbox').endpointMapping).toMatchObject({ path: '/v1/reservation', queryParams: { offset: '$offset', limit: '$limit', status: '$status', propertyId: '$property_id', periodStart: '$period_start', periodEnd: '$period_end' } });
    expect(tool('lodgify_count_unread').endpointMapping).toEqual({ method: 'GET', path: '/v1/reservation/not_read' });
    expect(tool('lodgify_get_enquiry').endpointMapping.path).toBe('/v1/reservation/enquiry/{enquiry_id}');
    expect(tool('lodgify_get_thread').endpointMapping.path).toBe('/v2/messaging/{thread_uid}');
  });

  it('maps the writes: booking creation, status changes, check-in and messages', () => {
    expect(tool('lodgify_create_booking').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/v1/reservation/booking',
      queryParams: { from: '$from_enquiry_id' },
      bodyMapping: { property_id: '$property_id', arrival: '$arrival', departure: '$departure', guest: '$guest', rooms: '$rooms' },
    });
    expect(tool('lodgify_set_booking_booked').endpointMapping).toEqual({ method: 'PUT', path: `${B}/book`, queryParams: { requestPayment: '$request_payment' } });
    expect(tool('lodgify_set_booking_tentative').endpointMapping.path).toBe(`${B}/tentative`);
    expect(tool('lodgify_decline_booking').endpointMapping).toEqual({ method: 'PUT', path: `${B}/decline` });
    expect(tool('lodgify_reopen_booking').endpointMapping).toEqual({ method: 'PUT', path: `${B}/reopen` });
    expect(tool('lodgify_request_payment').endpointMapping).toEqual({ method: 'PUT', path: `${B}/request_payment` });
    expect(tool('lodgify_mark_booking_replied').endpointMapping.path).toBe(`${B}/replied`);
    expect(tool('lodgify_mark_booking_not_replied').endpointMapping.path).toBe(`${B}/not_replied`);
    expect(tool('lodgify_check_in_booking').endpointMapping).toEqual({ method: 'PUT', path: '/v2/reservations/bookings/{booking_id}/checkin', bodyMapping: { time: '$time' } });
    expect(tool('lodgify_check_out_booking').endpointMapping).toEqual({ method: 'PUT', path: '/v2/reservations/bookings/{booking_id}/checkout', bodyMapping: { time: '$time' } });
    expect(tool('lodgify_update_key_codes').endpointMapping).toEqual({ method: 'PUT', path: '/v2/reservations/bookings/{booking_id}/keyCodes', bodyMapping: { rooms: '$rooms' } });
    expect(tool('lodgify_add_booking_messages').endpointMapping).toEqual({ method: 'POST', path: `${B}/messages`, bodyMapping: { __raw: '$messages' } });
    expect(tool('lodgify_add_enquiry_messages').endpointMapping).toEqual({ method: 'POST', path: '/v1/reservation/enquiry/{enquiry_id}/messages', bodyMapping: { __raw: '$messages' } });
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

  it('reads are GET, the writes are the expected set, none deletes and none is switched off', () => {
    expect(a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name).sort()).toEqual(WRITES);
    expect(a.tools.some((t) => t.endpointMapping.method === 'DELETE')).toBe(false);
    for (const t of a.tools) expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_LODGIFY_LIVE === '1' && process.env.LODGIFY_API_KEY ? describe : describe.skip;
live('lodgify adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { 'X-ApiKey': process.env.LODGIFY_API_KEY as string, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads properties, room types, upcoming bookings and the unread count', async () => {
    const props = (await get('/v2/properties?size=5&includeCount=true')) as { items?: Array<{ id: number }> };
    expect(Array.isArray(props.items)).toBe(true);
    const id = props.items?.[0]?.id;
    if (id) await get(`/v2/properties/${id}/rooms`);
    const bookings = (await get('/v2/reservations/bookings?size=5&stayFilter=Upcoming')) as { items?: unknown[] };
    expect(Array.isArray(bookings.items)).toBe(true);
    await get('/v1/reservation/not_read');
  }, 60_000);
});
