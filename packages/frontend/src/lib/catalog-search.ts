/**
 * Search over the connector catalog, shared by every place that searches it:
 * the chat (setup_find_connectors / anythingmcp_find_connectors on the shared
 * /mcp endpoint), the dashboard store and the /welcome page.
 *
 * This file exists twice, byte for byte: packages/backend/src/adapters/
 * catalog-search.ts and packages/frontend/src/lib/catalog-search.ts (the
 * frontend image is built from its own package, so it cannot import the
 * backend). catalog-search.spec.ts fails when the two differ. Edit the backend
 * copy and copy it over. No imports, no Node or DOM APIs.
 *
 * How a query is matched:
 * 1. Words of the query are lowercased, accents dropped, and words that name
 *    no app ("bot", "de", "api", "connector", "für"...) left out, unless the
 *    query is made only of such words. "bot de telegram" looks for telegram.
 * 2. Direct matches: every word equals or starts a word of the adapter's slug,
 *    name or aliases, or starts a word of its other text (description,
 *    category). The order is: the whole query is the name or an alias, then
 *    whole words, then word starts, then the other text.
 * 3. Fuzzy matches, only when there are fewer than MIN_RESULTS direct ones:
 *    a word within a Damerau-Levenshtein distance of 1 (words of 4-6 letters)
 *    or 2 (7 or more) of a word of the slug, name or aliases, with the same
 *    first letter for the short ones. "telgram", "esty" and "shopfy" find
 *    Telegram, Etsy and Shopify. Words under 4 letters never match fuzzily,
 *    so "sap" or "ads" do not pull in half the catalog. Capped, and ranked
 *    below every direct match.
 * 4. Partial matches, only for a query of several words that matched nothing
 *    as a whole: the adapters matching the most words ("etsy openplz").
 * 5. A word of a query of several words that starts the slug or the name of
 *    an app goes first: "instagram direct message" is Instagram, "etsy
 *    listings search" is Etsy, even when another adapter matches more of the
 *    other words in its description. The other words only say what to do
 *    with the app. A word starting the names of more than MAX_NAMED adapters
 *    ("google", "microsoft") names no single app and moves nothing, and a
 *    first result matching the whole query by name ("telegram bot") stays.
 *
 * A one-letter query ("x") matches only an adapter whose slug, name or alias
 * is exactly that letter.
 *
 * File Search suggestions (FILE_SEARCH_INTENTS): a query about a storage
 * system or about documents ("synology", "nas", "Dateiserver", "pdf") also
 * brings the File Search entries that read it, so people learn the AI can
 * search inside the files and not only call the system's API. They go first,
 * or right after a result named exactly like the query ("synology": the DSM
 * API connector, then Synology File Search). Only entries the caller passed
 * in are suggested: on the Cloud the self-hosted "network-folder" is not
 * among them. Cloud drives (SharePoint, OneDrive, Google Drive, Dropbox) are
 * not File Search sources and get no suggestion.
 *
 * A word about documents in general ("pdf", "Dokumente") suggests nothing
 * when another word names an app ("lexware dokumente", "telegram send
 * document"): those documents are in that app. And a query about something
 * else ("amazon", "excel") ranks a File Search entry it only meets through
 * an alias ("Amazon S3") below the apps it names, and leaves out one it only
 * meets in the description ("PDF, Excel, Word and Outlook files"). Such a
 * query ranks the entry as an app only when every word names it, and the
 * "File Search" in its name counts as an alias: "web search" is Brave Search,
 * not "WebDAV / Nextcloud (File Search)".
 */

export interface CatalogSearchEntry {
  slug: string;
  name: string;
  /** Other names people use for the app: a former name, a translation, a short form. */
  aliases?: readonly string[];
  /** Other text a word may start a word of: description, category, region. */
  text?: readonly string[];
  /** Higher ranks first among equal matches. */
  priority?: number;
}

/**
 * How a result matched: see the steps above. 'suggested' is a File Search
 * entry the query did not match by itself, added for a storage query.
 */
export type CatalogMatchKind = 'direct' | 'fuzzy' | 'partial' | 'suggested';

export interface CatalogSearchHit<T> {
  entry: T;
  match: CatalogMatchKind;
  score: number;
  /** Placed by a File Search suggestion (see FILE_SEARCH_INTENTS). */
  suggested?: boolean;
}

export interface CatalogSearchResult<T> {
  hits: CatalogSearchHit<T>[];
  /** The query words that were matched against the catalog. */
  terms: string[];
  /** Words no adapter matched in any way: the app the user looked for and we lack. */
  missing: string[];
  /** How the first result matched, or 'none' when nothing did. */
  match: CatalogMatchKind | 'none';
  /**
   * File Search entries suggested for a storage or document query, best
   * first; they are among `hits` too. Empty when the query is about neither.
   */
  fileSearch: T[];
}

/** Fewer direct results than this, and fuzzy matches fill up to it. */
export const MIN_RESULTS = 3;
/** At most this many fuzzy results when there is no direct one. */
export const MAX_FUZZY = 5;
/** At most this many partial results. */
export const MAX_PARTIAL = 10;
/** At most this many File Search suggestions. */
export const MAX_FILE_SEARCH = 3;
/** A word starting more names than this ("google") names no single app (step 5). */
export const MAX_NAMED = 5;

/**
 * Storage and document queries, and the File Search entries that answer
 * them, best first. A trigger is one word or several written together
 * ("file server" and "fileserver" are both "fileserver"), compared without
 * accents, case or punctuation, and matched against consecutive query words
 * (stopwords included: "server" is one). Only the systems File Search reads:
 * SFTP, FTP/FTPS, WebDAV (Nextcloud, ownCloud), S3, the NAS presets,
 * Fritz!Box, Hetzner Storage Box and, self-hosted, a network folder.
 */
export const FILE_SEARCH_INTENTS: ReadonlyArray<{
  triggers: readonly string[];
  slugs: readonly string[];
  /** Documents in general, not a storage system: yields to a word naming an app. */
  generic?: boolean;
}> = [
  { triggers: ['synology', 'diskstation', 'dsm'], slugs: ['synology-file-search'] },
  { triggers: ['qnap', 'qts', 'quts', 'qutshero'], slugs: ['qnap-file-search'] },
  { triggers: ['nextcloud', 'storageshare'], slugs: ['nextcloud-file-search', 'webdav'] },
  { triggers: ['owncloud'], slugs: ['owncloud-file-search', 'webdav'] },
  { triggers: ['fritzbox', 'fritz', 'fritznas', 'myfritz'], slugs: ['fritzbox-file-search'] },
  { triggers: ['storagebox', 'hetznerstoragebox'], slugs: ['hetzner-storage-box'] },
  {
    triggers: [
      's3', 'amazons3', 'awss3', 'minio', 'wasabi', 'bucket', 'buckets', 'objectstorage',
      'cloudflarer2', 'backblaze', 'backblazeb2', 'digitaloceanspaces',
    ],
    slugs: ['s3-file-search'],
  },
  { triggers: ['sftp', 'ssh', 'scp'], slugs: ['sftp'] },
  { triggers: ['ftp', 'ftps'], slugs: ['ftp'] },
  { triggers: ['webdav', 'hidrive'], slugs: ['webdav'] },
  {
    triggers: ['nas', 'nasshare', 'nasserver', 'nassystem'],
    slugs: ['synology-file-search', 'qnap-file-search', 'network-folder', 'sftp'],
  },
  {
    triggers: [
      'fileserver', 'dateiserver', 'netzlaufwerk', 'netzlaufwerke', 'laufwerk', 'networkdrive',
      'networkshare', 'networkfolder', 'netzwerkordner', 'netzwerkfreigabe', 'netzwerkspeicher',
      'smb', 'cifs', 'nfs', 'samba', 'windowsshare', 'cartelladirete', 'serverdeifile',
    ],
    slugs: ['network-folder', 'sftp', 'webdav'],
  },
  {
    triggers: [
      'document', 'documents', 'dokument', 'dokumente', 'documento', 'documenti', 'documentos',
      'pdf', 'pdfs', 'files', 'dateien', 'dateiablage', 'filesearch', 'dateisuche',
      'volltextsuche', 'fulltextsearch',
    ],
    slugs: ['network-folder', 'sftp', 'webdav'],
    generic: true,
  },
];

/** Every File Search entry: the ones FILE_SEARCH_INTENTS suggests. */
const FILE_SEARCH_SLUGS = new Set(FILE_SEARCH_INTENTS.flatMap((x) => x.slugs));

/** The "File Search" in each such entry's slug and name: an alias, not a name word. */
const FILE_SEARCH_MARKERS = new Set(['file', 'search']);

/**
 * Cloud drives: File Search does not read them, they have connectors of
 * their own. A query naming one gets no File Search suggestion.
 */
const NOT_FILE_SEARCH = ['sharepoint', 'onedrive', 'googledrive', 'gdrive', 'dropbox', 'icloud'];

/**
 * Words that do not name an app, in the languages people search in (en, de,
 * es, it, pt, fr). Written without accents: queries are compared that way.
 */
const STOPWORDS = new Set([
  // What every result is anyway
  'api', 'apis', 'mcp', 'connector', 'connectors', 'connect', 'connection', 'integration', 'integrations',
  'integrate', 'bot', 'bots', 'app', 'apps', 'plugin', 'plugins', 'server', 'tool', 'tools',
  'conector', 'conectores', 'integracion', 'integraciones', 'integracao', 'integracoes',
  'connettore', 'connettori', 'integrazione', 'integrazioni', 'connecteur', 'connecteurs',
  'anbindung', 'schnittstelle', 'verbindung', 'konnektor',
  // en
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'my', 'via', 'using', 'from',
  // de
  'der', 'die', 'das', 'den', 'dem', 'des', 'und', 'oder', 'fur', 'mit', 'von', 'zu', 'zum', 'zur',
  'ein', 'eine', 'einen', 'im', 'mein', 'meine',
  // es / pt / it / fr
  'de', 'del', 'la', 'el', 'los', 'las', 'y', 'para', 'con', 'en', 'un', 'una', 'mi',
  'do', 'da', 'dos', 'das', 'com', 'um', 'uma', 'meu', 'minha', 'no', 'na',
  'di', 'il', 'lo', 'le', 'per', 'e', 'al', 'della', 'dello',
  'du', 'les', 'et', 'pour', 'avec', 'une', 'mon', 'ma',
]);

/** Punctuation that joins or separates parts of a name ("s/4hana", "monday.com", "e-conomic"). */
const PUNCTUATION = /[\s\-_./\\()[\]{}&+,:;'"!?@#*|<>~`^%$=]+/g;

const SCORE = {
  phrase: 120,
  aliasPhrase: 110,
  word: 60,
  aliasWord: 55,
  prefix: 40,
  aliasPrefix: 35,
  text: 10,
} as const;

/** Scores of a match on the slug or name, as opposed to an alias or other text. */
const NAME_SCORES = new Set<number>([SCORE.phrase, SCORE.word, SCORE.prefix]);

function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function compact(value: string): string {
  return fold(value).replace(PUNCTUATION, '');
}

/** The words of a field and their spellings: "S/4HANA" → s/4hana, s4hana, s, 4hana. */
function wordsOf(field: string): string[] {
  const out = new Set<string>();
  // camelCase humps first, on the text as written: "BuchhaltungsButler".
  const humped = field.replace(/([a-z])([A-Z])/g, '$1 $2');
  for (const source of [field, humped]) {
    for (const raw of fold(source).split(/\s+/)) {
      if (!raw) continue;
      const bare = raw.replace(/^[^a-z0-9À-￿]+|[^a-z0-9À-￿]+$/g, '');
      if (bare) out.add(bare);
      const joined = compact(raw);
      if (joined) out.add(joined);
      for (const part of raw.split(PUNCTUATION)) if (part) out.add(part);
    }
  }
  return [...out];
}

/** Text a word may start a word of, with camelCase and letter/digit humps split. */
function haystackOf(fields: readonly string[]): string {
  return fields
    .flatMap((f) => [
      fold(f),
      fold(
        f
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .replace(/([A-Za-z])([0-9])|([0-9])([A-Za-z])/g, '$1$3 $2$4'),
      ),
    ])
    .join(' \n ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Longest query that is matched; the rest is ignored. Queries come from MCP
 * tools and the support chat without a length limit, and every word is
 * compared with the whole catalog.
 */
export const MAX_QUERY_LENGTH = 500;

/** Letters, digits and everything from À up, as UTF-16 code units. */
function isWordChar(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code >= 0xc0;
}

/** Outer punctuation trimmed by index: a regex here was quadratic on long runs. */
function trimPunctuation(word: string): string {
  let start = 0;
  let end = word.length;
  while (start < end && !isWordChar(word.charCodeAt(start))) start++;
  while (end > start && !isWordChar(word.charCodeAt(end - 1))) end--;
  return word.slice(start, end);
}

/** Words of a query, accents dropped, outer punctuation trimmed ("@botfather" → botfather). */
export function queryWords(query: string): string[] {
  return fold(query.slice(0, MAX_QUERY_LENGTH))
    .split(/\s+/)
    .map(trimPunctuation)
    .filter(Boolean);
}

/**
 * The words a query is matched on: stopwords and one-letter words left out,
 * unless nothing would be left.
 */
export function searchTerms(query: string): string[] {
  const words = queryWords(query);
  const content = words.filter((w) => !STOPWORDS.has(w) && w.length > 1);
  if (content.length) return [...new Set(content)];
  const longer = words.filter((w) => w.length > 1);
  return [...new Set(longer.length ? longer : words)];
}

/**
 * Optimal string alignment distance (Damerau-Levenshtein with adjacent
 * transpositions), or max + 1 as soon as it is known to exceed max.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, prev2[j - 2] + 1);
      }
      cur.push(d);
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

/** How far a word may be from a name to still match it: 0 means it may not. */
export function fuzzyAllowance(word: string): number {
  if (word.length < 4 || /^\d+$/.test(word)) return 0;
  return word.length <= 6 ? 1 : 2;
}

interface Prepared<T> {
  entry: T;
  phrases: string[];
  aliasPhrases: string[];
  words: string[];
  aliasWords: string[];
  haystack: string;
  /** First word of the slug and of the name: "whatsapp" for WhatsApp Business. */
  leads: string[];
}

/** Prepared once per entry object: the store searches on every keystroke. */
const preparedEntries = new WeakMap<object, Prepared<CatalogSearchEntry>>();

function prepare<T extends CatalogSearchEntry>(entry: T): Prepared<T> {
  const cached = preparedEntries.get(entry);
  if (cached) return cached as Prepared<T>;
  const p = buildPrepared(entry);
  preparedEntries.set(entry, p);
  return p;
}

function buildPrepared<T extends CatalogSearchEntry>(entry: T): Prepared<T> {
  const aliases = (entry.aliases ?? []).filter((a) => typeof a === 'string' && a.trim());
  const allNameWords = [...wordsOf(entry.slug), ...wordsOf(entry.name)];
  // "Nextcloud (File Search)": "search" alone does not name it ("web search").
  const markers = FILE_SEARCH_SLUGS.has(entry.slug) ? allNameWords.filter((w) => FILE_SEARCH_MARKERS.has(w)) : [];
  const nameWords = new Set(allNameWords.filter((w) => !markers.includes(w)));
  return {
    entry,
    phrases: [compact(entry.slug), compact(entry.name)].filter(Boolean),
    aliasPhrases: aliases.map(compact).filter(Boolean),
    words: [...nameWords],
    aliasWords: [...new Set([...markers, ...aliases.flatMap(wordsOf)])].filter((w) => !nameWords.has(w)),
    haystack: haystackOf(entry.text ?? []),
    leads: [
      ...new Set([compact(entry.slug.split('-')[0] ?? ''), compact(fold(entry.name).trim().split(/\s+/)[0] ?? '')]),
    ].filter(Boolean),
  };
}

/** Score of one query word against one adapter, without fuzziness; 0 = no match. */
function directScore(p: Prepared<CatalogSearchEntry>, term: string): number {
  const joined = compact(term);
  const forms = joined && joined !== term ? [term, joined] : [term];
  if (term.length === 1) {
    // "x": only an adapter that is exactly that letter.
    if (p.phrases.includes(term)) return SCORE.phrase;
    if (p.aliasPhrases.includes(term)) return SCORE.aliasPhrase;
    return 0;
  }
  if (forms.some((f) => p.words.includes(f))) return SCORE.word;
  if (forms.some((f) => p.aliasWords.includes(f))) return SCORE.aliasWord;
  if (forms.some((f) => p.words.some((w) => w.startsWith(f)) || p.phrases.some((w) => w.startsWith(f)))) {
    return SCORE.prefix;
  }
  if (forms.some((f) => p.aliasWords.some((w) => w.startsWith(f)) || p.aliasPhrases.some((w) => w.startsWith(f)))) {
    return SCORE.aliasPrefix;
  }
  if (p.haystack && new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}`).test(p.haystack)) return SCORE.text;
  return 0;
}

/** Smallest edit distance of a word to the slug, name or aliases, or Infinity. */
function fuzzyDistance(p: Prepared<CatalogSearchEntry>, term: string): number {
  const max = fuzzyAllowance(term);
  if (!max) return Infinity;
  let best = Infinity;
  for (const candidate of [...p.words, ...p.aliasWords, ...p.phrases, ...p.aliasPhrases]) {
    if (candidate.length < 3) continue;
    // Typos rarely hit the first letter of a short word; requiring it keeps
    // "gmail" from matching "email".
    if (term.length <= 6 && candidate[0] !== term[0]) continue;
    const d = editDistance(term, candidate, max);
    if (d <= max && d < best) best = d;
  }
  return best;
}

interface Scored<T> {
  entry: T;
  score: number;
  /** Query words matched directly. */
  direct: number;
  /** Query words matched only fuzzily, and their summed distance. */
  fuzzy: number;
  distance: number;
  /** A File Search entry a query about something else met only through an alias. */
  weak?: boolean;
}

function byRank<T extends CatalogSearchEntry>(a: Scored<T>, b: Scored<T>): number {
  return (
    b.score - a.score ||
    (b.entry.priority ?? 0) - (a.entry.priority ?? 0) ||
    a.entry.name.localeCompare(b.entry.name)
  );
}

/**
 * The File Search slugs a query asks for (FILE_SEARCH_INTENTS), best first,
 * and the query words that triggered them. Nothing for a cloud drive query.
 * `generic` when only words about documents in general triggered them.
 */
export function fileSearchIntent(query: string): { slugs: string[]; words: string[]; generic: boolean } {
  const words = queryWords(query).map(compact).filter(Boolean);
  const joined = words.join('');
  if (!words.length || NOT_FILE_SEARCH.some((w) => joined.includes(w))) return { slugs: [], words: [], generic: false };
  const slugs: string[] = [];
  const used = new Set<string>();
  let generic = true;
  // In query order: "synology nas" suggests Synology first.
  for (let i = 0; i < words.length; i++) {
    for (let j = Math.min(words.length, i + 3); j > i; j--) {
      const run = words.slice(i, j).join('');
      const intent = FILE_SEARCH_INTENTS.find((x) => x.triggers.includes(run));
      if (!intent) continue;
      for (const slug of intent.slugs) if (!slugs.includes(slug)) slugs.push(slug);
      for (const w of words.slice(i, j)) used.add(w);
      if (!intent.generic) generic = false;
      break;
    }
  }
  return { slugs, words: [...used], generic: slugs.length > 0 && generic };
}

/**
 * Step 5: the apps a query word names, in the order of the words, ahead of
 * the other results. An app the other words did not match comes in as a
 * partial match. File Search entries, and the words that ask for them
 * ("storage box"), are left to FILE_SEARCH_INTENTS. A first result that
 * matches the query as a whole or by several names ("telegram bot", "google
 * calendar events") stays first.
 */
function namedFirst<T extends CatalogSearchEntry>(
  entries: readonly T[],
  terms: readonly string[],
  hits: CatalogSearchHit<T>[],
  scored: readonly Scored<T>[],
): CatalogSearchHit<T>[] {
  if (hits[0]?.match === 'direct' && hits[0].score >= SCORE.phrase) return hits;
  const named: T[] = [];
  for (const term of terms) {
    const word = compact(term);
    const apps = entries.filter((e) => !FILE_SEARCH_SLUGS.has(e.slug) && prepare(e).leads.includes(word));
    if (!apps.length || apps.length > MAX_NAMED) continue;
    const rank = (e: T) => scored.find((s) => s.entry === e) ?? { entry: e, score: 0, direct: 0, fuzzy: 0, distance: 0 };
    for (const app of apps.sort((a, b) => byRank(rank(a), rank(b)))) if (!named.includes(app)) named.push(app);
  }
  if (!named.length) return hits;
  const front = named.map(
    (entry): CatalogSearchHit<T> =>
      hits.find((h) => h.entry === entry) ?? {
        entry,
        match: 'partial',
        score: scored.find((s) => s.entry === entry)?.score ?? 0,
      },
  );
  const moved = new Set<T>(named);
  return [...front, ...hits.filter((h) => !moved.has(h.entry))];
}

/**
 * Searches the entries. Entries must already be the ones this deployment
 * offers: unlisted and hidden adapters are filtered out by the caller.
 */
export function searchCatalog<T extends CatalogSearchEntry>(
  entries: readonly T[],
  query: string,
): CatalogSearchResult<T> {
  let terms = searchTerms(query);
  if (!terms.length) return { hits: [], terms, missing: [], match: 'none', fileSearch: [] };

  // The whole query as one name: "mercado livre", "amo crm", "telegram bot".
  const wholeQuery = [compact(query), compact(terms.join(''))].filter((q) => q.length > 1);
  const matchedTerms = new Set<string>();
  const scored: Scored<T>[] = [];

  let intent = fileSearchIntent(query);
  if (intent.generic) {
    // "lexware dokumente": the documents are in Lexware, not on a file server.
    const others = terms.filter((t) => !intent.words.includes(compact(t)));
    const namesApp = others.some((t) =>
      entries.some((e) => !FILE_SEARCH_SLUGS.has(e.slug) && directScore(prepare(e), t) >= SCORE.aliasPrefix),
    );
    if (namesApp) {
      // An app and a word about its documents, "excel files", is that app.
      if (others.length === 1) terms = others;
      intent = { slugs: [], words: [], generic: false };
    }
  }

  for (const entry of entries) {
    const p = prepare(entry);
    let score = 0;
    let direct = 0;
    let fuzzy = 0;
    let distance = 0;
    let byAlias = false;
    // Query words matched on the name: a File Search entry is the subject only
    // when every word names it ("web search" names WebDAV by "web" alone).
    const fs = FILE_SEARCH_SLUGS.has(entry.slug);
    let named = 0;
    for (const term of terms) {
      const s = directScore(p, term);
      if (s > 0) {
        score += s;
        direct++;
        matchedTerms.add(term);
        if (NAME_SCORES.has(s)) named++;
        else if (s !== SCORE.text) byAlias = true;
        continue;
      }
      const d = fuzzyDistance(p, term);
      if (d !== Infinity) {
        score += 25 - 5 * d;
        fuzzy++;
        distance += d;
        matchedTerms.add(term);
        named++;
      }
    }
    if (wholeQuery.some((q) => p.phrases.includes(q))) {
      score += SCORE.phrase;
      named = terms.length;
    } else if (wholeQuery.some((q) => p.aliasPhrases.includes(q))) {
      score += SCORE.aliasPhrase;
      byAlias = true;
    }
    if (direct + fuzzy === 0) continue;
    if (fs && !intent.slugs.length && named < terms.length) {
      // "amazon", "excel", "web search": a query about something else.
      // Through an alias ("Amazon S3") or one word of several the entry goes
      // below the apps the query names; through the description alone
      // ("PDF, Excel, Word files") it is left out.
      if (named) byAlias = true;
      if (!byAlias) continue;
      scored.push({ entry, score: Math.min(score, SCORE.text - 1), direct, fuzzy, distance, weak: true });
      continue;
    }
    scored.push({ entry, score, direct, fuzzy, distance });
  }

  const all = terms.length;
  const direct = scored.filter((s) => s.direct === all && !s.weak).sort(byRank);
  // After the fuzzy matches too: "hero" is more likely a typo than QuTS hero.
  const weak = scored.filter((s) => s.direct === all && s.weak).sort(byRank);
  let fuzzy: Scored<T>[] = [];
  if (direct.length < MIN_RESULTS) {
    const room = direct.length ? MIN_RESULTS - direct.length : MAX_FUZZY;
    fuzzy = scored
      .filter((s) => s.fuzzy > 0 && s.direct + s.fuzzy === all)
      .sort((a, b) => a.distance - b.distance || b.direct - a.direct || byRank(a, b))
      .slice(0, room);
  }
  let partial: Scored<T>[] = [];
  if (!direct.length && !fuzzy.length && !weak.length && all > 1) {
    partial = scored
      .sort(
        (a, b) =>
          b.direct + b.fuzzy - (a.direct + a.fuzzy) ||
          Number(!!a.weak) - Number(!!b.weak) ||
          b.direct - a.direct ||
          byRank(a, b),
      )
      .slice(0, MAX_PARTIAL);
  }

  let hits: CatalogSearchHit<T>[] = [
    ...direct.map((s) => ({ entry: s.entry, match: 'direct' as const, score: s.score })),
    ...fuzzy.map((s) => ({ entry: s.entry, match: 'fuzzy' as const, score: s.score })),
    ...weak.map((s) => ({ entry: s.entry, match: 'direct' as const, score: s.score })),
    ...partial.map((s) => ({ entry: s.entry, match: 'partial' as const, score: s.score })),
  ];

  if (terms.length > 1) hits = namedFirst(entries, terms.filter((t) => !intent.words.includes(compact(t))), hits, scored);

  const fileSearch = intent.slugs
    .map((slug) => entries.find((e) => e.slug === slug))
    .filter((e): e is T => !!e)
    .slice(0, MAX_FILE_SEARCH);
  if (fileSearch.length) {
    const picked = new Set<T>(fileSearch);
    const suggestedHits = fileSearch.map(
      (entry): CatalogSearchHit<T> => ({
        ...(hits.find((h) => h.entry === entry) ?? { entry, match: 'suggested' as const, score: 0 }),
        suggested: true,
      }),
    );
    const rest = hits.filter((h) => !picked.has(h.entry));
    // A result named after the query, or matching it as a whole word ("synology",
    // the DSM API; "documents", a DMS), keeps the first place.
    const lead = rest[0] && rest[0] === hits[0] && rest[0].match === 'direct' && rest[0].score >= SCORE.word ? [rest[0]] : [];
    hits = [...lead, ...suggestedHits, ...rest.slice(lead.length)];
    for (const t of terms) if (intent.words.includes(compact(t))) matchedTerms.add(t);
  }

  return {
    hits,
    terms,
    missing: terms.filter((t) => !matchedTerms.has(t)),
    match: hits.length ? hits[0].match : 'none',
    fileSearch,
  };
}
