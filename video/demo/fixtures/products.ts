/**
 * Lumen & Clay: the fictional ceramics studio of the demo video.
 *
 * Every system in the demo (Etsy, SAP, the logistics API) is built from this
 * one product list, so a SKU sold on Etsy is the same material in SAP and the
 * same parcel content in logistics. Nothing here is real data.
 */

export const COMPANY = {
  name: 'Lumen & Clay',
  shopName: 'LumenAndClay',
  ownerLogin: 'lumenandclay',
  ownerName: 'Alex Rivera',
  ownerEmail: 'alex@lumenandclay.example',
  userId: 902214,
  shopId: 48213377,
  currency: 'EUR',
  city: 'Lisbon',
  country: 'PT',
};

export interface Product {
  sku: string;
  listingId: number;
  title: string;
  /** Price in cents. */
  price: number;
  section: 'Mugs & Cups' | 'Vases' | 'Planters' | 'Tableware' | 'Lighting';
  /** Units sold on Etsy in the last 30 days. Drives the generated receipts. */
  unitsLast30Days: number;
  views: number;
  favorers: number;
  tags: string[];
}

export const PRODUCTS: Product[] = [
  { sku: 'LC-MUG-SAGE', listingId: 1528840311, title: 'Sage Glaze Stoneware Mug, 350 ml', price: 3200, section: 'Mugs & Cups', unitsLast30Days: 23, views: 4812, favorers: 611, tags: ['mug', 'stoneware', 'sage', 'handmade'] },
  { sku: 'LC-VASE-TALL', listingId: 1528840342, title: 'Tall Ribbed Vase, Chalk White', price: 6800, section: 'Vases', unitsLast30Days: 14, views: 3920, favorers: 540, tags: ['vase', 'ribbed', 'white', 'minimal'] },
  { sku: 'LC-PLNT-SPK', listingId: 1528840377, title: 'Speckled Planter with Saucer, 14 cm', price: 3800, section: 'Planters', unitsLast30Days: 12, views: 2877, favorers: 402, tags: ['planter', 'speckled', 'saucer'] },
  { sku: 'LC-BWL-RAMEN', listingId: 1528840390, title: 'Ramen Bowl, Deep Indigo', price: 3600, section: 'Tableware', unitsLast30Days: 9, views: 2210, favorers: 288, tags: ['bowl', 'ramen', 'indigo'] },
  { sku: 'LC-MUG-SPECK', listingId: 1528840405, title: 'Speckled Oat Mug, 300 ml', price: 3000, section: 'Mugs & Cups', unitsLast30Days: 8, views: 1954, favorers: 251, tags: ['mug', 'speckled', 'oat'] },
  { sku: 'LC-CNDL-HLD', listingId: 1528840418, title: 'Candle Holder, Ash Glaze', price: 2400, section: 'Lighting', unitsLast30Days: 7, views: 1420, favorers: 190, tags: ['candle', 'ash glaze', 'gift'] },
  { sku: 'LC-LAMP-LUM', listingId: 1528840433, title: 'Lumen Table Lamp, Ceramic Base', price: 12900, section: 'Lighting', unitsLast30Days: 6, views: 3310, favorers: 702, tags: ['lamp', 'ceramic', 'lighting'] },
  { sku: 'LC-BWL-NEST', listingId: 1528840447, title: 'Nesting Bowls, Set of 3', price: 5800, section: 'Tableware', unitsLast30Days: 6, views: 1688, favorers: 233, tags: ['bowls', 'set', 'nesting'] },
  { sku: 'LC-VASE-BUD', listingId: 1528840460, title: 'Bud Vase Trio, Terracotta', price: 4200, section: 'Vases', unitsLast30Days: 5, views: 1502, favorers: 208, tags: ['bud vase', 'terracotta', 'trio'] },
  { sku: 'LC-CUP-ESP', listingId: 1528840474, title: 'Espresso Cups, Set of 4', price: 4400, section: 'Mugs & Cups', unitsLast30Days: 4, views: 1105, favorers: 164, tags: ['espresso', 'cups', 'set'] },
  { sku: 'LC-PLNT-HNG', listingId: 1528840489, title: 'Hanging Planter, Moss Glaze', price: 4500, section: 'Planters', unitsLast30Days: 4, views: 1276, favorers: 181, tags: ['hanging planter', 'moss'] },
  { sku: 'LC-PLT-DIN', listingId: 1528840502, title: 'Dinner Plates, Sand Matte (Set of 2)', price: 5400, section: 'Tableware', unitsLast30Days: 3, views: 980, favorers: 122, tags: ['plates', 'dinnerware', 'matte'] },
];

export const SECTIONS: { id: number; title: Product['section'] }[] = [
  { id: 40117001, title: 'Mugs & Cups' },
  { id: 40117002, title: 'Vases' },
  { id: 40117003, title: 'Planters' },
  { id: 40117004, title: 'Tableware' },
  { id: 40117005, title: 'Lighting' },
];

export function productBySku(sku: string): Product {
  const p = PRODUCTS.find((x) => x.sku === sku);
  if (!p) throw new Error(`Unknown SKU ${sku}`);
  return p;
}

/** Deterministic PRNG, so every request rebuilds the same universe. */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Midnight UTC of `now`, so generated timestamps don't drift within a day. */
export function dayAnchor(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

export const DAY_MS = 24 * 60 * 60 * 1000;
