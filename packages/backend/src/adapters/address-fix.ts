/**
 * Addresses typed into a catalog connector's fields, set right where the
 * field's own pattern says exactly how.
 *
 * WHY. People type what the browser's address bar shows, and it hides the
 * scheme: `acme.odoo.com`. The Odoo address pattern wants `https://…`, so the
 * setup page refused the value with "Only the address up to the host, e.g.
 * https://mycompany.odoo.com", a message that never said the https:// was
 * missing. The same holds for every address pattern that starts with
 * `^https://` or `^https?://` (WooCommerce, PrestaShop, Xentral, GitLab, n8n,
 * Zoho's data-center hosts, …).
 *
 * Two answers, both driven by the pattern alone, so they work for every
 * adapter without a list:
 *  - {@link withMissingScheme}: a bare host the pattern accepts once
 *    `https://` is in front gets it, before the check and before it is
 *    stored (install, verify, chat install, variable editor);
 *  - {@link addressFix}: a value still refused gets the smallest change that
 *    the pattern accepts (cut `/web` after the host, drop a trailing slash),
 *    named in the error instead of only the expected shape.
 *
 * The frontend has the same functions in packages/frontend/src/lib/address-fix.ts:
 * keep the two in step.
 */

/** `https://`, `ftp://`, `postgres://`: the value names its scheme. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * A host name with at least one dot (or a dotted IPv4 address), an optional
 * port and optionally a path. Labels and dots alternate, so the nested
 * quantifier cannot backtrack. A single-label name (`erp:8069`) is not one:
 * whether an internal server speaks http or https cannot be guessed.
 */
const BARE_ADDRESS = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d{1,5})?(?:[/?#]\S*)?$/;

/** The scheme and host (with port), then everything after the host. */
const HOST_AND_REST = /^((?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#]+)(.*)$/i;

function matches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    // A broken pattern never blocks a save, and suggests nothing.
    return true;
  }
}

/**
 * `value` with `https://` in front when it is an address typed without a
 * scheme and the pattern refuses it as typed but accepts it with `https://`.
 * Anything else comes back unchanged: a value wrong in another way (a path
 * after the host) is still refused by the pattern, and a field that wants a
 * bare host (`train.yourgym.com`) keeps it.
 */
export function withMissingScheme(pattern: string | undefined, value: string): string {
  const text = value.trim();
  if (!pattern || HAS_SCHEME.test(text) || !BARE_ADDRESS.test(text)) return value;
  if (matches(pattern, text)) return value;
  const fixed = `https://${text}`;
  return matches(pattern, fixed) ? fixed : value;
}

/**
 * What {@link addressFix} may change, least destructive first: among fixes
 * with as many changes, the first in this order wins, so a trailing slash
 * is dropped before a path that the pattern allows is cut.
 */
export type AddressChange = 'scheme' | 'https' | 'slash' | 'www' | 'path';
const CHANGE_ORDER: AddressChange[] = ['scheme', 'https', 'slash', 'www', 'path'];

export interface AddressFix {
  /** The value the pattern accepts. */
  value: string;
  changes: AddressChange[];
  /** With `path`: what is cut after the host, e.g. `/web`. */
  removed?: string;
}

function applyChanges(text: string, changes: Set<AddressChange>): string {
  let v = text;
  if (changes.has('scheme')) v = `https://${v}`;
  if (changes.has('https')) v = v.replace(/^http:\/\//i, 'https://');
  if (changes.has('path')) v = v.replace(HOST_AND_REST, '$1');
  if (changes.has('slash')) v = v.replace(/\/+$/, '');
  if (changes.has('www')) v = v.replace(/^((?:[a-z][a-z0-9+.-]*:\/\/)?)www\./i, '$1');
  return v;
}

/**
 * The smallest change to an address that the pattern accepts: add https://,
 * use https:// instead of http://, cut what follows the host, drop a trailing
 * slash or a leading www. Undefined when the value already matches or no such
 * change makes it match (the pattern's own message is then all there is to
 * say).
 */
export function addressFix(pattern: string, value: string): AddressFix | undefined {
  const text = value.trim();
  if (!text || /\s/.test(text) || matches(pattern, text)) return undefined;
  const hasScheme = HAS_SCHEME.test(text);
  if (!hasScheme && !BARE_ADDRESS.test(text)) return undefined;
  const rest = HOST_AND_REST.exec(text)?.[2] ?? '';
  const possible = CHANGE_ORDER.filter((c) => {
    switch (c) {
      case 'scheme':
        return !hasScheme;
      case 'https':
        return /^http:\/\//i.test(text);
      case 'path':
        // Something after the host other than a lone trailing slash.
        return /[^/]/.test(rest);
      case 'slash':
        return text.endsWith('/');
      case 'www':
        return /^(?:[a-z][a-z0-9+.-]*:\/\/)?www\./i.test(text);
    }
  });
  // Every combination, fewest changes first: the first one that matches is the fix.
  const subsets: AddressChange[][] = [];
  for (let mask = 1; mask < 1 << possible.length; mask++) {
    subsets.push(possible.filter((_, i) => (mask & (1 << i)) !== 0));
  }
  subsets.sort((a, b) => a.length - b.length);
  for (const changes of subsets) {
    const candidate = applyChanges(text, new Set(changes));
    if (candidate !== text && matches(pattern, candidate)) {
      return { value: candidate, changes, ...(changes.includes('path') ? { removed: rest } : {}) };
    }
  }
  return undefined;
}

function changePhrase(change: AddressChange, removed: string | undefined): string {
  switch (change) {
    case 'scheme':
      return 'add https:// in front';
    case 'https':
      return 'use https:// instead of http://';
    case 'slash':
      return 'remove the / at the end';
    case 'www':
      return 'remove the www.';
    case 'path':
      return `remove ${removed} after the host`;
  }
}

/**
 * {@link addressFix} as one sentence: "Add https:// in front: https://acme.odoo.com.",
 * "Add https:// in front and remove the / at the end: https://shop.example.com."
 */
export function describeAddressFix(fix: AddressFix): string {
  const phrases = fix.changes.map((c) => changePhrase(c, fix.removed));
  const joined = phrases.length > 1 ? `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}` : phrases[0];
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}: ${fix.value}.`;
}
