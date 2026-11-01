// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { TYPE_GROUPS } from '../../../file-search/file-search.types';

/**
 * The description of a folder without AI (#1385): built from the scan only.
 * It names what the folder holds (counts, naming patterns of the folders,
 * recurring subfolders, file types, years, language, frequent terms), so the
 * AI client knows when to call this connector even on servers where no LLM is
 * configured.
 */

export interface ScanFacts {
  displayName: string;
  /** Top-level folders with file counts. */
  topFolders: Array<{ name: string; files: number }>;
  /** Second-level folder names per top-level folder. */
  subfolders: Array<{ parent: string; names: string[] }>;
  types: Record<string, { files: number; bytes: number }>;
  totals: { files: number; dirs: number; bytes: number; oldest: string | null; newest: string | null; nameOnly: number };
  samples: Array<{ path: string; excerpt: string }>;
  excludedArchives: string[];
  toolPrefix: string;
}

export interface Description {
  source: 'ai' | 'rules';
  summary: string;
  instructions: string;
  examplePrompts: string[];
  terms: string[];
  language: string | null;
  model?: string;
}

// Function words that are frequent in one language and rare in the others.
// Short, ambiguous tokens (en, de, y, el, se…) are left out on purpose: they
// made German price lists look Spanish.
const STOP: Record<string, string[]> = {
  de: ['und', 'der', 'die', 'das', 'nicht', 'mit', 'für', 'auf', 'ist', 'eine', 'einen', 'wird', 'werden', 'sind', 'oder', 'bei', 'auch', 'nach', 'über', 'zum', 'zur', 'wir', 'ihre', 'unsere', 'vom', 'dem', 'den', 'des', 'innerhalb', 'gültig', 'freundlichen'],
  en: ['the', 'and', 'with', 'for', 'this', 'that', 'from', 'are', 'will', 'have', 'has', 'not', 'our', 'your', 'which', 'within', 'valid', 'please', 'regards'],
  it: ['il', 'gli', 'della', 'delle', 'dello', 'che', 'per', 'non', 'una', 'sono', 'anche', 'come', 'più', 'nel', 'nella', 'alla', 'questo', 'questa', 'essere', 'cordiali', 'saluti'],
  fr: ['les', 'des', 'est', 'pas', 'avec', 'pour', 'sur', 'une', 'dans', 'qui', 'nous', 'vous', 'sont', 'être', 'cette', 'aux', 'cordialement'],
  es: ['los', 'las', 'para', 'por', 'una', 'del', 'que', 'con', 'como', 'más', 'este', 'esta', 'son', 'pero', 'sus', 'saludos', 'atentamente'],
};
const LANG_NAMES: Record<string, string> = { de: 'German', en: 'English', it: 'Italian', fr: 'French', es: 'Spanish' };
const ALL_STOP = new Set(Object.values(STOP).flat());
const GENERIC = new Set(['page', 'seite', 'pagina', 'total', 'gesamt', 'datum', 'date', 'data', 'nummer', 'number', 'numero', 'sheet', 'row', 'attachment', 'subject', 'from', 'sent']);

export function detectLanguage(texts: string[]): string | null {
  const words = texts.join(' ').toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 30) return null;
  const ranked = Object.entries(STOP)
    .map(([l, sw]) => [l, words.filter((w) => sw.includes(w)).length] as const)
    .sort((a, b) => b[1] - a[1]);
  const [best, n] = ranked[0];
  const second = ranked[1]?.[1] ?? 0;
  // A clear winner only: at least 5 hits and half again as many as the next language.
  return n >= 5 && n >= second * 1.5 ? best : null;
}

/** Shape of a name: "Nordtor - 70123" → "<name> - <number>", "2024" → "<year>". */
export function nameShape(name: string): string {
  return name
    .split(/(\s*[-_.,()/]\s*|\s+)/)
    .map((tok) => {
      if (!tok.trim()) return ' ';
      if (/^\s*[-_.,()/]\s*$/.test(tok)) return ` ${tok.trim()} `;
      if (/^(19|20)\d{2}$/.test(tok)) return '<year>';
      if (/^\d+$/.test(tok)) return '<number>';
      if (/^[A-Z]{1,4}\d+[A-Z0-9-]*$/i.test(tok) && /\d/.test(tok)) return '<code>';
      return '<name>';
    })
    .join('')
    .replace(/(<name>\s*)+/g, '<name> ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function dominantPattern(names: string[]): { shape: string; count: number; examples: string[] } | null {
  if (names.length < 5) return null;
  const by = new Map<string, string[]>();
  for (const n of names) {
    const s = nameShape(n);
    by.set(s, [...(by.get(s) ?? []), n]);
  }
  const [shape, list] = [...by.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (shape === '<name>' || list.length / names.length < 0.6) return null;
  return { shape, count: list.length, examples: list.slice(0, 3) };
}

export function frequentTerms(texts: string[], limit = 15): string[] {
  const df = new Map<string, number>();
  const tf = new Map<string, number>();
  for (const t of texts) {
    const seen = new Set<string>();
    for (const raw of t.match(/\p{L}[\p{L}-]{3,}/gu) ?? []) {
      const w = raw.toLowerCase();
      if (ALL_STOP.has(w) || GENERIC.has(w) || w.length > 30) continue;
      tf.set(w, (tf.get(w) ?? 0) + 1);
      if (!seen.has(w)) {
        seen.add(w);
        df.set(w, (df.get(w) ?? 0) + 1);
      }
    }
  }
  const minDf = texts.length >= 4 ? 2 : 1;
  return [...df.entries()]
    .filter(([, d]) => d >= minDf)
    .sort((a, b) => b[1] - a[1] || (tf.get(b[0]) ?? 0) - (tf.get(a[0]) ?? 0))
    .slice(0, limit)
    .map(([w]) => w);
}

export function typeMix(types: ScanFacts['types']): Array<{ label: string; share: number }> {
  const groups = new Map<string, number>();
  let total = 0;
  for (const [ext, v] of Object.entries(types)) {
    const g = TYPE_GROUPS[ext] ?? 'other files';
    groups.set(g, (groups.get(g) ?? 0) + v.files);
    total += v.files;
  }
  if (!total) return [];
  return [...groups.entries()].map(([label, n]) => ({ label, share: n / total })).sort((a, b) => b.share - a.share);
}

function years(t: ScanFacts['totals']): string | null {
  const a = t.oldest?.slice(0, 4);
  const b = t.newest?.slice(0, 4);
  if (!a || !b) return null;
  return a === b ? a : `${a}–${b}`;
}

/** "Alt" (42 folders), "Archiv 2019" — groups excluded folders by their own name. */
export function groupFolders(paths: string[]): string {
  const by = new Map<string, number>();
  for (const p of paths) {
    const name = p.split('/').pop() || p;
    by.set(name, (by.get(name) ?? 0) + 1);
  }
  return [...by.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([n, c]) => (c > 1 ? `"${n}" (${c} folders)` : `"${n}"`))
    .join(', ');
}

export function describeByRules(f: ScanFacts): Description {
  const mix = typeMix(f.types);
  const mainTypes = mix.filter((m) => m.share >= 0.1).slice(0, 3);
  const typesText = mainTypes.length ? mainTypes.map((m) => `${m.label} ${Math.round(m.share * 100)} %`).join(', ') : 'various files';
  const pattern = dominantPattern(f.topFolders.map((t) => t.name));
  const subCounts = new Map<string, number>();
  for (const s of f.subfolders) for (const n of new Set(s.names.map((x) => x.toLowerCase()))) subCounts.set(n, (subCounts.get(n) ?? 0) + 1);
  const recurring = [...subCounts.entries()]
    .filter(([, n]) => f.subfolders.length >= 3 && n / f.subfolders.length >= 0.3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([n]) => f.subfolders.flatMap((s) => s.names).find((x) => x.toLowerCase() === n) ?? n);
  const texts = f.samples.map((s) => s.excerpt);
  const lang = detectLanguage(texts);
  const terms = frequentTerms(texts);
  const yr = years(f.totals);

  const summaryParts = [
    `${f.totals.files.toLocaleString('en')} documents`,
    pattern ? `in ${pattern.count} folders named "${pattern.shape}"` : f.topFolders.length > 1 ? `in ${f.topFolders.length} folders` : null,
    mainTypes.length ? `mostly ${mainTypes.map((m) => m.label).join(' and ')}` : null,
    lang ? LANG_NAMES[lang] : null,
    yr,
  ].filter(Boolean);
  const summary = summaryParts.join(', ').slice(0, 300);

  const lines: string[] = [];
  lines.push(`Contents: "${f.displayName}" holds ${f.totals.files.toLocaleString('en')} documents (${typesText})${yr ? `, changed ${yr}` : ''}.`);
  if (pattern) {
    lines.push(`Folders follow the pattern "${pattern.shape}" (${pattern.count} of ${f.topFolders.length}), e.g. ${pattern.examples.map((e) => `"${e}"`).join(', ')}.`);
  } else if (f.topFolders.length) {
    lines.push(`Top-level folders: ${f.topFolders.slice(0, 12).map((t) => `"${t.name}" (${t.files})`).join(', ')}${f.topFolders.length > 12 ? ', …' : ''}.`);
  }
  if (recurring.length) lines.push(`Most of them contain the subfolders ${recurring.map((r) => `"${r}"`).join(', ')}.`);
  if (lang) lines.push(`Language: ${LANG_NAMES[lang]}. Search in that language.`);
  if (terms.length) lines.push(`Frequent terms: ${terms.join(', ')}.`);
  lines.push('');
  lines.push(`How to search: ${f.toolPrefix}_find for a file or folder name${pattern?.shape.includes('<number>') ? ' (folder names include a number: search by name or by number)' : ''}, ${f.toolPrefix}_grep for exact codes and numbers, ${f.toolPrefix}_search for topics. Read the matching pages with ${f.toolPrefix}_read before answering, and name the file and its date.`);
  const caveats: string[] = [];
  if (f.totals.nameOnly > 0) caveats.push(`${f.totals.nameOnly} files have no readable text (scans, images, other types) and are found by name only.`);
  if (f.excludedArchives.length) caveats.push(`Archive folders are not indexed (${groupFolders(f.excludedArchives)}): older versions are not available here.`);
  caveats.push('When several versions of a document match, use the newest and say which one you used.');
  lines.push(`Caveats: ${caveats.join(' ')}`);

  const ex: string[] = [];
  if (pattern?.examples[0]) ex.push(`What is in the folder "${pattern.examples[0]}", and which document is the newest?`);
  if (terms[0]) ex.push(`Find the documents about "${terms[0]}" and summarise the most recent one.`);
  if (mainTypes.some((m) => m.label === 'Excel')) ex.push('Search the spreadsheets for article number … and show the whole row.');
  ex.push(`Which documents in "${f.displayName}" changed in the last 30 days?`);
  ex.push('Give me the newest PDF in this folder as a download link.');

  return { source: 'rules', summary, instructions: lines.join('\n'), examplePrompts: ex.slice(0, 5), terms, language: lang };
}
