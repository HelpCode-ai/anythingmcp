import { readFileSync } from 'fs';
import { join } from 'path';
import { getAdapter, listAdapters } from './catalog';
import {
  CatalogSearchEntry,
  editDistance,
  FILE_SEARCH_INTENTS,
  fileSearchIntent,
  MAX_FILE_SEARCH,
  MAX_FUZZY,
  MAX_QUERY_LENGTH,
  queryWords,
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

describe('catalog search — query words', () => {
  it('trims outer punctuation and keeps inner punctuation', () => {
    expect(queryWords('  @BotFather, "Société"!  s/4hana ')).toEqual(['botfather', 'societe', 's/4hana']);
    expect(queryWords('!!! ...')).toEqual([]);
  });

  it('reads at most MAX_QUERY_LENGTH characters', () => {
    expect(queryWords(`${'a'.repeat(MAX_QUERY_LENGTH - 3)} b c`)).toEqual(['a'.repeat(MAX_QUERY_LENGTH - 3), 'b']);
  });

  it('handles a long run of punctuation in linear time (code scanning alert 655)', () => {
    // The old trim regex took ~300 ms on 30k characters of this shape.
    const word = `a${'!'.repeat(400_000)}a`;
    const started = Date.now();
    expect(queryWords(word)).toEqual(['a']);
    expect(queryWords(`x${'!'.repeat(MAX_QUERY_LENGTH)}`)).toEqual(['x']);
    expect(searchCatalog(catalog, word).hits).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
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
    // "googel" is one edit from every Google connector, including "Google
    // BigQuery", whose slug has no google- prefix.
    const result = searchCatalog(catalog, 'googel');
    expect(result.match).toBe('fuzzy');
    expect(result.hits.length).toBeLessThanOrEqual(MAX_FUZZY);
    expect(
      result.hits.every((h) => h.entry.slug.startsWith('google-') || h.entry.name.startsWith('Google ')),
    ).toBe(true);
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

  it.each([
    // Other adapters match more of the other words in their description.
    ['instagram direct message', 'instagram'],
    ['etsy listings search', 'etsy'],
    ['etsy open api v3', 'etsy'],
    ['gmail email inbox', 'gmail'],
    // Others match every word, WhatsApp Business only the app's name.
    ['whatsapp messages chats', 'whatsapp-business'],
    ['telegram send message', 'telegram-bot'],
  ])('"%s" puts the app the query names first', (query, slug) => {
    expect(first(query).entry.slug).toBe(slug);
  });

  it('lists the named apps in the order of the query words', () => {
    expect(slugs('etsy printify printful gelato').slice(0, 4)).toEqual(['etsy', 'printify', 'printful', 'gelato']);
  });

  it('marks a named app the other words did not match as partial', () => {
    const result = searchCatalog(catalog, 'whatsapp messages chats');
    expect(result.hits[0].match).toBe('partial');
    expect(result.hits.slice(1).some((h) => h.match === 'direct')).toBe(true);
  });

  it('a word starting many names names no app: "google calendar events"', () => {
    expect(first('google calendar events').entry.slug).toBe('google-calendar');
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
    expect(slugs('facebook').slice(0, 4).sort()).toEqual(['instagram', 'meta-ads', 'meta-catalog', 'whatsapp-business']);
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
    expect(searchCatalog(catalog, 'zzqx')).toEqual({ hits: [], terms: ['zzqx'], missing: ['zzqx'], match: 'none', fileSearch: [] });
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

describe('catalog search — File Search suggestions', () => {
  /** The catalog as the Cloud offers it: self-hosted-only adapters left out too. */
  const cloud = catalog.filter((a) => !a.selfHostOnly);
  const fileSearchSlugs = new Set(
    listAdapters()
      .filter((a) => (getAdapter(a.slug)?.connector.type as string) === 'FILE_SEARCH')
      .map((a) => a.slug),
  );
  const top = (entries: typeof catalog, query: string, n = 3) =>
    searchCatalog(entries, query).hits.slice(0, n).map((h) => h.entry.slug);
  const suggested = (entries: typeof catalog, query: string) =>
    searchCatalog(entries, query).fileSearch.map((e) => e.slug);

  it('names only File Search entries that exist in the catalog', () => {
    for (const intent of FILE_SEARCH_INTENTS) {
      for (const slug of intent.slugs) expect({ slug, fileSearch: fileSearchSlugs.has(slug) }).toEqual({ slug, fileSearch: true });
    }
  });

  it.each([
    ['synology', ['synology', 'synology-file-search']],
    ['nextcloud', ['nextcloud', 'nextcloud-file-search', 'webdav']],
    ['qnap', ['qnap-file-search']],
    ['owncloud', ['owncloud-file-search', 'webdav']],
    ['fritzbox', ['fritzbox-file-search']],
    ['Fritz!Box', ['fritzbox-file-search']],
    ['sftp', ['sftp']],
    ['ftp', ['ftp']],
    ['webdav', ['webdav']],
    ['minio', ['s3-file-search']],
    ['storage box', ['hetzner-storage-box']],
  ])('"%s" puts File Search at the top, next to the API connector: %j', (query, expected) => {
    expect(top(cloud, query, expected.length)).toEqual(expected);
  });

  it.each(['nas', 'file server', 'Dateiserver', 'Netzlaufwerk', 'documents', 'Dokumente', 'pdf', 'dateiablage'])(
    '"%s" suggests File Search among the first results',
    (query) => {
      const result = searchCatalog(cloud, query);
      expect(result.fileSearch.length).toBeGreaterThan(0);
      const first = result.hits.slice(0, 4).map((h) => h.entry.slug);
      expect(first.filter((s) => fileSearchSlugs.has(s)).length).toBeGreaterThan(0);
      expect(result.missing).toEqual([]);
    },
  );

  it('suggests the network folder on self-hosted only', () => {
    expect(suggested(catalog, 'Netzlaufwerk')).toContain('network-folder');
    expect(suggested(catalog, 'file server')[0]).toBe('network-folder');
    for (const q of ['Netzlaufwerk', 'file server', 'nas', 'smb', 'documents']) {
      expect({ q, slugs: suggested(cloud, q) }).toEqual({ q, slugs: expect.not.arrayContaining(['network-folder']) });
      expect(searchCatalog(cloud, q).hits.map((h) => h.entry.slug)).not.toContain('network-folder');
    }
    expect(suggested(cloud, 'Netzlaufwerk')).toEqual(['sftp', 'webdav']);
  });

  it('suggests nothing for cloud drives, which File Search does not read', () => {
    for (const q of ['sharepoint', 'onedrive', 'google drive', 'my google drive files', 'dropbox', 'sharepoint documents', 'icloud']) {
      expect({ q, slugs: suggested(catalog, q) }).toEqual({ q, slugs: [] });
      expect({ q, flagged: searchCatalog(catalog, q).hits.some((h) => h.suggested) }).toEqual({ q, flagged: false });
    }
  });

  it('suggests nothing for a query about another app', () => {
    for (const q of ['etsy', 'telegram', 'sap', 'excel', 'box', 'hubspot', 'zzqx']) {
      expect({ q, slugs: suggested(catalog, q) }).toEqual({ q, slugs: [] });
    }
  });

  it.each([
    ['lexware dokumente', 'lexware-office'],
    ['lexware pdf', 'lexware-office'],
    ['excel files', 'microsoft-excel'],
    ['telegram send document', 'telegram-bot'],
  ])('"%s": a word about documents next to an app suggests nothing, the app comes first', (query, slug) => {
    const result = searchCatalog(cloud, query);
    expect(result.fileSearch).toEqual([]);
    expect(result.hits[0].entry.slug).toBe(slug);
    expect(result.hits.some((h) => h.suggested)).toBe(false);
  });

  it('keeps a word about documents when the query names more than one other thing', () => {
    // "gmail attachments pdf": no suggestion, but "pdf" still counts for the match.
    const result = searchCatalog(cloud, 'gmail attachments pdf');
    expect(result.fileSearch).toEqual([]);
    expect(result.terms).toContain('pdf');
  });

  it.each([
    ['amazon', ['amazon-ads', 'amazon-seller'], 's3-file-search'],
    ['cloudflare', ['cloudflare'], 's3-file-search'],
    ['digitalocean', ['digitalocean'], 's3-file-search'],
    ['hetzner', ['hetzner-cloud', 'hetzner-storage-box'], 'sftp'],
  ])('"%s" puts the apps it names before a File Search entry met only through an alias', (query, apps, alias) => {
    const all = slugs(query);
    expect(all).toContain(alias);
    for (const app of apps) expect(all.indexOf(app)).toBeLessThan(all.indexOf(alias));
    // ...and below every other direct result too.
    const hits = searchCatalog(cloud, query).hits;
    const at = hits.findIndex((h) => h.entry.slug === alias);
    expect(hits.slice(at + 1).every((h) => fileSearchSlugs.has(h.entry.slug) || h.match !== 'direct')).toBe(true);
  });

  it('still finds a File Search entry by an alias alone: "aws" is S3', () => {
    expect(slugs('aws')[0]).toBe('s3-file-search');
  });

  it('ranks a typo above a File Search entry met only through an alias: "hero"', () => {
    const all = slugs('hero');
    expect(all.indexOf('here-geocoding')).toBeLessThan(all.indexOf('qnap-file-search'));
  });

  it.each(['excel', 'word', 'outlook'])(
    '"%s" leaves out File Search entries that only mention the file type in their description',
    (query) => {
      expect(slugs(query).filter((s) => fileSearchSlugs.has(s))).toEqual([]);
    },
  );

  it.each([
    ['web search', 'brave-search'],
    ['web search internet wikipedia', 'brave-search'],
    ['etsy listing create digital file', 'etsy'],
  ])('"%s" is about %s, not File Search: "File Search" and the start of "WebDAV" do not name an entry', (query, app) => {
    const all = slugs(query);
    expect(all[0]).toBe(app);
    // Below every other result, if listed at all.
    const firstFs = all.findIndex((s) => fileSearchSlugs.has(s));
    if (firstFs >= 0) expect(all.slice(firstFs).every((s) => fileSearchSlugs.has(s))).toBe(true);
  });

  it('"file search" still lists the File Search entries', () => {
    const result = searchCatalog(cloud, 'file search');
    expect(result.fileSearch.length).toBeGreaterThan(0);
    expect(result.hits.slice(0, 8).every((h) => fileSearchSlugs.has(h.entry.slug))).toBe(true);
  });

  it('caps the suggestions and lists none twice', () => {
    const result = searchCatalog(catalog, 'synology nas file server documents');
    expect(result.fileSearch.length).toBeLessThanOrEqual(MAX_FILE_SEARCH);
    expect(result.fileSearch[0].slug).toBe('synology-file-search');
    const all = result.hits.map((h) => h.entry.slug);
    expect(new Set(all).size).toBe(all.length);
  });

  it('marks an entry the query did not match by itself as suggested', () => {
    const result = searchCatalog(cloud, 'dateiablage');
    expect(result.match).toBe('suggested');
    expect(result.hits.every((h) => h.suggested && h.match === 'suggested')).toBe(true);
    // An entry that matched keeps how it matched.
    const synology = searchCatalog(cloud, 'synology').hits.find((h) => h.entry.slug === 'synology-file-search')!;
    expect(synology).toEqual(expect.objectContaining({ match: 'direct', suggested: true }));
  });

  it('matches several words written apart or together', () => {
    expect(fileSearchIntent('File-Server').slugs[0]).toBe('network-folder');
    expect(fileSearchIntent('fileserver').slugs[0]).toBe('network-folder');
    expect(fileSearchIntent('Hetzner Storage Box').slugs).toEqual(['hetzner-storage-box']);
    expect(fileSearchIntent('cartella di rete').slugs[0]).toBe('network-folder');
  });

  it('suggests only entries the caller passed in', () => {
    const entries = [{ slug: 'synology', name: 'Synology' }];
    const result = searchCatalog(entries, 'synology');
    expect(result.fileSearch).toEqual([]);
    expect(result.hits.map((h) => h.entry.slug)).toEqual(['synology']);
  });
});
