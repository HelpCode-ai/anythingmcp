import { COMPANY, DAY_MS, PRODUCTS, dayAnchor, mulberry32, productBySku } from './products';

/**
 * The orders of the last 30 days, shared by the Etsy mock (receipts) and the
 * logistics mock (shipments). Timestamps are relative to `now`, so the demo
 * reads "last 30 days" / "this week" correctly whenever it is recorded.
 *
 * Three shipments are in trouble on purpose; they are the subject of the
 * video's final question ("which orders are stuck, can SAP cover a resend?").
 */

export type ShipmentState = 'unshipped' | 'in_transit' | 'delivered' | 'delayed' | 'lost';

export interface OrderLine {
  sku: string;
  qty: number;
}

export interface Order {
  receiptId: number;
  /** Epoch ms. */
  createdAt: number;
  buyer: { name: string; city: string; country: string; buyerUserId: number };
  lines: OrderLine[];
  state: ShipmentState;
  carrier?: 'DHL' | 'UPS' | 'CTT';
  trackingCode?: string;
  shippedAt?: number;
  estimatedDelivery?: number;
  deliveredAt?: number;
  /** For delayed / lost parcels. */
  issue?: { code: string; summary: string; lastLocation: string; lastScanAt: number };
}

const BUYERS: [string, string, string][] = [
  ['Sofia M.', 'Berlin', 'DE'], ['Emma L.', 'Amsterdam', 'NL'], ['James W.', 'Manchester', 'GB'],
  ['Lucas B.', 'Lyon', 'FR'], ['Olivia R.', 'Brooklyn', 'US'], ['Mateo G.', 'Madrid', 'ES'],
  ['Hannah K.', 'Vienna', 'AT'], ['Noah P.', 'Copenhagen', 'DK'], ['Chloé D.', 'Paris', 'FR'],
  ['Liam O.', 'Dublin', 'IE'], ['Giulia C.', 'Milan', 'IT'], ['Ava T.', 'Austin', 'US'],
  ['Elias N.', 'Stockholm', 'SE'], ['Mia S.', 'Zurich', 'CH'], ['Leo F.', 'Brussels', 'BE'],
  ['Isabel V.', 'Porto', 'PT'], ['Finn H.', 'Hamburg', 'DE'], ['Nora J.', 'Oslo', 'NO'],
  ['Ethan C.', 'Toronto', 'CA'], ['Lea W.', 'Munich', 'DE'], ['Marta P.', 'Barcelona', 'ES'],
  ['Oscar E.', 'Gothenburg', 'SE'], ['Zoe A.', 'London', 'GB'], ['Daniel R.', 'Rotterdam', 'NL'],
  ['Clara M.', 'Bologna', 'IT'], ['Henry B.', 'Seattle', 'US'], ['Ines L.', 'Lisbon', 'PT'],
  ['Felix G.', 'Cologne', 'DE'], ['Alice V.', 'Ghent', 'BE'], ['Samuel K.', 'Helsinki', 'FI'],
  ['Julia Z.', 'Kraków', 'PL'], ['Theo M.', 'Bordeaux', 'FR'], ['Lina H.', 'Frankfurt', 'DE'],
  ['Adam S.', 'Prague', 'CZ'], ['Ruby D.', 'Edinburgh', 'GB'], ['Hugo R.', 'Valencia', 'ES'],
];

const HOUR = 60 * 60 * 1000;

function carrierFor(country: string): 'DHL' | 'UPS' | 'CTT' {
  if (country === 'PT' || country === 'ES') return 'CTT';
  if (['US', 'CA', 'GB', 'NL'].includes(country)) return 'UPS';
  return 'DHL';
}

function tracking(carrier: string, n: number): string {
  if (carrier === 'DHL') return `JJD00${(390000000 + n * 7919).toString()}`;
  if (carrier === 'UPS') return `1Z4A7W${(68000000 + n * 104729).toString()}`;
  return `LA${(100000000 + n * 15485).toString().slice(0, 9)}PT`;
}

export function buildOrders(now: Date): Order[] {
  const today = dayAnchor(now);
  const rnd = mulberry32(20260929);
  let nextReceipt = 3401557120;
  let buyerIdx = 0;
  const nextBuyer = () => {
    const [name, city, country] = BUYERS[buyerIdx % BUYERS.length];
    buyerIdx++;
    return { name, city, country, buyerUserId: 710000000 + buyerIdx * 3571 };
  };

  // The three shipments the finale is about.
  const troubled: Order[] = [
    {
      receiptId: 3401556981,
      createdAt: today - 8 * DAY_MS + 10 * HOUR,
      buyer: { name: 'Sofia M.', city: 'Berlin', country: 'DE', buyerUserId: 710003571 },
      lines: [{ sku: 'LC-MUG-SAGE', qty: 2 }],
      state: 'delayed',
      carrier: 'DHL',
      trackingCode: 'JJD00390418232',
      shippedAt: today - 7 * DAY_MS + 15 * HOUR,
      estimatedDelivery: today - 3 * DAY_MS,
      issue: {
        code: 'DAMAGED',
        summary: 'Parcel damaged at the Leipzig hub; carrier reports broken contents.',
        lastLocation: 'Leipzig hub, DE',
        lastScanAt: today - 4 * DAY_MS + 6 * HOUR,
      },
    },
    {
      receiptId: 3401556994,
      createdAt: today - 9 * DAY_MS + 14 * HOUR,
      buyer: { name: 'Emma L.', city: 'Amsterdam', country: 'NL', buyerUserId: 710007142 },
      lines: [{ sku: 'LC-VASE-TALL', qty: 1 }],
      state: 'lost',
      carrier: 'UPS',
      trackingCode: '1Z4A7W68942811',
      shippedAt: today - 8 * DAY_MS + 16 * HOUR,
      estimatedDelivery: today - 4 * DAY_MS,
      issue: {
        code: 'NO_SCAN',
        summary: 'No tracking scan for 6 days; carrier opened a trace and considers the parcel lost.',
        lastLocation: 'Cologne gateway, DE',
        lastScanAt: today - 6 * DAY_MS + 3 * HOUR,
      },
    },
    {
      receiptId: 3401557003,
      createdAt: today - 7 * DAY_MS + 9 * HOUR,
      buyer: { name: 'James W.', city: 'Manchester', country: 'GB', buyerUserId: 710010713 },
      lines: [{ sku: 'LC-PLNT-SPK', qty: 1 }],
      state: 'delayed',
      carrier: 'UPS',
      trackingCode: '1Z4A7W69047540',
      shippedAt: today - 6 * DAY_MS + 17 * HOUR,
      estimatedDelivery: today - 2 * DAY_MS,
      issue: {
        code: 'DAMAGED',
        summary: 'Box crushed in transit; recipient refused delivery, parcel on its way back.',
        lastLocation: 'Manchester depot, GB',
        lastScanAt: today - 1 * DAY_MS + 11 * HOUR,
      },
    },
  ];
  buyerIdx = 3;

  // Every other unit sold in the last 30 days, shuffled into orders of 1-3 lines.
  const pool: string[] = [];
  for (const p of PRODUCTS) {
    const already = troubled.flatMap((o) => o.lines).filter((l) => l.sku === p.sku).reduce((s, l) => s + l.qty, 0);
    for (let i = 0; i < p.unitsLast30Days - already; i++) pool.push(p.sku);
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const orders: Order[] = [...troubled];
  let n = 0;
  while (pool.length) {
    const size = Math.min(pool.length, rnd() < 0.55 ? 1 : rnd() < 0.7 ? 2 : 3);
    const units = pool.splice(0, size);
    const lines: OrderLine[] = [];
    for (const sku of units) {
      const l = lines.find((x) => x.sku === sku);
      if (l) l.qty++;
      else lines.push({ sku, qty: 1 });
    }
    // Spread over the last 30 days, a little denser towards today.
    const offset = Math.floor(Math.pow(rnd(), 1.25) * 29);
    const createdAt = today - offset * DAY_MS + (8 + Math.floor(rnd() * 13)) * HOUR;
    const buyer = nextBuyer();
    const order: Order = { receiptId: nextReceipt++, createdAt, buyer, lines, state: 'unshipped' };
    if (offset >= 2) {
      order.carrier = carrierFor(buyer.country);
      order.trackingCode = tracking(order.carrier, ++n);
      order.shippedAt = createdAt + DAY_MS + 5 * HOUR;
      order.estimatedDelivery = order.shippedAt + 4 * DAY_MS;
      if (offset >= 6) {
        order.state = 'delivered';
        order.deliveredAt = order.shippedAt + (3 + Math.floor(rnd() * 2)) * DAY_MS;
      } else {
        order.state = 'in_transit';
      }
    }
    orders.push(order);
  }
  return orders.sort((a, b) => b.createdAt - a.createdAt);
}

export function orderTotal(o: Order): number {
  return o.lines.reduce((s, l) => s + productBySku(l.sku).price * l.qty, 0);
}

export function shippingCost(o: Order): number {
  return o.buyer.country === COMPANY.country ? 450 : ['US', 'CA'].includes(o.buyer.country) ? 1890 : 990;
}
