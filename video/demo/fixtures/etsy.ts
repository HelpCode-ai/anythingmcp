import { COMPANY, DAY_MS, PRODUCTS, SECTIONS, dayAnchor, mulberry32, productBySku } from './products';
import { Order, buildOrders, orderTotal, shippingCost } from './orders';
import { stockRows } from './sap';

/**
 * Etsy Open API v3 shapes for Lumen & Clay, trimmed to the fields the Etsy
 * adapter's nine tools read.
 */

const money = (cents: number) => ({ amount: cents, divisor: 100, currency_code: COMPANY.currency });
const sec = (ms: number) => Math.floor(ms / 1000);

export function authenticatedUser() {
  return { user_id: COMPANY.userId, shop_id: COMPANY.shopId, primary_email: COMPANY.ownerEmail, login_name: COMPANY.ownerLogin };
}

export function shop(now: Date) {
  return {
    shop_id: COMPANY.shopId,
    shop_name: COMPANY.shopName,
    user_id: COMPANY.userId,
    title: 'Handmade stoneware from Lisbon',
    announcement: 'Every piece is thrown, glazed and fired in our Lisbon studio. Ships worldwide within 2 working days.',
    currency_code: COMPANY.currency,
    is_vacation: false,
    listing_active_count: PRODUCTS.length,
    transaction_sold_count: 4218,
    review_average: 4.9,
    review_count: 1136,
    num_favorers: 9820,
    languages: ['en-US', 'pt'],
    url: `https://www.etsy.com/shop/${COMPANY.shopName}`,
    create_date: sec(Date.UTC(2019, 2, 14)),
    last_updated_timestamp: sec(dayAnchor(now) - 2 * 60 * 60 * 1000),
    shop_location_country_iso: COMPANY.country,
    sections: SECTIONS.map((s) => ({ shop_section_id: s.id, title: s.title })),
  };
}

export function listing(sku: string) {
  const p = productBySku(sku);
  const stock = stockRows().filter((r) => r.Material === sku).reduce((s, r) => s + r.UnrestrictedStock, 0);
  return {
    listing_id: p.listingId,
    user_id: COMPANY.userId,
    shop_id: COMPANY.shopId,
    title: p.title,
    description: `${p.title}. Wheel-thrown in our Lisbon studio, food safe, dishwasher safe.`,
    state: 'active',
    quantity: stock,
    shop_section_id: SECTIONS.find((s) => s.title === p.section)!.id,
    url: `https://www.etsy.com/listing/${p.listingId}`,
    views: p.views,
    num_favorers: p.favorers,
    price: money(p.price),
    skus: [p.sku],
    tags: p.tags,
    who_made: 'i_did',
    when_made: 'made_to_order',
    is_customizable: false,
    creation_timestamp: sec(Date.UTC(2024, 0, 10) + p.listingId % 300 * DAY_MS),
  };
}

export function activeListings() {
  return PRODUCTS.map((p) => listing(p.sku));
}

function receipt(o: Order) {
  const subtotal = orderTotal(o);
  const ship = shippingCost(o);
  return {
    receipt_id: o.receiptId,
    receipt_type: 0,
    seller_user_id: COMPANY.userId,
    buyer_user_id: o.buyer.buyerUserId,
    name: o.buyer.name,
    city: o.buyer.city,
    country_iso: o.buyer.country,
    status: o.state === 'delivered' ? 'Completed' : 'Paid',
    is_paid: true,
    is_shipped: o.state !== 'unshipped',
    create_timestamp: sec(o.createdAt),
    created_timestamp: sec(o.createdAt),
    update_timestamp: sec(o.deliveredAt ?? o.shippedAt ?? o.createdAt),
    updated_timestamp: sec(o.deliveredAt ?? o.shippedAt ?? o.createdAt),
    subtotal: money(subtotal),
    total_shipping_cost: money(ship),
    grandtotal: money(subtotal + ship),
    shipments: o.trackingCode
      ? [{ receipt_shipping_id: o.receiptId + 17, shipment_notification_timestamp: sec(o.shippedAt!), carrier_name: o.carrier, tracking_code: o.trackingCode }]
      : [],
    transactions: o.lines.map((l, i) => {
      const p = productBySku(l.sku);
      return {
        transaction_id: o.receiptId * 10 + i,
        title: p.title,
        listing_id: p.listingId,
        sku: p.sku,
        quantity: l.qty,
        price: money(p.price),
        shipping_cost: money(i === 0 ? ship : 0),
        is_digital: false,
      };
    }),
  };
}

export function receipts(now: Date) {
  return buildOrders(now).map(receipt);
}

export function receiptById(now: Date, id: number) {
  const o = buildOrders(now).find((x) => x.receiptId === id);
  return o ? receipt(o) : undefined;
}

const REVIEW_TEXTS = [
  'Even more beautiful in person. The glaze is stunning.',
  'Arrived quickly and perfectly packed. Will order again!',
  'My morning coffee has never looked better.',
  'Gorgeous piece, the photos do not do it justice.',
  'Lovely weight and finish. A perfect gift.',
  'Beautiful craftsmanship and a sweet handwritten note.',
  'Exactly as described, and so well made.',
];

export function reviews(now: Date) {
  const rnd = mulberry32(77);
  return buildOrders(now)
    .filter((o) => o.state === 'delivered')
    .slice(0, 14)
    .map((o, i) => {
      const p = productBySku(o.lines[0].sku);
      return {
        shop_id: COMPANY.shopId,
        listing_id: p.listingId,
        transaction_id: o.receiptId * 10,
        buyer_user_id: o.buyer.buyerUserId,
        rating: rnd() < 0.88 ? 5 : 4,
        review: REVIEW_TEXTS[i % REVIEW_TEXTS.length],
        language: 'en',
        create_timestamp: sec(o.deliveredAt! + DAY_MS),
        created_timestamp: sec(o.deliveredAt! + DAY_MS),
      };
    });
}
