import type { EnvVarDescriptor } from './api';

/**
 * Addresses typed into a catalog connector's setup fields, set right where
 * the field's own pattern says exactly how. Mirrors the backend's
 * packages/backend/src/adapters/address-fix.ts (tested there): keep the two
 * in step.
 *
 * People type what the address bar shows, which hides the scheme
 * (`acme.odoo.com`), and the Odoo address pattern refused it with a message
 * that never said the https:// was missing. Now:
 *  - {@link withMissingScheme}: a bare host the pattern accepts once
 *    `https://` is in front gets it (shown in the field, and sent);
 *  - {@link addressFix}: a value still refused gets the smallest change the
 *    pattern accepts, to tell the user what to change.
 */

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/** A host with a dot (or a dotted IPv4), an optional port and path. */
const BARE_ADDRESS = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d{1,5})?(?:[/?#]\S*)?$/;
const HOST_AND_REST = /^((?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#]+)(.*)$/i;
/** Names that hold an address, as on the backend (env-var-checks.ts). */
const ADDRESS_NAME = /(?:^|_)(?:HOST|HOSTNAME|URL|SERVER|DOMAIN|ENDPOINT|ADDRESS)(?:_|$)/;

function matches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    // A broken pattern never blocks the form, and suggests nothing.
    return true;
  }
}

/** A field that holds an address and is shown back as typed (never a secret). */
export function isPlainAddressField(f: Pick<EnvVarDescriptor, 'name' | 'kind' | 'secret'>): boolean {
  return !f.secret && f.kind !== 'credential' && (f.kind === 'address' || ADDRESS_NAME.test(f.name));
}

/**
 * `value` with `https://` in front when it is an address field typed without
 * a scheme, and the field's pattern refuses it as typed but accepts it with
 * `https://`. Anything else comes back unchanged.
 */
export function withMissingScheme(f: Pick<EnvVarDescriptor, 'name' | 'kind' | 'secret' | 'pattern'>, value: string): string {
  const text = value.trim();
  if (!f.pattern || !isPlainAddressField(f) || HAS_SCHEME.test(text) || !BARE_ADDRESS.test(text)) return value;
  if (matches(f.pattern, text)) return value;
  const fixed = `https://${text}`;
  return matches(f.pattern, fixed) ? fixed : value;
}

/** Least destructive first: among fixes with as many changes, the first in this order wins. */
export type AddressChange = 'scheme' | 'https' | 'slash' | 'www' | 'path';
const CHANGE_ORDER: AddressChange[] = ['scheme', 'https', 'slash', 'www', 'path'];

export interface AddressFix {
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

/** The smallest change to an address that the pattern accepts, or undefined. */
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
      case 'slash':
        return text.endsWith('/');
      case 'www':
        return /^(?:[a-z][a-z0-9+.-]*:\/\/)?www\./i.test(text);
      case 'path':
        return /[^/]/.test(rest);
    }
  });
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

/**
 * The link to set up another catalog connector instead, started with the
 * values already entered (`prefill.<NAME>`, addresses and settings only: the
 * backend never offers a secret here, and the target page never reads a
 * credential from a link), keeping the way back to the chat (`from`) and the
 * draft it replaces (`replaces`, removed once the new one is saved).
 */
export function switchSetupHref(
  slug: string,
  prefill: Record<string, string>,
  opts: { from?: string | null; replaces?: string | null } = {},
): string {
  const q = new URLSearchParams();
  for (const [name, value] of Object.entries(prefill)) {
    if (value && value.trim()) q.set(`prefill.${name}`, value.trim());
  }
  if (opts.from) q.set('from', opts.from);
  if (opts.replaces) q.set('replaces', opts.replaces);
  const query = q.toString();
  return `/connectors/setup/${encodeURIComponent(slug)}${query ? `?${query}` : ''}`;
}
