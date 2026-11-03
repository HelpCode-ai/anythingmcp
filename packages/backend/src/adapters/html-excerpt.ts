/**
 * A provider that answers a setup check with a web page (a 404 page, a
 * firewall's block page, Odoo's redirect script) used to put the page's raw
 * HTML in the form's error: "<html><body><script>window.location…". These
 * helpers keep the readable words of such a page instead.
 *
 * Plain scans, no regular expression over the page: its size is the
 * provider's choice.
 */

/** True when an answer is an HTML page rather than API data. */
export function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, 300).trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return true;
  return ['<head', '<body', '<title'].some((tag) => {
    const at = head.indexOf(tag);
    return at >= 0 && [' ', '>', '\n', '\t', '\r'].includes(head.charAt(at + tag.length));
  });
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '&') {
      const end = text.indexOf(';', i + 1);
      if (end > i && end - i <= 6) {
        const named = ENTITIES[text.slice(i + 1, end).toLowerCase()];
        if (named !== undefined) {
          out += named;
          i = end + 1;
          continue;
        }
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** Elements whose content is never text a person reads. */
const SKIPPED = ['script', 'style', 'noscript', 'template', 'svg'];

/** The text a person would read on the page: no scripts, styles, comments or tags. */
export function htmlText(html: string): string {
  const lower = html.toLowerCase();
  let out = '';
  let i = 0;
  while (i < html.length) {
    const ch = html.charAt(i);
    if (ch !== '<') {
      out += ch;
      i++;
      continue;
    }
    if (lower.startsWith('<!--', i)) {
      const end = lower.indexOf('-->', i + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const skipped = SKIPPED.find((tag) => {
      if (!lower.startsWith(`<${tag}`, i)) return false;
      const next = lower.charAt(i + tag.length + 1);
      return next === '>' || next === ' ' || next === '\n' || next === '\t' || next === '\r' || next === '/';
    });
    if (skipped) {
      const end = lower.indexOf(`</${skipped}`, i);
      const close = end < 0 ? -1 : lower.indexOf('>', end);
      i = close < 0 ? html.length : close + 1;
      continue;
    }
    const close = html.indexOf('>', i);
    // A tag ends a word: "<td>a</td><td>b</td>" reads "a b".
    out += ' ';
    i = close < 0 ? html.length : close + 1;
  }
  return decodeEntities(out).split(/\s+/).filter(Boolean).join(' ');
}

/**
 * What to show of an HTML answer: its readable words in quotes, at most
 * `max` characters, or a plain statement when the page has none (a page that
 * is only a script).
 */
export function describeHtmlAnswer(html: string, max = 160): string {
  const text = htmlText(html);
  if (!text) return 'the server answered with a web page, not API data';
  const shown = text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
  return `the server answered with a web page: "${shown}"`;
}
