/**
 * Mock backend of the demo video: Etsy, SAP Gateway (OData V2) and the Lumen
 * Logistics API of the fictional studio Lumen & Clay, all generated from
 * ../../fixtures. AnythingMCP Cloud connectors point here so Claude answers
 * from consistent, harmless data on camera.
 *
 *   /etsy/v3/application/...   Etsy Open API v3 (the adapter's nine endpoints)
 *   /sap/opu/odata/...         SAP Gateway catalog, $metadata and entity sets
 *   /logistics/openapi.json    OpenAPI 3.1 of the logistics API
 *   /logistics/v1/...          the logistics API itself
 */
import { COMPANY, PRODUCTS, SECTIONS } from '../../fixtures/products';
import { activeListings, authenticatedUser, listing, receiptById, receipts, reviews, shop } from '../../fixtures/etsy';
import { LIVE_SERVICES, catalogRows, metadataXml, productRows, salesOrderRows, stockRows } from '../../fixtures/sap';
import { CARRIERS, WAREHOUSES, allShipments, returnsList, shipmentEvents, shipmentId } from '../../fixtures/logistics';
import { buildOrders } from '../../fixtures/orders';
import { logisticsOpenApi } from './openapi';
import { parseFilter } from './odata-filter';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' };

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { ...JSON_HEADERS, ...extra } });

const notFound = (message = 'Not found') => json({ error: message }, 404);

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    const now = new Date();

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: { ...JSON_HEADERS, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' } });
    }
    if (path === '/' || path === '') {
      return json({
        name: 'Lumen & Clay demo backend',
        note: 'Fictional data for the AnythingMCP demo video.',
        services: ['/etsy/v3/application', '/sap/opu/odata', '/logistics/openapi.json', '/logistics/v1'],
      });
    }
    try {
      if (path.startsWith('/etsy/v3/application')) return etsy(req, url, path.slice('/etsy/v3/application'.length) || '/', now);
      if (path.startsWith('/sap/')) return sap(req, url, path, now);
      if (path.startsWith('/logistics')) return logistics(req, url, path.slice('/logistics'.length) || '/', now);
    } catch (err) {
      console.error(err);
      return json({ error: 'Internal error' }, 500);
    }
    return notFound();
  },
};

/* ---------------------------------------------------------------------- */
/*  Etsy                                                                   */
/* ---------------------------------------------------------------------- */

function page<T>(items: T[], url: URL, dflt = 25) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? dflt) || dflt, 1), 100);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);
  return { count: items.length, results: items.slice(offset, offset + limit) };
}

function etsy(req: Request, url: URL, p: string, now: Date): Response {
  if (req.method !== 'GET') return json({ error: 'This demo shop is read-only.' }, 405);
  const q = url.searchParams;
  let m: RegExpMatchArray | null;

  if (p === '/openapi-ping') return json({ application_id: 1177350 });
  if (p === '/users/me') return json(authenticatedUser());
  if ((m = p.match(/^\/users\/(\d+)\/shops$/))) {
    return Number(m[1]) === COMPANY.userId ? json(shop(now)) : notFound('User not found');
  }
  if ((m = p.match(/^\/shops\/(\d+)(\/.*)?$/))) {
    if (Number(m[1]) !== COMPANY.shopId) return notFound('Shop not found');
    const rest = m[2] ?? '';
    if (rest === '') return json(shop(now));
    if (rest === '/listings/active') {
      let items = activeListings();
      const kw = q.get('keywords')?.toLowerCase();
      if (kw) items = items.filter((l) => l.title.toLowerCase().includes(kw) || l.tags.some((t) => t.includes(kw)));
      const sortOn = q.get('sort_on') ?? 'created';
      const desc = !/^(asc|ascending|up)$/i.test(q.get('sort_order') ?? 'desc');
      const key = (l: ReturnType<typeof listing>) =>
        sortOn === 'price' ? l.price.amount : sortOn === 'score' ? l.num_favorers : l.creation_timestamp;
      items.sort((a, b) => (desc ? key(b) - key(a) : key(a) - key(b)));
      return json(page(items, url));
    }
    if (rest === '/shop-sections/listings/active') {
      const ids = (q.get('shop_section_ids') ?? '').split(',').map(Number).filter(Boolean);
      const titles = SECTIONS.filter((s) => ids.includes(s.id)).map((s) => s.title);
      const items = activeListings().filter((l) => !ids.length || titles.includes(SECTIONS.find((s) => s.id === l.shop_section_id)!.title));
      return json(page(items, url));
    }
    if (rest === '/receipts') {
      let items = receipts(now);
      const num = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
      const minC = num('min_created');
      const maxC = num('max_created');
      const minM = num('min_last_modified');
      const maxM = num('max_last_modified');
      if (minC !== undefined) items = items.filter((r) => r.create_timestamp >= minC);
      if (maxC !== undefined) items = items.filter((r) => r.create_timestamp <= maxC);
      if (minM !== undefined) items = items.filter((r) => r.update_timestamp >= minM);
      if (maxM !== undefined) items = items.filter((r) => r.update_timestamp <= maxM);
      if (q.get('was_shipped') !== null) items = items.filter((r) => r.is_shipped === (q.get('was_shipped') === 'true'));
      if (q.get('was_paid') !== null) items = items.filter((r) => r.is_paid === (q.get('was_paid') === 'true'));
      const asc = /^(asc|ascending|up)$/i.test(q.get('sort_order') ?? 'desc');
      const field = q.get('sort_on') === 'updated' ? 'update_timestamp' : 'create_timestamp';
      items.sort((a, b) => (asc ? a[field] - b[field] : b[field] - a[field]));
      return json(page(items, url));
    }
    if ((m = rest.match(/^\/receipts\/(\d+)$/))) {
      const r = receiptById(now, Number(m[1]));
      return r ? json(r) : notFound('Receipt not found');
    }
    if (rest === '/reviews') {
      let items = reviews(now);
      const minC = q.get('min_created');
      if (minC) items = items.filter((r) => r.create_timestamp >= Number(minC));
      return json(page(items, url));
    }
    return notFound();
  }
  if ((m = p.match(/^\/listings\/(\d+)$/))) {
    const prod = PRODUCTS.find((x) => x.listingId === Number(m![1]));
    return prod ? json(listing(prod.sku)) : notFound('Listing not found');
  }
  return notFound();
}

/* ---------------------------------------------------------------------- */
/*  SAP Gateway, OData V2                                                  */
/* ---------------------------------------------------------------------- */

const sapError = (status: number, code: string, message: string) =>
  json({ error: { code, message: { lang: 'en', value: message } } }, status, { 'sap-server': 'true' });

function sap(req: Request, url: URL, path: string, now: Date): Response {
  if (path.startsWith('/sap/opu/odata4/')) return sapError(404, '/IWFND/CM_V4S/100', 'OData V4 service catalog not active');
  if (path.startsWith('/sap/opu/odata/IWFND/CATALOGSERVICE')) {
    if (!/ServiceCollection\/?$/.test(path)) {
      return json({ d: { EntitySets: ['ServiceCollection'] } });
    }
    return odataCollection(url, catalogRows(url.origin), 'ID');
  }
  const m = path.match(/^(\/sap\/opu\/odata\/sap\/[A-Z0-9_]+(?:;v=\d+)?)(\/.*)?$/i);
  if (!m) return sapError(404, '/IWFND/MED/170', 'No service found');
  const service = m[1].replace(/;v=\d+$/, '');
  const rest = (m[2] ?? '/').replace(/\/+$/, '') || '/';
  const kind = LIVE_SERVICES[service as keyof typeof LIVE_SERVICES];
  if (!kind) {
    const name = service.split('/').pop();
    return sapError(404, '/IWFND/MED/170', `No service found for namespace '/SAP/', name '${name}', version '0001'`);
  }
  if (req.method !== 'GET') return sapError(405, '/IWBEP/CM_MGW_RT/020', 'This demo system is read-only.');

  if (rest === '/$metadata') {
    return new Response(metadataXml(kind), { headers: { 'content-type': 'application/xml', 'x-csrf-token': 'demo-token', 'dataserviceversion': '2.0' } });
  }
  const sets: Record<string, { rows: () => Record<string, unknown>[]; keys: string[]; decimals: string[] }> = {
    stock: { rows: () => stockRows() as unknown as Record<string, unknown>[], keys: ['Material', 'Plant'], decimals: ['UnrestrictedStock', 'SafetyStock', 'ReorderPoint', 'InProductionQty'] },
    product: { rows: productRows, keys: ['Product'], decimals: [] },
    salesorder: { rows: () => salesOrderRows(now), keys: ['SalesOrder'], decimals: [] },
  };
  const setName = { stock: 'StockOverview', product: 'A_Product', salesorder: 'A_SalesOrder' }[kind];
  if (rest === '/') {
    return json({ d: { EntitySets: [setName] } }, 200, { 'x-csrf-token': 'demo-token', 'set-cookie': 'SAP_SESSIONID_DEMO=1; path=/' });
  }
  const em = rest.match(/^\/([A-Za-z_]+)(\((.*)\))?$/);
  if (!em || em[1] !== setName) return sapError(404, '/IWBEP/CM_MGW_RT/021', `Resource not found for segment '${em?.[1] ?? rest}'`);
  const def = sets[kind];
  const rows = def.rows().map((r) => {
    const out: Record<string, unknown> = { ...r };
    for (const d of def.decimals) out[d] = Number(out[d]).toFixed(3);
    return out;
  });
  if (em[3] !== undefined) {
    const key = parseKey(em[3], def.keys);
    const hit = rows.find((r) => def.keys.every((k) => String(r[k]) === key[k]));
    if (!hit) return sapError(404, '/IWBEP/CM_MGW_RT/022', 'Resource not found');
    return json({ d: withMeta(hit, url, service, setName, def.keys) });
  }
  return odataCollection(url, rows.map((r) => withMeta(r, url, service, setName, def.keys)));
}

function parseKey(src: string, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!src.includes('=')) {
    out[keys[0]] = src.replace(/^'|'$/g, '');
    return out;
  }
  for (const part of src.split(/,(?=[A-Za-z_]+=)/)) {
    const [k, ...v] = part.split('=');
    out[k.trim()] = v.join('=').trim().replace(/^'|'$/g, '');
  }
  return out;
}

function withMeta(r: Record<string, unknown>, url: URL, service: string, set: string, keys: string[]) {
  const pred = keys.map((k) => `${k}='${r[k]}'`).join(',');
  return { __metadata: { id: `${url.origin}${service}/${set}(${pred})`, uri: `${url.origin}${service}/${set}(${pred})`, type: `${service.split('/').pop()}.${set}Type` }, ...r };
}

function odataCollection(url: URL, all: Record<string, unknown>[], _key?: string): Response {
  const q = url.searchParams;
  let rows = all;
  const filter = q.get('$filter');
  if (filter) {
    const pred = parseFilter(filter);
    if (pred) rows = rows.filter(pred);
  }
  const orderby = q.get('$orderby');
  if (orderby) {
    const parts = orderby.split(',').map((s) => s.trim().split(/\s+/));
    rows = [...rows].sort((a, b) => {
      for (const [f, dir] of parts) {
        const x = a[f];
        const y = b[f];
        const nx = Number(x);
        const ny = Number(y);
        const c = !isNaN(nx) && !isNaN(ny) ? nx - ny : String(x).localeCompare(String(y));
        if (c !== 0) return dir?.toLowerCase() === 'desc' ? -c : c;
      }
      return 0;
    });
  }
  const count = rows.length;
  const skip = Number(q.get('$skip') ?? 0) || 0;
  const top = q.get('$top') ? Number(q.get('$top')) : rows.length;
  rows = rows.slice(skip, skip + top);
  const select = q.get('$select');
  if (select) {
    const fields = select.split(',').map((s) => s.trim());
    rows = rows.map((r) => {
      const o: Record<string, unknown> = { __metadata: r.__metadata };
      for (const f of fields) if (f in r) o[f] = r[f];
      return o;
    });
  }
  const d: Record<string, unknown> = { results: rows };
  if (q.get('$inlinecount') === 'allpages') d.__count = String(count);
  return json({ d });
}

/* ---------------------------------------------------------------------- */
/*  Lumen Logistics API                                                    */
/* ---------------------------------------------------------------------- */

async function logistics(req: Request, url: URL, p: string, now: Date): Promise<Response> {
  if (p === '/openapi.json' || p === '/v1/openapi.json') return json(logisticsOpenApi(`${url.origin}/logistics/v1`));
  if (!p.startsWith('/v1')) return notFound();
  const r = p.slice(3) || '/';
  const q = url.searchParams;
  const ships = allShipments(now);
  let m: RegExpMatchArray | null;

  if (r === '/shipments' && req.method === 'GET') {
    let items = ships;
    const status = q.get('status');
    if (status) {
      const wanted = status.split(',').map((s) => s.trim().toLowerCase());
      items = items.filter((s) => wanted.includes(s.status));
    }
    const carrier = q.get('carrier');
    if (carrier) items = items.filter((s) => s.carrier?.toLowerCase() === carrier.toLowerCase());
    const since = q.get('shipped_since');
    if (since) items = items.filter((s) => (s.shipped_at ?? '') >= since);
    const limit = Math.min(Number(q.get('limit') ?? 50) || 50, 100);
    return json({ count: items.length, results: items.slice(0, limit) });
  }
  if (r === '/shipments' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as Record<string, any>;
    const warehouse = WAREHOUSES.find((w) => w.warehouse_id === body.from_warehouse) ?? WAREHOUSES[0];
    return json(
      {
        shipment_id: `SHP-R${Math.floor(now.getTime() / 1000) % 1000000}`,
        order_ref: body.order_ref ?? null,
        status: 'label_created',
        reason: body.reason ?? 'replacement',
        origin_warehouse: warehouse.warehouse_id,
        items: body.items ?? [],
        pickup: `Next ${warehouse.name} cutoff, ${warehouse.cutoff_local} local time`,
      },
      201,
    );
  }
  if ((m = r.match(/^\/shipments\/([^/]+)$/))) {
    const s = ships.find((x) => x.shipment_id === m![1]);
    return s ? json(s) : notFound('Shipment not found');
  }
  if ((m = r.match(/^\/shipments\/([^/]+)\/events$/))) {
    const o = buildOrders(now).find((x) => shipmentId(x) === m![1]);
    return o ? json({ shipment_id: m[1], events: shipmentEvents(o) }) : notFound('Shipment not found');
  }
  if ((m = r.match(/^\/shipments\/([^/]+)\/cancel$/)) && req.method === 'POST') {
    const s = ships.find((x) => x.shipment_id === m![1]);
    if (!s) return notFound('Shipment not found');
    return json({ error: 'Shipment already picked up by the carrier; open a claim instead.' }, 409);
  }
  if ((m = r.match(/^\/shipments\/([^/]+)\/claims$/)) && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as Record<string, any>;
    return json({ claim_id: `CLM-${m[1].slice(4)}`, shipment_id: m[1], type: body.type ?? 'damage', status: 'submitted' }, 201);
  }
  if ((m = r.match(/^\/orders\/([^/]+)\/shipments$/))) {
    const items = ships.filter((s) => s.order_ref === m![1]);
    return json({ count: items.length, results: items });
  }
  if ((m = r.match(/^\/tracking\/([^/]+)$/))) {
    const s = ships.find((x) => x.tracking_number === m![1]);
    return s ? json(s) : notFound('Tracking number not found');
  }
  if (r === '/carriers') return json({ results: CARRIERS });
  if (r === '/rates' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as Record<string, any>;
    const eu = !['US', 'CA', 'GB'].includes(String(body.to_country ?? '').toUpperCase());
    return json({
      results: [
        { carrier: 'DHL', service: 'standard', price: eu ? 9.9 : 18.9, currency: 'EUR', transit_days: eu ? 3 : 6 },
        { carrier: 'UPS', service: 'express', price: eu ? 17.5 : 29.0, currency: 'EUR', transit_days: eu ? 1 : 2 },
      ],
    });
  }
  if (r === '/warehouses') return json({ results: WAREHOUSES });
  if (r === '/returns') return json({ results: returnsList(now) });
  return notFound();
}
