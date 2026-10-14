import { readFileSync } from 'fs';
import { join } from 'path';
import { listAdapters } from './catalog';
import {
  CatalogSearchEntry,
  editDistance,
  MAX_FUZZY,
  searchCatalog,
  searchTerms,
} from './catalog-search';

/** The catalog as a deployment offers it: unlisted adapters left out. */
const catalog = listAdapters()
  .filter((a) => !a.unlisted)
  .map((a) => ({ ...a, text: [a.description, a.category] }));

const slugs = (query: string) => searchCatalog(catalog, query).hits.map((h) => h.entry.slug);
const first = (query: string) => searchCatalog(catalog, query).hits[0];

describe('catalog search — the frontend copy', () => {
  it('is the same file as the backend one', () => {
    const backend = readFileSync(join(__dirname, 'catalog-search.ts'), 'utf8');
    const frontend = readFileSync(join(__dirname, '../../../frontend/src/lib/catalog-search.ts'), 'utf8');
    expect(frontend).toBe(backend);
  });
});

describe('catalog search — typos', () => {
  it.each([
    ['telgram', 'telegram-bot'],
    ['telegarm', 'telegram-bot'],
    ['telegrama', 'telegram-bot'],
    ['telegrane', 'telegram-bot'],
    ['etsi', 'etsy'],
    ['esty', 'etsy'],
    ['etsay', 'etsy'],
    ['shopfy', 'shopify'],
    ['ootto', 'otto-market'],
  ])('"%s" finds %s, as a fuzzy match', (query, slug) => {
    const result = searchCatalog(catalog, query);
    expect(result.hits.map((h) => h.entry.slug)).toContain(slug);
    expect(result.match).toBe('fuzzy');
    expect(result.missing).toEqual([]);
  });

  it('puts the closest name first', () => {
    expect(first('telgram').entry.slug).toBe('telegram-bot');
    expect(first('shopfy').entry.slug).toBe('shopify');
  });

  it('counts a swap of two letters as one edit', () => {
    expect(editDistance('telegarm', 'telegram', 2)).toBe(1);
    expect(editDistance('esty', 'etsy', 1)).toBe(1);
    expect(editDistance('telgram', 'telegram', 2)).toBe(1);
    expect(editDistance('slack', 'slab', 1)).toBe(2);
  });

  it('caps fuzzy results', () => {
    // "googel" is one edit from every Google connector.
    const result = searchCatalog(catalog, 'googel');
    expect(result.match).toBe('fuzzy');
    expect(result.hits.length).toBeLessThanOrEqual(MAX_FUZZY);
    expect(result.hits.every((h) => h.entry.slug.startsWith('google-'))).toBe(true);
  });
});

describe('catalog search — several words', () => {
  it('leaves out words that name no app', () => {
    expect(searchTerms('bot de telegram')).toEqual(['telegram']);
    expect(searchTerms('Integração para o Mercado Livre')).toEqual(['mercado', 'livre']);
    expect(searchTerms('Schnittstelle für Lexware')).toEqual(['lexware']);
    // Nothing but such words: they are what was searched for.
    expect(searchTerms('api')).toEqual(['api']);
  });

  it('"bot de telegram" finds Telegram first, directly', () => {
    const result = searchCatalog(catalog, 'bot de telegram');
    expect(result.hits[0].entry.slug).toBe('telegram-bot');
    expect(result.match).toBe('direct');
  });

  it('a typo among several words still finds the app', () => {
    expect(first('bot de telgram').entry.slug).toBe('telegram-bot');
    expect(first('@botfather').entry.slug).toBe('telegram-bot');
  });

  it('needs every word for a direct match', () => {
    const hits = searchCatalog(catalog, 'google sheets').hits;
    expect(hits[0].entry.slug).toBe('google-sheets');
    expect(hits.every((h) => h.match === 'direct')).toBe(true);
  });

  it('falls back to the apps matching some of the words, and names the missing one', () => {
    const both = searchCatalog(catalog, 'etsy openplz');
    expect(both.match).toBe('partial');
    expect(both.hits.slice(0, 2).map((h) => h.entry.slug).sort()).toEqual(['etsy', 'openplz']);

    const shop = searchCatalog(catalog, 'quarzwerk shop');
    expect(shop.match).toBe('partial');
    expect(shop.missing).toEqual(['quarzwerk']);
    expect(shop.hits.length).toBeGreaterThan(0);
  });
});

describe('catalog search — aliases', () => {
  it.each([
    ['mercado livre', 'mercado-libre'],
    ['mercadolivre', 'mercado-libre'],
    ['amocrm', 'amocrm'],
    ['amo crm', 'amocrm'],
    ['twitter', 'x'],
    ['lexoffice', 'lexware-office'],
    ['navision', 'dynamics-nav'],
    ['sap b1', 'sap-business-one'],
    ['sendinblue', 'brevo'],
  ])('"%s" finds %s first', (query, slug) => {
    const hit = first(query);
    expect(hit.entry.slug).toBe(slug);
    expect(hit.match).toBe('direct');
  });

  it('"facebook" finds the Meta connectors', () => {
    expect(slugs('facebook').slice(0, 3).sort()).toEqual(['instagram', 'meta-ads', 'whatsapp-business']);
    expect(slugs('fb').slice(0, 2).sort()).toEqual(['instagram', 'meta-ads']);
  });

  it('"d365" finds both Dynamics 365 connectors', () => {
    expect(slugs('d365').sort()).toEqual(['dynamics365-business-central', 'dynamics365-sales']);
  });

  it('every alias in the catalog finds its own adapter', () => {
    for (const a of catalog) {
      for (const alias of a.aliases ?? []) {
        expect({ alias, found: slugs(alias).includes(a.slug) }).toEqual({ alias, found: true });
      }
    }
  });
});

describe('catalog search — no false positives', () => {
  it('"sap" finds the SAP connectors and nothing that merely looks like it', () => {
    const result = searchCatalog(catalog, 'sap');
    expect(result.hits.length).toBeGreaterThan(3);
    expect(result.hits.every((h) => h.match === 'direct')).toBe(true);
    expect(result.hits.every((h) => h.entry.slug.startsWith('sap-'))).toBe(true);
  });

  it('"x" alone finds only X', () => {
    expect(slugs('x')).toEqual(['x']);
    expect(slugs('X')).toEqual(['x']);
  });

  it('short words never match fuzzily', () => {
    for (const q of ['sap', 'ads', 'crm', 'erp', 'hr', 'box']) {
      expect({ q, fuzzy: searchCatalog(catalog, q).hits.filter((h) => h.match !== 'direct').length }).toEqual({ q, fuzzy: 0 });
    }
  });

  it('a short typo needs the right first letter: "gmail" is not "email"', () => {
    expect(slugs('gmail')[0]).toBe('gmail');
    expect(searchCatalog(catalog, 'gmail').hits.some((h) => h.match === 'fuzzy')).toBe(false);
  });

  it('a word nothing resembles finds nothing and is reported missing', () => {
    expect(searchCatalog(catalog, 'zzqx')).toEqual({ hits: [], terms: ['zzqx'], missing: ['zzqx'], match: 'none' });
    expect(searchCatalog(catalog, '   ').hits).toEqual([]);
  });

  it('a well-known app found directly is not followed by fuzzy look-alikes beyond the minimum', () => {
    const result = searchCatalog(catalog, 'telegram');
    expect(result.hits[0].entry.slug).toBe('telegram-bot');
    expect(result.hits.filter((h) => h.match === 'fuzzy')).toEqual([]);
  });
});

describe('catalog search — ranking', () => {
  const entry = (slug: string, name: string, extra: Partial<CatalogSearchEntry> = {}): CatalogSearchEntry => ({
    slug,
    name,
    ...extra,
  });
  const entries = [
    entry('notes-pro', 'Notes Pro', { text: ['Sync your acme invoices'] }),
    entry('acme-cloud', 'Acme Cloud'),
    entry('acme', 'Acme'),
    entry('acmeworks', 'AcmeWorks'),
    entry('zeta', 'Zeta', { aliases: ['Acme'] }),
    entry('acne', 'Acne Studio'),
  ];

  it('orders the name, a whole word, an alias, a word start, then other text', () => {
    expect(searchCatalog(entries, 'acme').hits.map((h) => [h.entry.slug, h.match])).toEqual([
      ['acme', 'direct'],
      ['zeta', 'direct'],
      ['acme-cloud', 'direct'],
      ['acmeworks', 'direct'],
      ['notes-pro', 'direct'],
    ]);
  });

  it('ranks fuzzy matches below every direct one, and adds them only when direct ones are few', () => {
    const few = [entry('acme', 'Acme'), entry('acne', 'Acne Studio')];
    expect(searchCatalog(few, 'acme').hits.map((h) => [h.entry.slug, h.match])).toEqual([
      ['acme', 'direct'],
      ['acne', 'fuzzy'],
    ]);
    // Five direct matches: "acne" (one letter off) is left out.
    expect(searchCatalog(entries, 'acme').hits.map((h) => h.entry.slug)).not.toContain('acne');
  });

  it('breaks ties by priority', () => {
    const tied = [entry('acme-b', 'Acme B'), entry('acme-a', 'Acme A', { priority: 5 })];
    expect(searchCatalog(tied, 'acme').hits.map((h) => h.entry.slug)).toEqual(['acme-a', 'acme-b']);
  });
});
