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
 *
 * A one-letter query ("x") matches only an adapter whose slug, name or alias
 * is exactly that letter.
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

/** How a result matched: see the steps above. */
export type CatalogMatchKind = 'direct' | 'fuzzy' | 'partial';

export interface CatalogSearchHit<T> {
  entry: T;
  match: CatalogMatchKind;
  score: number;
}

export interface CatalogSearchResult<T> {
  hits: CatalogSearchHit<T>[];
  /** The query words that were matched against the catalog. */
  terms: string[];
  /** Words no adapter matched in any way: the app the user looked for and we lack. */
  missing: string[];
  /** How the first result matched, or 'none' when nothing did. */
  match: CatalogMatchKind | 'none';
}

/** Fewer direct results than this, and fuzzy matches fill up to it. */
export const MIN_RESULTS = 3;
/** At most this many fuzzy results when there is no direct one. */
export const MAX_FUZZY = 5;
/** At most this many partial results. */
export const MAX_PARTIAL = 10;

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

/** Words of a query, accents dropped, outer punctuation trimmed ("@botfather" → botfather). */
export function queryWords(query: string): string[] {
  return fold(query)
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-z0-9À-￿]+|[^a-z0-9À-￿]+$/g, ''))
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
  const nameWords = new Set([...wordsOf(entry.slug), ...wordsOf(entry.name)]);
  return {
    entry,
    phrases: [compact(entry.slug), compact(entry.name)].filter(Boolean),
    aliasPhrases: aliases.map(compact).filter(Boolean),
    words: [...nameWords],
    aliasWords: [...new Set(aliases.flatMap(wordsOf))].filter((w) => !nameWords.has(w)),
    haystack: haystackOf(entry.text ?? []),
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
}

function byRank<T extends CatalogSearchEntry>(a: Scored<T>, b: Scored<T>): number {
  return (
    b.score - a.score ||
    (b.entry.priority ?? 0) - (a.entry.priority ?? 0) ||
    a.entry.name.localeCompare(b.entry.name)
  );
}

/**
 * Searches the entries. Entries must already be the ones this deployment
 * offers: unlisted and hidden adapters are filtered out by the caller.
 */
export function searchCatalog<T extends CatalogSearchEntry>(
  entries: readonly T[],
  query: string,
): CatalogSearchResult<T> {
  const terms = searchTerms(query);
  if (!terms.length) return { hits: [], terms, missing: [], match: 'none' };

  // The whole query as one name: "mercado livre", "amo crm", "telegram bot".
  const wholeQuery = [compact(query), compact(terms.join(''))].filter((q) => q.length > 1);
  const matchedTerms = new Set<string>();
  const scored: Scored<T>[] = [];

  for (const entry of entries) {
    const p = prepare(entry);
    let score = 0;
    let direct = 0;
    let fuzzy = 0;
    let distance = 0;
    for (const term of terms) {
      const s = directScore(p, term);
      if (s > 0) {
        score += s;
        direct++;
        matchedTerms.add(term);
        continue;
      }
      const d = fuzzyDistance(p, term);
      if (d !== Infinity) {
        score += 25 - 5 * d;
        fuzzy++;
        distance += d;
        matchedTerms.add(term);
      }
    }
    if (wholeQuery.some((q) => p.phrases.includes(q))) score += SCORE.phrase;
    else if (wholeQuery.some((q) => p.aliasPhrases.includes(q))) score += SCORE.aliasPhrase;
    if (direct + fuzzy > 0) scored.push({ entry, score, direct, fuzzy, distance });
  }

  const all = terms.length;
  const direct = scored.filter((s) => s.direct === all).sort(byRank);
  let fuzzy: Scored<T>[] = [];
  if (direct.length < MIN_RESULTS) {
    const room = direct.length ? MIN_RESULTS - direct.length : MAX_FUZZY;
    fuzzy = scored
      .filter((s) => s.fuzzy > 0 && s.direct + s.fuzzy === all)
      .sort((a, b) => a.distance - b.distance || b.direct - a.direct || byRank(a, b))
      .slice(0, room);
  }
  let partial: Scored<T>[] = [];
  if (!direct.length && !fuzzy.length && all > 1) {
    partial = scored
      .sort((a, b) => b.direct + b.fuzzy - (a.direct + a.fuzzy) || b.direct - a.direct || byRank(a, b))
      .slice(0, MAX_PARTIAL);
  }

  const hits: CatalogSearchHit<T>[] = [
    ...direct.map((s) => ({ entry: s.entry, match: 'direct' as const, score: s.score })),
    ...fuzzy.map((s) => ({ entry: s.entry, match: 'fuzzy' as const, score: s.score })),
    ...partial.map((s) => ({ entry: s.entry, match: 'partial' as const, score: s.score })),
  ];
  return {
    hits,
    terms,
    missing: terms.filter((t) => !matchedTerms.has(t)),
    match: hits.length ? hits[0].match : 'none',
  };
}
