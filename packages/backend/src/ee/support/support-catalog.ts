import { listAdapters } from '../../adapters/catalog';
import { searchTerms } from '../../adapters/catalog-search';

/** At most this many catalog connectors are named to the triage. */
const MAX_MENTIONS = 6;

export interface CatalogMention {
  slug: string;
  name: string;
}

/**
 * Listed catalog connectors a customer names in their messages: every content
 * word of the connector's name (or of one alias) appears in the text, so
 * "Telegram" finds Telegram Bot and "Google Ads" finds Google Ads, but
 * "Google" alone does not pull in every Google connector. The triage used to
 * see only the workspace's own connectors and answered "we have no Telegram
 * connector" when the catalog has one.
 */
export function catalogMentions(text: string): CatalogMention[] {
  const words = new Set(searchTerms(text));
  if (!words.size) return [];
  const out: CatalogMention[] = [];
  for (const a of listAdapters()) {
    if (a.unlisted) continue;
    const names = [a.name, ...(a.aliases ?? [])];
    const named = names.some((n) => {
      const terms = searchTerms(n).filter((w) => w.length > 2);
      return terms.length > 0 && terms.every((w) => words.has(w));
    });
    if (named) out.push({ slug: a.slug, name: a.name });
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

/** One line for the triage prompt. */
export function catalogMentionsLine(mentions: CatalogMention[]): string {
  if (!mentions.length) return 'Catalog connectors named in the messages: none found.';
  return (
    'Catalog connectors named in the messages (we have them; setup page per connector): ' +
    mentions.map((m) => `${m.name} (/connectors/setup/${m.slug})`).join(', ')
  );
}
