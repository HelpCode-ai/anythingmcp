import { DAY_MS, dayAnchor } from './products';
import { Order, buildOrders } from './orders';

/**
 * Lumen Logistics: the studio's own shipping API. Every shipped Etsy order is
 * a shipment here (order_ref `ETSY-<receipt_id>`), with the same carrier and
 * tracking number Etsy shows.
 */

export const WAREHOUSES = [
  { warehouse_id: 'LIS-1', name: 'Lisbon Studio', plant: '1000', city: 'Lisbon', country: 'PT', cutoff_local: '15:00' },
  { warehouse_id: 'OPO-1', name: 'Porto Warehouse', plant: '1100', city: 'Porto', country: 'PT', cutoff_local: '16:30' },
];

export const CARRIERS = [
  { carrier_id: 'DHL', name: 'DHL Parcel', services: ['standard', 'express'], claims_window_days: 30 },
  { carrier_id: 'UPS', name: 'UPS', services: ['standard', 'saver', 'express'], claims_window_days: 60 },
  { carrier_id: 'CTT', name: 'CTT Expresso', services: ['standard', 'next_day'], claims_window_days: 30 },
];

const iso = (ms?: number) => (ms === undefined ? null : new Date(ms).toISOString());

export interface ShipmentEvent {
  at: string;
  code: string;
  description: string;
  location: string;
}

export function shipmentId(o: Order): string {
  return `SHP-${String(o.receiptId).slice(-6)}`;
}

function hubFor(country: string): string {
  const hubs: Record<string, string> = {
    DE: 'Leipzig hub, DE', NL: 'Cologne gateway, DE', GB: 'East Midlands hub, GB', FR: 'Paris CDG hub, FR',
    US: 'Louisville Worldport, US', CA: 'Louisville Worldport, US', ES: 'Madrid hub, ES', PT: 'Lisbon hub, PT',
  };
  return hubs[country] ?? 'Cologne gateway, DE';
}

export function shipmentEvents(o: Order): ShipmentEvent[] {
  if (!o.shippedAt) return [];
  const ev: ShipmentEvent[] = [
    { at: iso(o.shippedAt - 3 * 60 * 60 * 1000)!, code: 'LABEL_CREATED', description: 'Shipping label created', location: 'Lisbon Studio, PT' },
    { at: iso(o.shippedAt)!, code: 'PICKED_UP', description: `Picked up by ${o.carrier}`, location: 'Lisbon, PT' },
    { at: iso(o.shippedAt + DAY_MS)!, code: 'IN_TRANSIT', description: 'Arrived at sorting hub', location: hubFor(o.buyer.country) },
  ];
  if (o.state === 'delivered' && o.deliveredAt) {
    ev.push({ at: iso(o.deliveredAt - 6 * 60 * 60 * 1000)!, code: 'OUT_FOR_DELIVERY', description: 'Out for delivery', location: `${o.buyer.city}, ${o.buyer.country}` });
    ev.push({ at: iso(o.deliveredAt)!, code: 'DELIVERED', description: 'Delivered', location: `${o.buyer.city}, ${o.buyer.country}` });
  }
  if (o.issue) {
    ev.push({ at: iso(o.issue.lastScanAt)!, code: o.issue.code === 'DAMAGED' ? 'EXCEPTION' : 'LAST_SCAN', description: o.issue.summary, location: o.issue.lastLocation });
  }
  return ev.sort((a, b) => a.at.localeCompare(b.at));
}

export function shipmentFrom(o: Order, now: Date) {
  const late = o.estimatedDelivery !== undefined && o.state !== 'delivered' && o.estimatedDelivery < dayAnchor(now);
  return {
    shipment_id: shipmentId(o),
    order_ref: `ETSY-${o.receiptId}`,
    channel: 'etsy',
    status: o.state === 'lost' ? 'lost' : o.state === 'delayed' ? 'delayed' : o.state,
    is_late: late,
    carrier: o.carrier,
    service: 'standard',
    tracking_number: o.trackingCode,
    origin_warehouse: 'LIS-1',
    destination: { name: o.buyer.name, city: o.buyer.city, country: o.buyer.country },
    items: o.lines.map((l) => ({ sku: l.sku, quantity: l.qty })),
    shipped_at: iso(o.shippedAt),
    estimated_delivery: iso(o.estimatedDelivery),
    delivered_at: iso(o.deliveredAt),
    issue: o.issue
      ? { code: o.issue.code, summary: o.issue.summary, last_location: o.issue.lastLocation, last_scan_at: iso(o.issue.lastScanAt) }
      : null,
  };
}

export function allShipments(now: Date) {
  return buildOrders(now)
    .filter((o) => o.shippedAt)
    .map((o) => shipmentFrom(o, now));
}

export function returnsList(now: Date) {
  const today = dayAnchor(now);
  return [
    { return_id: 'RET-2291', order_ref: 'ETSY-3401557003', status: 'in_transit_to_warehouse', reason: 'Refused by recipient: box crushed', created_at: iso(today - DAY_MS), warehouse_id: 'LIS-1' },
    { return_id: 'RET-2284', order_ref: 'ETSY-3401557049', status: 'received', reason: 'Colour not as expected', created_at: iso(today - 12 * DAY_MS), warehouse_id: 'LIS-1' },
  ];
}
